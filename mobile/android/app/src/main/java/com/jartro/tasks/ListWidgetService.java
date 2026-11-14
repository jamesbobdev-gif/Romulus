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

/** Rows + header for the Today, Agent, School and List (Personal / Groceries) widgets. */
public class ListWidgetService extends RemoteViewsService {

    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext(),
                intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID),
                intent.getStringExtra("mode"));
    }

    static final class Row {
        String id, openId, channel, title, sub = "", due = "", thumbUrl; // openId: the task a tap opens, when it isn't id
        int dueColor = SyncStore.COLOR_MUTED;
        boolean checkable;
        long sort;
        Bitmap thumb;
    }

    static final class Factory implements RemoteViewsFactory {
        private static final int MAX_ROWS = 25;
        private static final int COLOR_NEEDS = 0xFF8A5A00;
        private static final java.util.regex.Pattern GROCERY_WORDS =
                java.util.regex.Pattern.compile("\\b(grocer(y|ies)|ebt|food stamps)\\b", java.util.regex.Pattern.CASE_INSENSITIVE);
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
                    // one board: what needs you, then running, queued, just finished, parked
                    SyncStore.Row r = SyncStore.fetch(ctx, "agent");
                    if (r == null) return; // offline: keep what's shown
                    int needs = 0, working = 0, queued = 0, finished = 0;
                    long now = System.currentTimeMillis();
                    final long TIER = 10_000_000_000_000L, LATE = 5_000_000_000_000L; // tiers, then time within a tier
                    for (JSONObject t : open(r.doc, pending)) {
                        String st = t.optString("status", "queued");
                        Row row = base(t, "agent");
                        String who = workerName(t);
                        long updated = t.optLong("updatedAt");
                        if (st.equals("needs-you") && t.optBoolean("parked")) {
                            // parked: James has seen it and set it aside, so it's listed last and not counted
                            row.sub = "Parked";
                            row.due = "parked";
                            row.sort = 4 * TIER + (LATE - updated);
                        } else if (st.equals("needs-you")) {
                            needs++;
                            String note = SyncStore.str(t, "note");
                            row.sub = note == null ? "" : note.replaceAll("\\s+", " ");
                            row.due = "needs you"; row.dueColor = COLOR_NEEDS;
                            row.sort = LATE - updated; // newest first
                            row.thumbUrl = firstImage(t);
                        } else if (st.equals("working")) {
                            working++;
                            long since = t.optLong("claimedAt", updated);
                            row.sub = who + (since > 0 ? " · since " + clock(since) : "");
                            row.due = "working"; row.dueColor = SyncStore.COLOR_ACCENT;
                            row.sort = TIER + (LATE - since);
                        } else if (st.equals("queued")) {
                            queued++;
                            long wait = t.optLong("waitUntil");
                            row.sub = wait > now ? "Held until " + clock(wait) + " (usage limit)"
                                    : t.has("lane") && !t.isNull("lane") ? "Next up for " + who : "Waiting to be routed";
                            row.due = "queued";
                            row.sort = 2 * TIER + updated; // oldest first: that's the order they run
                        } else if (st.equals("done")) {
                            finished++;
                            String note = SyncStore.str(t, "note");
                            row.sub = who + (note == null ? "" : " · " + note.replaceAll("\\s+", " "));
                            row.due = updated > 0 ? "done " + clock(updated) : "done"; row.dueColor = 0xFF2E7D32;
                            row.checkable = true; // clear it off the board
                            row.sort = 3 * TIER + (LATE - updated); // newest first
                        } else continue;
                        fresh.add(row);
                    }
                    List<String> parts = new ArrayList<>();
                    if (needs > 0) parts.add(needs + " need" + (needs == 1 ? "s" : "") + " you");
                    if (working > 0) parts.add(working + " working");
                    if (queued > 0) parts.add(queued + " queued");
                    if (finished > 0) parts.add(finished + " done");
                    header = parts.isEmpty() ? "all clear" : String.join(" · ", parts);
                    headerColor = needs > 0 ? COLOR_NEEDS : working > 0 ? SyncStore.COLOR_ACCENT : SyncStore.COLOR_MUTED;
                } else if (mode.equals("personal")) {
                    // every open personal task: dated ones by when they're due, then the rest in list order
                    SyncStore.Row r = SyncStore.fetch(ctx, "personal");
                    if (r == null) return;
                    int overdue = 0, today = 0, count = 0, i = 0;
                    for (JSONObject t : open(r.doc, pending)) {
                        i++;
                        String ws = SyncStore.str(t, "ws");
                        if (ws != null && !ws.equals("personal")) continue;
                        count++;
                        Row row = base(t, "personal");
                        row.checkable = true;
                        String tag = SyncStore.str(t, "tag");
                        row.sub = tag == null ? "" : tag;
                        String due = SyncStore.str(t, "due");
                        if (due != null) {
                            int diff = SyncStore.daysFromToday(due);
                            if (diff < 0) overdue++; else if (diff == 0) today++;
                            String dueTime = SyncStore.str(t, "dueTime");
                            row.due = SyncStore.dueText(due, dueTime, diff);
                            row.dueColor = diff < 0 ? SyncStore.COLOR_LATE : diff <= 1 ? SyncStore.COLOR_ACCENT : SyncStore.COLOR_MUTED;
                            long when = SyncStore.parseDue(due).getTimeInMillis();
                            if (dueTime != null) try { String[] p = dueTime.split(":"); when += (Integer.parseInt(p[0]) * 60L + Integer.parseInt(p[1])) * 60000L; } catch (Exception ignored) {}
                            row.sort = when;
                        } else row.sort = Long.MAX_VALUE / 2 + i;
                        fresh.add(row);
                    }
                    header = overdue > 0 && today > 0 ? overdue + " overdue · " + today + " today"
                            : overdue > 0 ? overdue + " overdue" : today > 0 ? today + " due today" : count + " open";
                    if (overdue > 0) headerColor = SyncStore.COLOR_LATE;
                } else if (mode.equals("groceries")) {
                    // his usual groceries live on his grocery task in the Agent list (grocery-list.js);
                    // this shows the items on the next order. Tapping one opens that task.
                    SyncStore.Row r = SyncStore.fetch(ctx, "agent");
                    if (r == null) return;
                    JSONObject task = groceryTask(r.doc);
                    if (task == null) {
                        header = "no list yet";
                    } else {
                        JSONArray list = task.optJSONArray("list");
                        long now = System.currentTimeMillis();
                        int out = 0;
                        if (list != null) for (int i = 0; i < list.length(); i++) {
                            Object x = list.opt(i);
                            String name; int every = 1; String last = null; boolean isOut = false;
                            if (x instanceof String) name = ((String) x).trim();
                            else if (x instanceof JSONObject) {
                                JSONObject o = (JSONObject) x;
                                name = o.optString("name", "").trim();
                                every = (int) Math.max(1, Math.min(52, Math.round(o.optDouble("every", 1))));
                                last = SyncStore.str(o, "last");
                                if (last != null && !last.matches("\\d{4}-\\d{2}-\\d{2}")) last = null;
                                isOut = o.optBoolean("out");
                            } else continue;
                            if (name.isEmpty()) continue;
                            boolean dueNext = isOut || last == null;
                            if (!dueNext) {
                                java.util.Calendar next = SyncStore.parseDue(last);
                                next.add(java.util.Calendar.DAY_OF_YEAR, 7 * every - 2); // the app's couple of days' slack
                                dueNext = next.getTimeInMillis() <= now;
                            }
                            if (!dueNext) continue;
                            Row row = new Row();
                            row.id = task.optString("id") + ":" + name.toLowerCase(java.util.Locale.US);
                            row.openId = task.optString("id");
                            row.channel = "agent";
                            row.title = name;
                            row.sub = every == 1 ? "" : "every " + every + " weeks";
                            if (isOut) { out++; row.due = "out"; row.dueColor = SyncStore.COLOR_LATE; }
                            row.sort = (isOut ? 0 : Long.MAX_VALUE / 2) + i;
                            fresh.add(row);
                        }
                        header = fresh.isEmpty() ? "nothing due" : fresh.size() + " for the next order" + (out > 0 ? " · " + out + " out" : "");
                        if (out > 0) headerColor = SyncStore.COLOR_LATE;
                    }
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

        /** His grocery task, as the app finds it (grocery-list.js groceryTask): the newest grocery
         *  task that has a list, done or not (a new one each order), else the newest open one. */
        private static JSONObject groceryTask(JSONObject doc) {
            JSONArray tasks = doc.optJSONArray("tasks");
            if (tasks == null) return null;
            JSONObject withList = null, openOne = null;
            long withListAt = Long.MIN_VALUE, openAt = Long.MIN_VALUE;
            for (int i = 0; i < tasks.length(); i++) {
                JSONObject t = tasks.optJSONObject(i);
                if (t == null) continue;
                JSONArray list = t.optJSONArray("list");
                boolean hasList = list != null && list.length() > 0;
                if (!hasList && !GROCERY_WORDS.matcher(t.optString("title", "")).find()) continue;
                long created = t.optLong("created");
                if (hasList && created >= withListAt) { withList = t; withListAt = created; }
                if (!t.optBoolean("done") && created >= openAt) { openOne = t; openAt = created; }
            }
            return withList != null ? withList : openOne;
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
            String first = imgs != null && imgs.length() > 0 ? imgs.optString(0, null) : null;
            if (first != null && first.startsWith("https://")) return first; // a web picture only, like the options below
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
            v.setOnClickFillInIntent(R.id.row_body, Widgets.fillOpen(r.openId != null ? r.openId : r.id));
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
