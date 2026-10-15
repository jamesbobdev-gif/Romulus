package com.jartro.tasks;

import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;

public class MainActivity extends BridgeActivity {
    private final Handler main = new Handler(Looper.getMainLooper());
    static volatile boolean visible = false; // "Hey Romulus" can always bring the app forward while it's showing

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoicePlugin.class); // talk to add a task (must be registered before super.onCreate)
        registerPlugin(ShareLinkPlugin.class); // send an option's link to people
        registerPlugin(WakeWordPlugin.class); // "Hey Romulus"
        registerPlugin(CalAccountsPlugin.class); // Google / Microsoft calendar sign-in
        super.onCreate(savedInstanceState);
        handle(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handle(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        visible = true;
        WakeWordService.startIfWanted(this); // a mic service has to be started from the foreground
        // opening the app is the freshest moment we have — redraw the widgets
        Widgets.refreshAll(this);
    }

    @Override
    public void onPause() {
        super.onPause();
        visible = false;
        // leaving the app usually follows an edit — refresh so the widgets show it
        Widgets.refreshAll(this);
    }

    /** Widget buttons and Android's Share menu → a call to window.__tasksHook in the page. */
    private void handle(Intent intent) {
        if (intent == null) return;
        try {
            JSONObject p = new JSONObject();
            String action = intent.getAction();
            if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
                p.put("kind", "share");
                String text = intent.getStringExtra(Intent.EXTRA_TEXT);
                String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
                if (text != null) p.put("text", text);
                if (subject != null) p.put("subject", subject);
                ArrayList<Uri> uris = new ArrayList<>();
                if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
                    ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                    if (list != null) uris.addAll(list);
                } else {
                    Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                    if (u != null) uris.add(u);
                }
                JSONArray images = new JSONArray();
                for (Uri u : uris) {
                    if (images.length() >= 6) break;
                    String data = jpegDataUrl(u);
                    if (data != null) images.put(data);
                }
                if (images.length() > 0) p.put("images", images);
                // handled once: a rotate/relaunch mustn't share it twice
                intent.setAction(Intent.ACTION_MAIN);
                intent.removeExtra(Intent.EXTRA_STREAM);
            } else if (intent.hasExtra("hookKind")) {
                p.put("kind", intent.getStringExtra("hookKind"));
                if (intent.hasExtra("hookArg")) p.put("arg", intent.getStringExtra("hookArg"));
                intent.removeExtra("hookKind");
            } else return;
            deliver(p.toString(), 0);
        } catch (Exception ignored) {}
    }

    /** The page loads asynchronously: retry until its hook exists (up to ~15 s). */
    private void deliver(String json, int attempt) {
        if (attempt > 60) return;
        WebView wv = getBridge() == null ? null : getBridge().getWebView();
        if (wv == null) { main.postDelayed(() -> deliver(json, attempt + 1), 250); return; }
        wv.evaluateJavascript("typeof window.__tasksHook==='function'", ready -> {
            if (!"true".equals(ready)) { main.postDelayed(() -> deliver(json, attempt + 1), 250); return; }
            wv.evaluateJavascript("window.__tasksHook(" + json + ")", focused -> {
                if ("\"keyboard\"".equals(focused)) { // the page focused a text box: show the keyboard
                    wv.requestFocus();
                    InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                    if (imm != null) imm.showSoftInput(wv, InputMethodManager.SHOW_IMPLICIT);
                }
            });
        });
    }

    /** A shared image, shrunk to ≤1600px JPEG, as a data: URL (the page uploads it like a pasted photo). */
    private String jpegDataUrl(Uri uri) {
        try {
            byte[] raw;
            try (InputStream in = getContentResolver().openInputStream(uri)) {
                if (in == null) return null;
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] b = new byte[16384]; int n;
                while ((n = in.read(b)) > 0) { buf.write(b, 0, n); if (buf.size() > 40 * 1024 * 1024) return null; }
                raw = buf.toByteArray();
            }
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(raw, 0, raw.length, o);
            int s = 1;
            while (Math.max(o.outWidth, o.outHeight) / (s * 2) >= 1600) s *= 2;
            o = new BitmapFactory.Options();
            o.inSampleSize = s;
            Bitmap bm = BitmapFactory.decodeByteArray(raw, 0, raw.length, o);
            if (bm == null) return null;
            float k = Math.min(1f, 1600f / Math.max(bm.getWidth(), bm.getHeight()));
            if (k < 1f) bm = Bitmap.createScaledBitmap(bm, Math.round(bm.getWidth() * k), Math.round(bm.getHeight() * k), true);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bm.compress(Bitmap.CompressFormat.JPEG, 85, out);
            return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }
}
