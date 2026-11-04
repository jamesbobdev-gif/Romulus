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
 * A list the app has encrypted end-to-end (SyncCrypto) is opened here and checked off by the phone itself,
 * since the database can no longer read it.
 */
final class SyncStore {
    private SyncStore() {}

    static final int COLOR_LATE = 0xFFC03B2B;
    static final int COLOR_ACCENT = 0xFF2742C8;
    static final int COLOR_MUTED = 0xFF71716C;
    static final int COLOR_INK = 0xFF161616;

    /** A channel's row, its document opened when the list is end-to-end encrypted. */
    static final class Row {
        JSONObject doc;
        String updatedAt;
        boolean v2;
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

    /* End-to-end encrypted lists (SyncCrypto, the app's renderer/js/sync-crypto.js): the database knows such a
       list only by a lookup id and holds a sealed document. A baked config can say so ("v2": true); otherwise
       the first read under the plain key meets the {"moved":"v2"} marker the app left there, and from then on
       this channel is read under its lookup id (remembered in the widget's preferences). */
    static boolean isV2(Context ctx, String channel, JSONObject cfg) {
        return cfg.optBoolean("v2", false) || prefs(ctx).getBoolean("v2:" + channel, false);
    }
    private static void rememberV2(Context ctx, String channel) {
        prefs(ctx).edit().putBoolean("v2:" + channel, true).apply();
    }

    static Row fetch(Context ctx, String channel) throws Exception {
        JSONObject cfg = config(ctx, channel);
        if (cfg == null) return null;
        boolean v2 = isV2(ctx, channel, cfg);
        Row r = fetchRaw(cfg, v2 ? SyncCrypto.rowKey(cfg.getString("syncKey")) : cfg.getString("syncKey"));
        if (r == null) return null;
        if (!v2 && "v2".equals(r.doc.optString("moved"))) { // the app moved this list: follow it
            rememberV2(ctx, channel);
            r = fetchRaw(cfg, SyncCrypto.rowKey(cfg.getString("syncKey")));
            if (r == null) return null;
            v2 = true;
        }
        if (v2 && r.updatedAt != null) {
            // a plain row where a sealed one should be is not this list: show nothing rather than something else's
            if (!SyncCrypto.isSealed(r.doc)) return null;
            r.doc = SyncCrypto.open(cfg.getString("syncKey"), r.doc);
        }
        r.v2 = v2;
        return r;
    }

    // one row as the database holds it (sealed or not), through the function that needs the key (the table
    // itself is closed to the anon key); null = no answer, an empty doc with no updatedAt = no such row
    private static Row fetchRaw(JSONObject cfg, String rowKey) throws Exception {
        HttpURLConnection c = open(cfg, base(cfg) + "/rest/v1/rpc/sync_get", "POST");
        c.setDoOutput(true);
        JSONObject body = new JSONObject();
        body.put("p_sync_key", rowKey);
        try (OutputStream os = c.getOutputStream()) { os.write(body.toString().getBytes("UTF-8")); }
        try {
            if (c.getResponseCode() != 200) return null;
            JSONArray rows = new JSONArray(readAll(c.getInputStream()));
            Row r = new Row();
            if (rows.length() == 0) { r.doc = new JSONObject(); return r; }
            r.doc = rows.getJSONObject(0).optJSONObject("doc");
            if (r.doc == null) r.doc = new JSONObject();
            r.updatedAt = rows.getJSONObject(0).isNull("updated_at") ? null : rows.getJSONObject(0).getString("updated_at");
            return r;
        } finally { c.disconnect(); }
    }

    /** Mark one task done (agent tasks also get status "done"). A plain list: one atomic update in the database
     *  (widget_complete_task). An encrypted one the database can't edit: the phone opens the list, stamps the task
     *  and writes it back only if nobody wrote in between (sync_put's p_prev), trying again a few times if someone did. */
    static boolean complete(Context ctx, String channel, String taskId) {
        try {
            JSONObject cfg = config(ctx, channel);
            if (cfg == null) return false;
            if (isV2(ctx, channel, cfg)) return completeSealed(cfg, channel, taskId);
            JSONObject body = new JSONObject();
            body.put("p_sync_key", cfg.getString("syncKey"));
            body.put("p_task_id", taskId);
            return rpcTrue(cfg, "widget_complete_task", body);
        } catch (Exception e) {
            return false;
        }
    }
    private static boolean completeSealed(JSONObject cfg, String channel, String taskId) throws Exception {
        String syncKey = cfg.getString("syncKey"), rowKey = SyncCrypto.rowKey(syncKey);
        for (int attempt = 0; attempt < 4; attempt++) {
            Row r = fetchRaw(cfg, rowKey);
            if (r == null || r.updatedAt == null || !SyncCrypto.isSealed(r.doc)) return false;
            JSONObject doc = SyncCrypto.open(syncKey, r.doc);
            JSONArray tasks = doc.optJSONArray("tasks");
            if (tasks == null) return false;
            boolean found = false;
            for (int i = 0; i < tasks.length(); i++) {
                JSONObject t = tasks.getJSONObject(i);
                if (!taskId.equals(t.optString("id"))) continue;
                t.put("done", true);
                t.put("updatedAt", System.currentTimeMillis());
                if ("agent".equals(channel)) t.put("status", "done");
                found = true;
            }
            if (!found) return false;
            JSONObject body = new JSONObject();
            body.put("p_sync_key", rowKey);
            body.put("p_doc", SyncCrypto.seal(syncKey, doc));
            body.put("p_prev", r.updatedAt);
            if (rpcTrue(cfg, "sync_put", body)) return true; // false: the list changed meanwhile, read it again
        }
        return false;
    }
    private static boolean rpcTrue(JSONObject cfg, String fn, JSONObject body) throws Exception {
        HttpURLConnection c = open(cfg, base(cfg) + "/rest/v1/rpc/" + fn, "POST");
        c.setDoOutput(true);
        try (OutputStream os = c.getOutputStream()) { os.write(body.toString().getBytes("UTF-8")); }
        try {
            return c.getResponseCode() == 200 && readAll(c.getInputStream()).trim().equals("true");
        } finally { c.disconnect(); }
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
        String u = cfg.getString("url").trim().replaceAll("/+$", "");
        // the anon key and the sync key go in the headers: never over plain http, whatever the saved address says
        if (!u.toLowerCase().startsWith("https://")) throw new Exception("sync url must be https");
        return u;
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
