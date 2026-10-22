package com.jartro.tasks;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import org.json.JSONArray;
import org.json.JSONObject;
import org.vosk.LibVosk;
import org.vosk.LogLevel;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.RecognitionListener;
import org.vosk.android.SpeechService;

import java.io.File;

/**
 * "Hey Romulus": listens for the wake word with Vosk (offline, on the phone; nothing leaves it), then
 * opens the app, which takes the actual command with the normal Speak button's recognizer
 * ("hookKind" = "wake" → window.__tasksHook in the page). Only while the screen is on: the app can't
 * show itself over the lock screen anyway, and it saves battery. The mic is let go while the app's own
 * Speak is listening (hold()), so the two never fight over it.
 */
public class WakeWordService extends Service {
    static final String PREFS = "wakeword";
    static final String ACTION_STOP = "com.jartro.tasks.WAKE_STOP";
    private static final String TAG = "WakeWord";
    private static final String CH_ON = "wake_on", CH_HEARD = "wake_heard";
    private static final int ID_ON = 4101, ID_HEARD = 4102;
    /* the grammar: only these can be "heard", so ordinary talk comes out as [unk]. The sound-alikes are decoys:
       with nothing but "hey romulus" to choose from, near-misses ("hey, Rome is…", "romance") were squeezed into
       it; now they land on a decoy and only the real thing scores high (2026-10-18: it woke up too often) */
    private static final String GRAMMAR = "[\"hey romulus\", \"romulus\", \"hey\", \"hey there\", \"hey you\", \"hey google\", "
            + "\"hey siri\", \"hello\", \"hi\", \"okay\", \"yeah\", \"romeo\", \"remus\", \"rome\", \"ramos\", \"romance\", "
            + "\"room\", \"remove\", \"remember\", \"ridiculous\", \"famous\", \"hey ramon\", \"hey rosa\", "
            + "\"run\", \"run to\", \"rumor\", \"roman\", \"remote\", \"rory\", \"rummage\", \"[unk]\"]";
    private static final double MIN_CONF = 0.90;   // Vosk's confidence for each word (with a grammar it's nearly always 1: the decoys do most of the work)
    private static final double MIN_ROMULUS_S = 0.40; // "romulus" takes at least ~0.45 s to say; look-alikes ("run to the") were shorter
    private static final long HOLD_MAX_MS = 30_000; // the page should hand the mic back long before this

    private static WakeWordService running;

    private final Handler main = new Handler(Looper.getMainLooper());
    private Model model;
    private SpeechService speech;
    private Recognizer recognizer;
    private boolean screenOn = true, held = false, loading = false;
    private final Runnable unhold = () -> { held = false; update(); };

