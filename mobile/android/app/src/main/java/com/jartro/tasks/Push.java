package com.jartro.tasks;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import android.util.Base64;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;

import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Notifications when the Agent needs you or has finished, with the answer typed right in the notification.
 * The page (renderer/js/push.js) hands over what a closed app needs through PushPlugin: a key made from the
 * sync key, and where replies go. A notification arrives sealed with that key (PushService), is opened and
 * drawn here, and a reply is sealed the same way and left on the server for a device with the lists open to
 * put on its task (PushReplyReceiver). AES-256-GCM, {iv, ct} in base64 with the tag at the end of ct, the
 * same as pushSeal / pushOpen in the page.
 * Which Firebase project: res/raw/push_config.json, written by mobile/prepare-www.js. A build without one
 * has no notifications and everything here does nothing.
 */
final class Push {
    private Push() {}

    static final String CHANNEL = "agent_answers";
    static final String REPLY_KEY = "reply";
    static final String ACTION_REPLY = "com.jartro.tasks.PUSH_REPLY";

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences("push", Context.MODE_PRIVATE);
    }

    /** Firebase, from res/raw/push_config.json. False when this build has no Firebase project. */
    static synchronized boolean init(Context ctx) {
        try {
            if (!FirebaseApp.getApps(ctx).isEmpty()) return true;
            int res = ctx.getResources().getIdentifier("push_config", "raw", ctx.getPackageName());
            if (res == 0) return false;
            String s = SyncStore.readAll(ctx.getResources().openRawResource(res)).trim();
            if (s.isEmpty() || s.equals("{}")) return false;
            JSONObject c = new JSONObject(s);
            String project = c.optString("projectId"), app = c.optString("appId"), key = c.optString("apiKey");
            if (project.isEmpty() || app.isEmpty() || key.isEmpty()) return false;
            FirebaseOptions.Builder o = new FirebaseOptions.Builder().setProjectId(project).setApplicationId(app).setApiKey(key);
            if (!c.optString("senderId").isEmpty()) o.setGcmSenderId(c.optString("senderId"));
            FirebaseApp.initializeApp(ctx.getApplicationContext(), o.build());
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /* ── sealing ── */
    private static SecretKeySpec key(Context ctx) {
        String k = prefs(ctx).getString("key", "");
        if (k.isEmpty()) return null;
        byte[] raw = Base64.decode(k, Base64.DEFAULT);
        return raw.length == 32 ? new SecretKeySpec(raw, "AES") : null;
    }
    static JSONObject open(Context ctx, String iv, String ct) {
        try {
            SecretKeySpec k = key(ctx);
            if (k == null || iv == null || ct == null) return null;
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, k, new GCMParameterSpec(128, Base64.decode(iv, Base64.DEFAULT)));
            return new JSONObject(new String(c.doFinal(Base64.decode(ct, Base64.DEFAULT)), "UTF-8"));
        } catch (Exception e) {
            return null; // sealed with another key (the sync key changed): nothing to show
        }
    }
    static JSONObject seal(Context ctx, JSONObject obj) throws Exception {
        SecretKeySpec k = key(ctx);
        if (k == null) throw new IllegalStateException("no key");
        byte[] iv = new byte[12];
        new SecureRandom().nextBytes(iv);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, k, new GCMParameterSpec(128, iv));
        JSONObject env = new JSONObject();
        env.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP));
        env.put("ct", Base64.encodeToString(c.doFinal(obj.toString().getBytes("UTF-8")), Base64.NO_WRAP));
        return env;
    }

    /* ── the notification ── */
    private static int idOf(String taskId) { return 0x50000000 | (taskId.hashCode() & 0x0FFFFFFF); }

    private static void channel(Context ctx, NotificationManager nm) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Agent answers", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("When the Agent needs you or has finished a task");
        nm.createNotificationChannel(ch);
    }

    /** One task's notification: what the Agent says, and (after a reply) what you answered. */
    static void show(Context ctx, String taskId, String title, String note, boolean done, long at, String replied, boolean sent) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        channel(ctx, nm);
        int id = idOf(taskId);
        Person me = new Person.Builder().setName("You").build();
        Person agent = new Person.Builder().setName("Romulus").build();
        String says = note.isEmpty() ? (done ? "Finished." : "The Agent needs something from you.") : note;
        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(me)
                .setConversationTitle(title)
                .addMessage(says, at, agent);
        if (replied != null) style.addMessage(replied, System.currentTimeMillis(), (Person) null);

        Intent open = new Intent(ctx, MainActivity.class)
                .setAction("com.jartro.tasks.PUSH_OPEN." + taskId) // one per task, so each notification opens its own
                .putExtra("hookKind", "open").putExtra("hookArg", taskId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(ctx, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Intent reply = new Intent(ctx, PushReplyReceiver.class).setAction(ACTION_REPLY)
                .putExtra("taskId", taskId).putExtra("title", title).putExtra("note", note)
                .putExtra("done", done).putExtra("at", at);
        // mutable: Android writes the typed words into it
        int mutable = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
        PendingIntent send = PendingIntent.getBroadcast(ctx, id, reply, PendingIntent.FLAG_UPDATE_CURRENT | mutable);
        NotificationCompat.Action act = new NotificationCompat.Action.Builder(R.drawable.ic_stat_agent, "Reply", send)
                .addRemoteInput(new RemoteInput.Builder(REPLY_KEY).setLabel(done ? "Ask for something more" : "Your answer").build())
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                .setShowsUserInterface(false)
                .build();

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_agent)
                .setStyle(style)
                .setContentTitle(title)
                .setContentText(says)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE) // the words stay off a locked screen
                .setContentIntent(tap)
                .setAutoCancel(true)
                .setWhen(at)
                .addAction(act);
        if (replied != null) {
            b.setOnlyAlertOnce(true);
            if (!sent) b.setSubText("Goes out when you open Romulus");
            b.setTimeoutAfter(sent ? 8000 : 20000); // answered: it clears itself
        }
        try { nm.notify(id, b.build()); } catch (SecurityException ignored) {} // notifications are off for the app
    }

    /** Opening the app is seeing them: the Agent's notifications go. */
    static void clearAll(Context ctx) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        try {
            for (StatusBarNotification n : nm.getActiveNotifications()) {
                if ((n.getId() & 0xF0000000) == 0x50000000) nm.cancel(n.getId());
            }
        } catch (Exception ignored) {}
    }

    /* ── a reply ── */
    /** Sealed and left on the server for a device with the lists open. False = it didn't get there. */
    static boolean sendReply(Context ctx, String taskId, String text) {
        try {
            SharedPreferences p = prefs(ctx);
            String url = p.getString("url", ""), apikey = p.getString("apikey", ""), account = p.getString("account", "");
            if (!url.startsWith("https://") || apikey.isEmpty() || account.isEmpty()) return false;
            JSONObject msg = new JSONObject();
            msg.put("id", taskId);
            msg.put("text", text);
            msg.put("at", System.currentTimeMillis());
            JSONObject body = new JSONObject();
            body.put("p_row_key", account);
            body.put("p_env", seal(ctx, msg));
            HttpURLConnection c = (HttpURLConnection) new URL(url + "/rest/v1/rpc/push_reply_put").openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(10000);
            c.setReadTimeout(15000);
            c.setRequestProperty("apikey", apikey);
            c.setRequestProperty("Authorization", "Bearer " + apikey);
            c.setRequestProperty("Content-Type", "application/json");
            c.setDoOutput(true);
            try (OutputStream os = c.getOutputStream()) { os.write(body.toString().getBytes("UTF-8")); }
            try {
                return c.getResponseCode() == 200 && SyncStore.readAll(c.getInputStream()).trim().equals("\"ok\"");
            } finally { c.disconnect(); }
        } catch (Exception e) {
            return false;
        }
    }

    /** A reply that couldn't be sent waits here; the page takes it the next time the app opens. */
    static synchronized void queueReply(Context ctx, String taskId, String text) {
        try {
            JSONArray a = new JSONArray(prefs(ctx).getString("pending", "[]"));
            JSONObject r = new JSONObject();
            r.put("id", taskId);
            r.put("text", text);
            r.put("at", System.currentTimeMillis());
            a.put(r);
            prefs(ctx).edit().putString("pending", a.toString()).apply();
        } catch (Exception ignored) {}
    }
    static synchronized JSONArray takeReplies(Context ctx) {
        try {
            JSONArray a = new JSONArray(prefs(ctx).getString("pending", "[]"));
            if (a.length() > 0) prefs(ctx).edit().remove("pending").apply();
            return a;
        } catch (Exception e) {
            return new JSONArray();
        }
    }
}
