package com.jartro.tasks;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.Locale;

public class TasksWidgetService extends RemoteViewsService {

    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        int widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,
                AppWidgetManager.INVALID_APPWIDGET_ID);
        return new TasksFactory(getApplicationContext(), widgetId);
    }

    static class Item {
        String title;
        String due;      // chip text, "" if none
        int dueColor;
        long sortKey;
    }

    static class TasksFactory implements RemoteViewsFactory {
        private static final int COLOR_LATE = 0xFFC03B2B;
        private static final int COLOR_ACCENT = 0xFF2742C8;
        private static final int COLOR_MUTED = 0xFF71716C;
        private static final int MAX_ITEMS = 20;

        private final Context ctx;
        private final int widgetId;
        private List<Item> items = new ArrayList<>();

        TasksFactory(Context ctx, int widgetId) {
            this.ctx = ctx;
            this.widgetId = widgetId;
        }

        @Override
        public void onDataSetChanged() {
            // runs on a binder thread — network is allowed here
            try {
                JSONObject doc = fetchDoc();
                if (doc == null) return; // keep previous list on failure
                List<Item> fresh = new ArrayList<>();
                int overdue = 0, dueToday = 0, open = 0;
                JSONArray tasks = doc.optJSONArray("tasks");
                if (tasks != null) {
                    for (int i = 0; i < tasks.length(); i++) {
                        JSONObject t = tasks.getJSONObject(i);
                        if (t.optBoolean("done")) continue;
                        open++;
                        Item it = new Item();
                        it.title = t.optString("title", "");
                        String due = t.isNull("due") ? null : t.optString("due", null);
                        String dueTime = t.isNull("dueTime") ? null : t.optString("dueTime", null);
                        it.sortKey = sortKey(t, due, dueTime);
                        if (due != null) {
                            int diff = daysFromToday(due);
                            if (diff < 0) overdue++;
                            else if (diff == 0) dueToday++;
                            it.due = chipText(due, dueTime, diff);
                            it.dueColor = diff < 0 ? COLOR_LATE : (diff <= 1 ? COLOR_ACCENT : COLOR_MUTED);
                        } else {
                            it.due = "";
                            it.dueColor = COLOR_MUTED;
                        }
                        fresh.add(it);
                    }
                }
                Collections.sort(fresh, (a, b) -> Long.compare(a.sortKey, b.sortKey));
                if (fresh.size() > MAX_ITEMS) fresh = fresh.subList(0, MAX_ITEMS);
                items = fresh;
                updateHeader(overdue, dueToday, open);
            } catch (Exception e) {
                // keep previous list; widget shows stale-but-real data
            }
        }

        private void updateHeader(int overdue, int dueToday, int open) {
            String counts;
            if (overdue > 0 && dueToday > 0) counts = overdue + " overdue · " + dueToday + " today";
            else if (overdue > 0) counts = overdue + " overdue";
            else if (dueToday > 0) counts = dueToday + " due today";
            else counts = open + " open";
            RemoteViews views = new RemoteViews(ctx.getPackageName(), R.layout.widget_tasks);
            views.setTextViewText(R.id.header_counts, counts);
            views.setTextColor(R.id.header_counts, overdue > 0 ? COLOR_LATE : COLOR_MUTED);
            AppWidgetManager.getInstance(ctx).partiallyUpdateAppWidget(widgetId, views);
        }

        private JSONObject fetchDoc() throws Exception {
            JSONObject cfg = readSyncConfig();
            // through the database function that needs the key (the table itself is closed to the anon key)
            String urlStr = cfg.getString("url").replaceAll("/+$", "") + "/rest/v1/rpc/sync_get";
            HttpURLConnection c = (HttpURLConnection) new URL(urlStr).openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            c.setRequestProperty("apikey", cfg.getString("key"));
            c.setRequestProperty("Authorization", "Bearer " + cfg.getString("key"));
            c.setRequestProperty("Content-Type", "application/json");
            c.setDoOutput(true);
            JSONObject body = new JSONObject();
            body.put("p_sync_key", cfg.getString("syncKey"));
            try (OutputStream os = c.getOutputStream()) { os.write(body.toString().getBytes("UTF-8")); }
            try {
                if (c.getResponseCode() != 200) return null;
                JSONArray rows = new JSONArray(readAll(c.getInputStream()));
                JSONObject doc = rows.length() > 0 ? rows.getJSONObject(0).optJSONObject("doc") : null;
                return doc != null ? doc : new JSONObject();
            } finally {
                c.disconnect();
            }
        }

        private JSONObject readSyncConfig() throws Exception {
            InputStream in = ctx.getResources().openRawResource(R.raw.sync_config);
            return new JSONObject(readAll(in));
        }

        private static String readAll(InputStream in) throws Exception {
            BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
            r.close();
            return sb.toString();
        }

        /* mirrors getSortKey in the app: pin overrides, due(+time) epoch, undated right after today */
        private static long sortKey(JSONObject t, String due, String dueTime) {
            if (!t.isNull("pin") && t.has("pin")) return (long) t.optDouble("pin");
            if (due != null) {
                Calendar cal = parseDue(due);
                if (dueTime != null) {
                    String[] p = dueTime.split(":");
                    cal.set(Calendar.HOUR_OF_DAY, Integer.parseInt(p[0]));
                    cal.set(Calendar.MINUTE, Integer.parseInt(p[1]));
                }
                return cal.getTimeInMillis();
            }
            // undated: right after today's tasks, before tomorrow's (same order as the app);
            // the list sort is stable, so undated ones keep their saved order among themselves
            Calendar tomorrow = Calendar.getInstance();
            tomorrow.set(Calendar.HOUR_OF_DAY, 0); tomorrow.set(Calendar.MINUTE, 0);
            tomorrow.set(Calendar.SECOND, 0); tomorrow.set(Calendar.MILLISECOND, 0);
            tomorrow.add(Calendar.DAY_OF_MONTH, 1);
            return tomorrow.getTimeInMillis() - 1;
        }

        private static Calendar parseDue(String due) {
            String[] p = due.split("-");
            Calendar cal = Calendar.getInstance();
            cal.clear();
            cal.set(Integer.parseInt(p[0]), Integer.parseInt(p[1]) - 1, Integer.parseInt(p[2]));
            return cal;
        }

        private static int daysFromToday(String due) {
            Calendar today = Calendar.getInstance();
            today.set(Calendar.HOUR_OF_DAY, 0);
            today.set(Calendar.MINUTE, 0);
            today.set(Calendar.SECOND, 0);
            today.set(Calendar.MILLISECOND, 0);
            long diff = parseDue(due).getTimeInMillis() - today.getTimeInMillis();
            return Math.round(diff / 86400000f);
        }

        private static String chipText(String due, String dueTime, int diff) {
            String time = "";
            if (dueTime != null) {
                try {
                    String[] p = dueTime.split(":");
                    Calendar cal = Calendar.getInstance();
                    cal.set(Calendar.HOUR_OF_DAY, Integer.parseInt(p[0]));
                    cal.set(Calendar.MINUTE, Integer.parseInt(p[1]));
                    time = " " + new SimpleDateFormat("h:mma", Locale.US)
                            .format(cal.getTime()).toLowerCase(Locale.US);
                } catch (Exception ignored) {}
            }
            if (diff < 0) return "overdue " + (-diff) + "d" + time;
            if (diff == 0) return "today" + time;
            if (diff == 1) return "tomorrow" + time;
            Date d = parseDue(due).getTime();
            if (diff < 7) return new SimpleDateFormat("EEE", Locale.UK).format(d) + time;
            return new SimpleDateFormat("d MMM", Locale.UK).format(d) + time;
        }

        @Override
        public RemoteViews getViewAt(int position) {
            RemoteViews row = new RemoteViews(ctx.getPackageName(), R.layout.widget_task_item);
            if (position < items.size()) {
                Item it = items.get(position);
                row.setTextViewText(R.id.item_title, it.title);
                row.setTextViewText(R.id.item_due, it.due);
                row.setTextColor(R.id.item_due, it.dueColor);
                row.setOnClickFillInIntent(R.id.item_root, new Intent());
            }
            return row;
        }

        @Override public void onCreate() {}
        @Override public void onDestroy() {}
        @Override public int getCount() { return items.size(); }
        @Override public RemoteViews getLoadingView() { return null; }
        @Override public int getViewTypeCount() { return 1; }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean hasStableIds() { return false; }
    }
}
