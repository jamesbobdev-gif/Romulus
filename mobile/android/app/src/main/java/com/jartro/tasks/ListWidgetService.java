package com.jartro.tasks;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Rows + header for the Today, Claude-needs-you and School widgets. */
public class ListWidgetService extends RemoteViewsService {

    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext(),
                intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID),
                intent.getStringExtra("mode"));
    }

    static final class Row {
        String id, channel, title, sub = "", due = "", thumbUrl;
        int dueColor = SyncStore.COLOR_MUTED;
        boolean checkable;
        long sort;
        Bitmap thumb;
    }

    static final class Factory implements RemoteViewsFactory {
        private static final int MAX_ROWS = 25;
        private final Context ctx;
        private final int widgetId;
        private final String mode;
        private List<Row> rows = new ArrayList<>();
        private final Map<String, Bitmap> thumbCache = new HashMap<>();

        Factory(Context ctx, int widgetId, String mode) {
            this.ctx = ctx;
            this.widgetId = widgetId;
            this.mode = mode == null ? "today" : mode;
        }

        @Override
        public void onDataSetChanged() { // binder thread: network is fine here
            try {
                Set<String> pending = SyncStore.pendingDone(ctx);
                List<Row> fresh = new ArrayList<>();
                String header;
                int headerColor = SyncStore.COLOR_MUTED;
                if (mode.equals("agent")) {
                    SyncStore.Row r = SyncStore.fetch(ctx, "agent");
                    if (r == null) return; // offline: keep what's shown
                    int needs = 0, working = 0;
                    for (JSONObject t : open(r.doc, pending)) {
                        String st = t.optString("status", "queued");
                        if (!st.equals("needs-you") && !st.equals("working") && !st.equals("queued")) continue;
                        Row row = base(t, "agent");
                        row.checkable = false;
                        if (st.equals("needs-you") && t.optBoolean("parked")) {
                            // parked: James has seen it and set it aside — listed, but not counted
                            row.sub = "Parked";
                            row.due = "parked";
                            row.sort = Long.MAX_VALUE / 2 - t.optLong("updatedAt");
                        } else if (st.equals("needs-you")) {
                            needs++;
                            String note = SyncStore.str(t, "note");
                            row.sub = note == null ? "" : note.replaceAll("\\s+", " ");
                            row.due = "needs you"; row.dueColor = 0xFF8A5A00;
                            row.sort = -t.optLong("updatedAt");
                        } else {
                            working++;
                            row.sub = st.equals("working") ? "Claude is on it…" : "Waiting for Claude…";
                            row.due = st.equals("working") ? "working" : "waiting";
                            row.sort = Long.MAX_VALUE / 2 - t.optLong("updatedAt"); // after the ones that need you
                        }
                        row.thumbUrl = firstImage(t);
                        fresh.add(row);
                    }
                    header = needs > 0 ? needs + " need" + (needs == 1 ? "s" : "") + " you" : (working > 0 ? working + " in progress" : "all clear");
                    if (needs > 0) headerColor = 0xFF8A5A00;
                } else if (mode.equals("status")) {
                    // what the workers are doing: running → queued → finished (done stays until James checks it off)
                    SyncStore.Row r = SyncStore.fetch(ctx, "agent");
                    if (r == null) return;
                    int working = 0, queued = 0, finished = 0, needs = 0;
                    long now = System.currentTimeMillis();
                    for (JSONObject t : open(r.doc, pending)) {
                        String st = t.optString("status", "queued");
                        if (st.equals("needs-you")) { if (!t.optBoolean("parked")) needs++; continue; } // the other widget lists these
                        Row row = base(t, "agent");
                        String who = workerName(t);
                        long updated = t.optLong("updatedAt");
                        if (st.equals("working")) {
                            working++;
                            long since = t.optLong("claimedAt", updated);
                            row.sub = who + (since > 0 ? " · since " + clock(since) : "");
                            row.due = "working"; row.dueColor = SyncStore.COLOR_ACCENT;
                            row.sort = -since;
                        } else if (st.equals("queued")) {
                            queued++;
                            long wait = t.optLong("waitUntil");
                            row.sub = wait > now ? "Held until " + clock(wait) + " (usage limit)"
                                    : t.has("lane") && !t.isNull("lane") ? "Next up for " + who : "Waiting to be routed";
                            row.due = "queued";
                            row.sort = Long.MAX_VALUE / 4 + updated; // oldest first: that's the order they run
                        } else if (st.equals("done")) {
                            finished++;
                            String note = SyncStore.str(t, "note");
                            row.sub = who + (note == null ? "" : " · " + note.replaceAll("\\s+", " "));
                            row.due = updated > 0 ? "done " + clock(updated) : "done"; row.dueColor = 0xFF2E7D32;
                            row.checkable = true; // clear it off the board
                            row.sort = Long.MAX_VALUE / 2 - updated; // newest first
                        } else continue;
                        fresh.add(row);
                    }
                    List<String> parts = new ArrayList<>();
                    if (working > 0) parts.add(working + " working");
                    if (queued > 0) parts.add(queued + " queued");
                    if (finished > 0) parts.add(finished + " done");
                    if (needs > 0) parts.add(needs + " need" + (needs == 1 ? "s" : "") + " you");
                    header = parts.isEmpty() ? "idle" : String.join(" · ", parts);
                    if (working > 0) headerColor = SyncStore.COLOR_ACCENT;
                } else if (mode.equals("school")) {
                    SyncStore.Row r = SyncStore.fetch(ctx, "school");
                    if (r == null) return;
                    String nextExam = null; int nextExamDays = Integer.MAX_VALUE;
                    for (JSONObject t : open(r.doc, pending)) {
                        String due = SyncStore.str(t, "due");
                        Row row = base(t, "school");
                        row.checkable = true;
                        String tag = SyncStore.str(t, "tag"), kind = t.optString("kind", "regular");
                        row.sub = (tag == null ? "" : tag) + (kind.equals("regular") ? "" : (tag == null ? "" : " · ") + kind);
                        if (due != null) {
                            int diff = SyncStore.daysFromToday(due);
                            row.due = SyncStore.dueText(due, SyncStore.str(t, "dueTime"), diff);
                            row.dueColor = diff < 0 ? SyncStore.COLOR_LATE : diff <= 1 ? SyncStore.COLOR_ACCENT : SyncStore.COLOR_MUTED;
                            row.sort = SyncStore.parseDue(due).getTimeInMillis();
                            if (kind.equals("exam") && diff >= 0 && diff < nextExamDays) { nextExamDays = diff; nextExam = t.optString("title"); }
                        } else row.sort = Long.MAX_VALUE / 4;
                        fresh.add(row);
                    }
                    if (nextExam != null) {
                        String shortName = nextExam.replaceAll("\\s*\\(.*\\)$", "");
                        header = shortName + (nextExamDays == 0 ? " today" : nextExamDays == 1 ? " tomorrow" : " in " + nextExamDays + " days");
                        headerColor = nextExamDays <= 3 ? SyncStore.COLOR_LATE : SyncStore.COLOR_ACCENT;
                    } else header = fresh.size() + " upcoming";
                } else { // today: personal + school, due today or overdue
                    int overdue = 0, today = 0;
                    boolean any = false;
                    for (String ch : new String[]{"personal", "school"}) {
                        SyncStore.Row r = SyncStore.fetch(ctx, ch);
                        if (r == null) continue;
                        any = true;
                        for (JSONObject t : open(r.doc, pending)) {
                            String due = SyncStore.str(t, "due");
                            if (due == null) continue;
                            int diff = SyncStore.daysFromToday(due);
                            if (diff > 0) continue;
                            if (diff < 0) overdue++; else today++;
                            Row row = base(t, ch);
                            row.checkable = true;
                            String dueTime = SyncStore.str(t, "dueTime");
                            row.due = SyncStore.dueText(due, dueTime, diff);
                            row.dueColor = diff < 0 ? SyncStore.COLOR_LATE : SyncStore.COLOR_ACCENT;
                            String tag = SyncStore.str(t, "tag");
                            row.sub = ch.equals("school") ? "school" + (tag == null ? "" : " · " + tag) : (tag == null ? "" : tag);
                            long when = SyncStore.parseDue(due).getTimeInMillis();
                            if (dueTime != null) try { String[] p = dueTime.split(":"); when += (Integer.parseInt(p[0]) * 60L + Integer.parseInt(p[1])) * 60000L; } catch (Exception ignored) {}
                            row.sort = when;
                            fresh.add(row);
                        }
                    }
                    if (!any) return;
                    header = overdue > 0 && today > 0 ? overdue + " overdue · " + today + " today"
                            : overdue > 0 ? overdue + " overdue" : today > 0 ? today + " today" : "all clear";
                    if (overdue > 0) headerColor = SyncStore.COLOR_LATE;
                }
                Collections.sort(fresh, (a, b) -> Long.compare(a.sort, b.sort));
                if (fresh.size() > MAX_ROWS) fresh = new ArrayList<>(fresh.subList(0, MAX_ROWS));
                for (Row row : fresh) row.thumb = row.thumbUrl == null ? null : thumb(row.thumbUrl);
                rows = fresh;
                RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_list);
                v.setTextViewText(R.id.w_counts, header);
                v.setTextColor(R.id.w_counts, headerColor);
                AppWidgetManager.getInstance(ctx).partiallyUpdateAppWidget(widgetId, v);
            } catch (Exception e) {
                // keep the previous rows
            }
        }

        private static List<JSONObject> open(JSONObject doc, Set<String> pending) throws Exception {
            List<JSONObject> out = new ArrayList<>();
            JSONArray tasks = doc.optJSONArray("tasks");
            if (tasks == null) return out;
            for (int i = 0; i < tasks.length(); i++) {
                JSONObject t = tasks.getJSONObject(i);
                if (t.optBoolean("done") || pending.contains(t.optString("id"))) continue;
                out.add(t);
            }
            return out;
        }

        private static Row base(JSONObject t, String channel) {
            Row r = new Row();
            r.id = t.optString("id");
            r.channel = channel;
            r.title = t.optString("title", "");
            return r;
        }

        private static String workerName(JSONObject t) {
            return "local".equals(t.optString("lane")) ? "Lupa Au Palatine" : "Claude";
        }

        /** "2:14pm", or "Tue 2:14pm" when it isn't today. */
        private static String clock(long ms) {
            java.util.Calendar c = java.util.Calendar.getInstance(), now = java.util.Calendar.getInstance();
            c.setTimeInMillis(ms);
            String time = new java.text.SimpleDateFormat("h:mma", java.util.Locale.US).format(c.getTime()).toLowerCase(java.util.Locale.US);
            boolean sameDay = c.get(java.util.Calendar.YEAR) == now.get(java.util.Calendar.YEAR)
                    && c.get(java.util.Calendar.DAY_OF_YEAR) == now.get(java.util.Calendar.DAY_OF_YEAR);
            return sameDay ? time : new java.text.SimpleDateFormat("EEE", java.util.Locale.US).format(c.getTime()) + " " + time;
        }

        private static String firstImage(JSONObject t) {
            JSONArray imgs = t.optJSONArray("replyImages");
            if (imgs != null && imgs.length() > 0) return imgs.optString(0, null);
            JSONArray opts = t.optJSONArray("options");
            if (opts != null) for (int i = 0; i < opts.length(); i++) {
                JSONObject o = opts.optJSONObject(i);
                String img = o == null ? null : SyncStore.str(o, "image");
                if (img != null && img.startsWith("https://")) return img;
            }
            return null;
        }

        private Bitmap thumb(String url) { // small square-ish bitmap, cached for this widget
            if (thumbCache.containsKey(url)) return thumbCache.get(url);
            Bitmap bm = null;
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(8000); c.setReadTimeout(10000);
                c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) TasksWidget");
                try (InputStream in = c.getInputStream()) {
                    byte[] data = readBytes(in, 6 * 1024 * 1024);
                    BitmapFactory.Options o = new BitmapFactory.Options();
                    o.inJustDecodeBounds = true;
                    BitmapFactory.decodeByteArray(data, 0, data.length, o);
                    int s = 1;
                    while (Math.max(o.outWidth, o.outHeight) / (s * 2) >= 160) s *= 2;
                    o = new BitmapFactory.Options();
                    o.inSampleSize = s;
                    bm = BitmapFactory.decodeByteArray(data, 0, data.length, o);
                } finally { c.disconnect(); }
            } catch (Exception ignored) {}
            thumbCache.put(url, bm);
            return bm;
        }

        private static byte[] readBytes(InputStream in, int max) throws Exception {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); if (out.size() > max) throw new Exception("too big"); }
            return out.toByteArray();
        }

        @Override
        public RemoteViews getViewAt(int position) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_row);
            if (position >= rows.size()) return v;
            Row r = rows.get(position);
            v.setTextViewText(R.id.row_title, r.title);
            v.setTextViewText(R.id.row_sub, r.sub);
            v.setViewVisibility(R.id.row_sub, r.sub.isEmpty() ? View.GONE : View.VISIBLE);
            v.setTextViewText(R.id.row_due, r.due);
            v.setTextColor(R.id.row_due, r.dueColor);
            v.setViewVisibility(R.id.row_check, r.checkable ? View.VISIBLE : View.GONE);
            if (r.thumb != null) { v.setImageViewBitmap(R.id.row_thumb, r.thumb); v.setViewVisibility(R.id.row_thumb, View.VISIBLE); }
            else v.setViewVisibility(R.id.row_thumb, View.GONE);
            v.setOnClickFillInIntent(R.id.row_body, Widgets.fillOpen(r.id));
            if (r.checkable) v.setOnClickFillInIntent(R.id.row_check, Widgets.fillDone(r.channel, r.id));
            return v;
        }

        @Override public void onCreate() {}
        @Override public void onDestroy() { thumbCache.clear(); }
        @Override public int getCount() { return rows.size(); }
        @Override public RemoteViews getLoadingView() { return null; }
        @Override public int getViewTypeCount() { return 1; }
        @Override public long getItemId(int position) { return position < rows.size() ? rows.get(position).id.hashCode() : position; }
        @Override public boolean hasStableIds() { return true; }
    }
}
