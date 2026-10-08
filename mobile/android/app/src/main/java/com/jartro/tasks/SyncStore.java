package com.jartro.tasks;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Shared by the home-screen widgets: reads the sync channels (personal / agent / school) from the
 * same Supabase rows the app uses, and checks a task off through the widget_complete_task database
 * function (one atomic update, so it can't clobber an edit made on another device at the same time).
 */
final class SyncStore {
    private SyncStore() {}

    static final int COLOR_LATE = 0xFFC03B2B;
    static final int COLOR_ACCENT = 0xFF2742C8;
    static final int COLOR_MUTED = 0xFF71716C;
    static final int COLOR_INK = 0xFF161616;

    /** A channel's row. */
    static final class Row {
        JSONObject doc;
        String updatedAt;
    }

    static JSONObject config(Context ctx, String channel) {
        int res;
        switch (channel) {
            case "agent": res = R.raw.agent_sync_config; break;
            case "school": res = R.raw.school_sync_config; break;
            default: res = R.raw.sync_config;
        }
        try {
            String s = readAll(ctx.getResources().openRawResource(res)).trim();
            return s.isEmpty() || s.equals("{}") ? null : new JSONObject(s);
        } catch (Exception e) {
            return null;
        }
    }

    static Row fetch(Context ctx, String channel) throws Exception {
        JSONObject cfg = config(ctx, channel);
        if (cfg == null) return null;
        String url = base(cfg) + "/rest/v1/tasks_sync?sync_key=eq."
                + URLEncoder.encode(cfg.getString("syncKey"), "UTF-8") + "&select=doc,updated_at";
        HttpURLConnection c = open(cfg, url, "GET");
        try {
            if (c.getResponseCode() != 200) return null;
            JSONArray rows = new JSONArray(readAll(c.getInputStream()));
            Row r = new Row();
            if (rows.length() == 0) { r.doc = new JSONObject(); return r; }
            r.doc = rows.getJSONObject(0).optJSONObject("doc");
            if (r.doc == null) r.doc = new JSONObject();
            r.updatedAt = rows.getJSONObject(0).optString("updated_at", null);
            return r;
        } finally { c.disconnect(); }
    }

    /** Mark one task done (agent tasks also get status "done") — one atomic update in the database. */
    static boolean complete(Context ctx, String channel, String taskId) {
        try {
            JSONObject cfg = config(ctx, channel);
            if (cfg == null) return false;
            JSONObject body = new JSONObject();
            body.put("p_sync_key", cfg.getString("syncKey"));
            body.put("p_task_id", taskId);
            HttpURLConnection c = open(cfg, base(cfg) + "/rest/v1/rpc/widget_complete_task", "POST");
            c.setDoOutput(true);
            try (OutputStream os = c.getOutputStream()) { os.write(body.toString().getBytes("UTF-8")); }
            try {
                return c.getResponseCode() == 200 && readAll(c.getInputStream()).trim().equals("true");
            } finally { c.disconnect(); }
        } catch (Exception e) {
            return false;
        }
    }

    /* ── checked-off-but-not-yet-confirmed ids, so the widget hides them right away ── */
    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences("widget_state", Context.MODE_PRIVATE);
    }
    static Set<String> pendingDone(Context ctx) {
        return new HashSet<>(prefs(ctx).getStringSet("pendingDone", new HashSet<>()));
    }
    static void setPending(Context ctx, String id, boolean on) {
        Set<String> s = pendingDone(ctx);
        if (on) s.add(id); else s.remove(id);
        prefs(ctx).edit().putStringSet("pendingDone", s).apply();
    }

    /* ── helpers ── */
    private static String base(JSONObject cfg) throws Exception {
        return cfg.getString("url").replaceAll("/+$", "");
    }
    private static HttpURLConnection open(JSONObject cfg, String url, String method) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        c.setRequestProperty("apikey", cfg.getString("key"));
        c.setRequestProperty("Authorization", "Bearer " + cfg.getString("key"));
        c.setRequestProperty("Content-Type", "application/json");
        return c;
    }
    static String readAll(InputStream in) throws Exception {
        BufferedReader r = new BufferedReader(new InputStreamReader(in, "UTF-8"));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = r.readLine()) != null) sb.append(line).append('\n');
        r.close();
        return sb.toString();
    }
    private static String isoNow() {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        f.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return f.format(new Date());
    }

    static Calendar parseDue(String due) {
        String[] p = due.split("-");
        Calendar cal = Calendar.getInstance();
        cal.clear();
        cal.set(Integer.parseInt(p[0]), Integer.parseInt(p[1]) - 1, Integer.parseInt(p[2]));
        return cal;
    }
    static int daysFromToday(String due) {
        Calendar today = Calendar.getInstance();
        today.set(Calendar.HOUR_OF_DAY, 0); today.set(Calendar.MINUTE, 0);
        today.set(Calendar.SECOND, 0); today.set(Calendar.MILLISECOND, 0);
        return Math.round((parseDue(due).getTimeInMillis() - today.getTimeInMillis()) / 86400000f);
    }
    static String str(JSONObject t, String k) {
        return t.isNull(k) ? null : t.optString(k, null);
    }
    static String dueText(String due, String dueTime, int diff) {
        String time = "";
        if (dueTime != null) {
            try {
                String[] p = dueTime.split(":");
                Calendar cal = Calendar.getInstance();
                cal.set(Calendar.HOUR_OF_DAY, Integer.parseInt(p[0]));
                cal.set(Calendar.MINUTE, Integer.parseInt(p[1]));
                time = " " + new SimpleDateFormat("h:mma", Locale.US).format(cal.getTime()).toLowerCase(Locale.US);
            } catch (Exception ignored) {}
        }
        if (diff < 0) return "overdue " + (-diff) + "d" + time;
        if (diff == 0) return "today" + time;
        if (diff == 1) return "tomorrow" + time;
        Date d = parseDue(due).getTime();
        if (diff < 7) return new SimpleDateFormat("EEE", Locale.US).format(d) + time;
        return new SimpleDateFormat("MMM d", Locale.US).format(d) + time;
    }
}
