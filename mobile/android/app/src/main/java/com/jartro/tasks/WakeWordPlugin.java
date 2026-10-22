package com.jartro.tasks;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * The Settings switch for "Hey Romulus" (WakeWordService does the listening). enable() asks for the
 * mic, downloads Vosk's small English model the first time (~40 MB, "progress" events with {pct}),
 * then starts listening; it stays on across app restarts until disable() or "Turn off" in the notification.
 */
@CapacitorPlugin(name = "WakeWord", permissions = {
        @Permission(strings = {Manifest.permission.RECORD_AUDIO}, alias = "mic")})
public class WakeWordPlugin extends Plugin {
    private static final String MODEL_URL = "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip";
    private volatile boolean downloading = false;

    @PluginMethod
    public void status(PluginCall call) { call.resolve(state()); }

    @PluginMethod
    public void enable(PluginCall call) {
        if (getPermissionState("mic") != PermissionState.GRANTED) {
            requestPermissionForAlias("mic", call, "micPermission");
            return;
        }
        go(call);
    }

    @PermissionCallback
    private void micPermission(PluginCall call) {
        if (getPermissionState("mic") == PermissionState.GRANTED) go(call);
        else call.reject("Microphone permission is off — allow it for Tasks in Android settings.");
    }

    @PluginMethod
    public void disable(PluginCall call) {
        Context c = getContext();
        WakeWordService.setWanted(c, false);
        WakeWordService.stop(c);
        call.resolve(state());
    }

    /** Android's "Display over other apps" page for Tasks: lets "Hey Romulus" bring the app up by itself. */
    @PluginMethod
    public void openOverlaySettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 23) {
            Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        call.resolve();
    }

    private void go(PluginCall call) {
        // the "listening" notification needs this on Android 13+ (without it, it still works, just unseen)
        if (Build.VERSION.SDK_INT >= 33 && getActivity() != null)
            ActivityCompat.requestPermissions(getActivity(), new String[]{Manifest.permission.POST_NOTIFICATIONS}, 4103);
        Context c = getContext();
        if (WakeWordService.modelReady(c)) { start(call); return; }
        if (downloading) { call.reject("Already downloading the speech model"); return; }
        downloading = true;
        new Thread(() -> {
            try { download(c); getActivity().runOnUiThread(() -> start(call)); }
            catch (Exception e) { call.reject("Couldn't download the speech model: " + e.getMessage()); }
            finally { downloading = false; }
        }, "wake-download").start();
    }

    private void start(PluginCall call) {
        Context c = getContext();
        WakeWordService.setWanted(c, true);
        WakeWordService.startIfWanted(c);
        call.resolve(state());
    }

    private JSObject state() {
        Context c = getContext();
        JSObject o = new JSObject();
        o.put("on", WakeWordService.wanted(c));
        o.put("running", WakeWordService.isRunning());
        o.put("modelReady", WakeWordService.modelReady(c));
        o.put("downloading", downloading);
        o.put("overlay", Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(c));
        return o;
    }

    /** zip → filesDir/vosk-model-tmp → (swap in) filesDir/vosk-model, so a half download never counts as ready */
    private void download(Context c) throws Exception {
        File tmp = new File(c.getFilesDir(), "vosk-model-tmp");
        deleteAll(tmp);
        HttpURLConnection http = (HttpURLConnection) new URL(MODEL_URL).openConnection();
        http.setInstanceFollowRedirects(true);
        http.setConnectTimeout(15_000);
        http.setReadTimeout(30_000);
        if (http.getResponseCode() != 200) throw new Exception("HTTP " + http.getResponseCode());
        long total = http.getContentLengthLong();
        String root = tmp.getCanonicalPath() + File.separator;
        int lastPct = -1;
        CountingStream counted = new CountingStream(new BufferedInputStream(http.getInputStream()));
        try (ZipInputStream zip = new ZipInputStream(counted)) {
            ZipEntry e;
            byte[] buf = new byte[65536];
            while ((e = zip.getNextEntry()) != null) {
                // drop the zip's top folder (vosk-model-small-en-us-0.15/…)
                String name = e.getName();
                int slash = name.indexOf('/');
                name = slash < 0 ? name : name.substring(slash + 1);
                if (name.isEmpty()) continue;
                File out = new File(tmp, name);
                if (!out.getCanonicalPath().startsWith(root)) throw new Exception("bad zip entry " + e.getName());
                if (e.isDirectory()) { out.mkdirs(); continue; }
                File parent = out.getParentFile();
                if (parent != null) parent.mkdirs();
                try (OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = zip.read(buf)) > 0) {
                        os.write(buf, 0, n);
                        if (total > 0) {
                            int pct = (int) (counted.count * 100 / total);
                            if (pct != lastPct) { lastPct = pct; JSObject p = new JSObject(); p.put("pct", pct); notifyListeners("progress", p); }
                        }
                    }
                }
            }
        } finally { http.disconnect(); }
        if (!new File(tmp, "conf/model.conf").exists()) throw new Exception("the download didn't contain a model");
        File dir = WakeWordService.modelDir(c);
        deleteAll(dir);
        if (!tmp.renameTo(dir)) throw new Exception("couldn't save it");
    }

    private static void deleteAll(File f) {
        if (!f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteAll(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static class CountingStream extends java.io.FilterInputStream {
        long count = 0;
        CountingStream(InputStream in) { super(in); }
        @Override public int read() throws java.io.IOException { int b = super.read(); if (b >= 0) count++; return b; }
        @Override public int read(byte[] b, int off, int len) throws java.io.IOException { int n = super.read(b, off, len); if (n > 0) count += n; return n; }
    }
}