    private final BroadcastReceiver screen = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            screenOn = Intent.ACTION_SCREEN_ON.equals(i.getAction());
            update();
        }
    };

    // ---- for the rest of the app ----

    static File modelDir(Context c) { return new File(c.getFilesDir(), "vosk-model"); }
    static boolean modelReady(Context c) { return new File(modelDir(c), "conf/model.conf").exists(); }
    static boolean wanted(Context c) { return c.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean("on", false); }
    static void setWanted(Context c, boolean on) { c.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("on", on).apply(); }
    static boolean isRunning() { return running != null; }

    /** Start listening if it's switched on (called when the app opens: a mic service must start from the foreground). */
    static void startIfWanted(Context c) {
        if (!wanted(c) || !modelReady(c) || running != null) return;
        if (c.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) return;
        try {
            Intent i = new Intent(c, WakeWordService.class);
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i); else c.startService(i);
        } catch (Exception e) { Log.w(TAG, "couldn't start: " + e); }
    }

    static void stop(Context c) { c.stopService(new Intent(c, WakeWordService.class)); }

    /** true: let go of the mic (the app's Speak is about to listen); false: take it back. */
    static void hold(boolean on) {
        WakeWordService s = running;
        if (s == null) return;
        s.main.post(() -> {
            s.main.removeCallbacks(s.unhold);
            if (on) { s.held = true; s.update(); s.main.postDelayed(s.unhold, HOLD_MAX_MS); }
            else s.main.postDelayed(s.unhold, 400); // give the other recognizer a moment to release it
        });
    }

    // ---- service ----

    @Override
    public void onCreate() {
        super.onCreate();
        running = this;
        channels();
        int type = Build.VERSION.SDK_INT >= 30 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0;
        ServiceCompat.startForeground(this, ID_ON, listeningNote(), type);
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        screenOn = pm == null || pm.isInteractive();
        IntentFilter f = new IntentFilter(Intent.ACTION_SCREEN_ON);
        f.addAction(Intent.ACTION_SCREEN_OFF);
        registerReceiver(screen, f);
        loadModel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) { // "Turn off" in the notification
            setWanted(this, false);
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_NOT_STICKY; // after a kill, it comes back the next time the app opens
    }

    @Override
    public void onDestroy() {
        running = null;
        main.removeCallbacksAndMessages(null);
        try { unregisterReceiver(screen); } catch (Exception ignored) {}
        micOff();
        if (model != null) { model.close(); model = null; }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private void loadModel() {
        if (loading || model != null) return;
        loading = true;
        LibVosk.setLogLevel(LogLevel.WARNINGS);
        new Thread(() -> {
            Model m = null;
            try { m = new Model(modelDir(this).getAbsolutePath()); }
            catch (Exception e) { Log.w(TAG, "model didn't load: " + e); }
            Model loaded = m;
            main.post(() -> {
                loading = false;
                if (running != this) { if (loaded != null) loaded.close(); return; }
                if (loaded == null) { stopSelf(); return; }
                model = loaded;
                update();
            });
        }, "wake-model").start();
    }

    /** Mic on exactly when: the model's loaded, the screen's on, and the app's Speak isn't using it. */
    private void update() {
        boolean listen = model != null && screenOn && !held;
        if (listen && speech == null) micOn();
        else if (!listen && speech != null) micOff();
    }

    private void micOn() {
        try {
            recognizer = new Recognizer(model, 16000f, GRAMMAR);
            recognizer.setWords(true); // each word with its confidence and timing, in final results
            speech = new SpeechService(recognizer, 16000f);
            speech.startListening(new RecognitionListener() {
                // finished phrases only: the in-progress guesses (partials) jump around and set it off by mistake
                @Override public void onPartialResult(String json) {}
                @Override public void onResult(String json) { check(json); }
                @Override public void onFinalResult(String json) {}
                @Override public void onError(Exception e) { Log.w(TAG, "mic: " + e); micOff(); main.postDelayed(WakeWordService.this::update, 5000); }
                @Override public void onTimeout() {}
            });
        } catch (Exception e) {
            Log.w(TAG, "couldn't listen: " + e);
            micOff();
        }
    }

    private void micOff() {
        if (speech != null) { try { speech.stop(); speech.shutdown(); } catch (Exception ignored) {} speech = null; }
        if (recognizer != null) { try { recognizer.close(); } catch (Exception ignored) {} recognizer = null; }
    }

    /* "hey" then "romulus", next to each other anywhere in the phrase (sounds around it come out as [unk]),
       each said clearly enough (confidence) and "romulus" long enough to be the word, not a blip */
    private void check(String json) {
        JSONArray words;
        try { words = new JSONObject(json).optJSONArray("result"); } catch (Exception e) { return; }
        if (words == null) return;
        for (int i = 0; i + 1 < words.length(); i++) {
            JSONObject a = words.optJSONObject(i), b = words.optJSONObject(i + 1);
            if (a == null || b == null || !"hey".equals(a.optString("word")) || !"romulus".equals(b.optString("word"))) continue;
            double ca = a.optDouble("conf", 0), cb = b.optDouble("conf", 0), len = b.optDouble("end", 0) - b.optDouble("start", 0);
            if (ca >= MIN_CONF && cb >= MIN_CONF && len >= MIN_ROMULUS_S) { main.post(this::heard); return; }
            Log.d(TAG, "not sure enough: hey " + ca + ", romulus " + cb + ", " + len + " s");
        }
    }

    private void heard() {
        if (held) return;
        held = true;
        update(); // let go of the mic before the app's recognizer wants it
        main.removeCallbacks(unhold);
        main.postDelayed(unhold, HOLD_MAX_MS);
        chime();
        Intent open = new Intent(this, MainActivity.class)
                .setAction("com.jartro.tasks.WAKE")
                .putExtra("hookKind", "wake")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        // Android only lets an app jump in front from the background with "Display over other apps";
        // without it, a notification you tap does the same
        if (MainActivity.visible || (Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this))) {
            try { startActivity(open); return; } catch (Exception e) { Log.w(TAG, "couldn't open: " + e); }
        }
        PendingIntent pi = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(this, CH_HEARD)
                .setSmallIcon(R.drawable.ic_stat_mic)
                .setContentTitle("Hey! Tap to talk to Romulus")
                .setContentText("Allow “Display over other apps” in Settings to skip this tap")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setTimeoutAfter(15_000)
                .build();
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(ID_HEARD, n);
        // nothing will use the mic until that's tapped (and then the app holds it again)
        main.removeCallbacks(unhold);
        main.postDelayed(unhold, 3000);
    }

    private void chime() {
        try {
            ToneGenerator tg = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 70);
            tg.startTone(ToneGenerator.TONE_PROP_ACK, 160);
            main.postDelayed(tg::release, 400);
        } catch (Exception ignored) {}
    }

    private Notification listeningNote() {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent off = PendingIntent.getService(this, 2, new Intent(this, WakeWordService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CH_ON)
                .setSmallIcon(R.drawable.ic_stat_mic)
                .setContentTitle("Listening for “Hey Romulus”")
                .setContentText("Only while the screen is on · stays on this phone")
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setOngoing(true)
                .setShowWhen(false)
                .setContentIntent(open)
                .addAction(0, "Turn off", off)
                .build();
    }

    private void channels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel on = new NotificationChannel(CH_ON, "Hey Romulus (listening)", NotificationManager.IMPORTANCE_MIN);
        on.setShowBadge(false);
        nm.createNotificationChannel(on);
        NotificationChannel heard = new NotificationChannel(CH_HEARD, "Hey Romulus (heard you)", NotificationManager.IMPORTANCE_HIGH);
        heard.setSound(null, null);
        nm.createNotificationChannel(heard);
    }
}
