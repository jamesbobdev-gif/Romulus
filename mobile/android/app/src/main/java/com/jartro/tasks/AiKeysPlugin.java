package com.jartro.tasks;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * His AI keys on the phone (renderer/js/phone-ai.js), copied once from the computer by a QR code and never synced.
 * Kept encrypted in this app's private storage with an Android Keystore key (no fingerprint: a Kitchen photo
 * shouldn't need one). Also: scanning that QR code (Google's code scanner: no camera permission for the app),
 * and POSTs to the four AI services only, so the keys can't be sent anywhere else.
 */
@CapacitorPlugin(name = "AiKeys")
public class AiKeysPlugin extends Plugin {
    private static final String ALIAS = "tasks_ai_keys";
    private static final String PREFS = "ai_keys";
    private static final List<String> HOSTS = Arrays.asList("api.anthropic.com", "generativelanguage.googleapis.com", "api.openai.com", "openrouter.ai");

    private SharedPreferences prefs() { return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
            kg.generateKey();
        }
        return (SecretKey) ks.getKey(ALIAS, null);
    }

    /** {data} → kept, encrypted */
    @PluginMethod
    public void save(PluginCall call) {
        String data = call.getString("data");
        if (data == null || data.length() > 20000) { call.reject("nothing to keep"); return; }
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] box = c.doFinal(data.getBytes(StandardCharsets.UTF_8));
            prefs().edit()
                    .putString("box", Base64.encodeToString(box, Base64.NO_WRAP))
                    .putString("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP))
                    .apply();
            call.resolve();
        } catch (Exception e) { call.reject("Couldn't keep them: " + e.getMessage()); }
    }

    /** → {data} or {data: null} when there's nothing (or it can't be opened any more) */
    @PluginMethod
    public void load(PluginCall call) {
        JSObject o = new JSObject();
        String box = prefs().getString("box", null), iv = prefs().getString("iv", null);
        if (box == null || iv == null) { o.put("data", null); call.resolve(o); return; }
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            o.put("data", new String(c.doFinal(Base64.decode(box, Base64.NO_WRAP)), StandardCharsets.UTF_8));
        } catch (Exception e) { o.put("data", null); }
        call.resolve(o);
    }

    @PluginMethod
    public void forget(PluginCall call) {
        prefs().edit().clear().apply();
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
        } catch (Exception ignored) {}
        call.resolve();
    }

    /** The QR code from the computer's Settings. → {text} */
    @PluginMethod
    public void scan(PluginCall call) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(getActivity(), options);
        scanner.startScan()
                .addOnSuccessListener(code -> { JSObject o = new JSObject(); o.put("text", code.getRawValue()); call.resolve(o); })
                .addOnCanceledListener(() -> call.reject("cancelled", "CANCELLED"))
                .addOnFailureListener(e -> call.reject("The scanner didn't start: " + e.getMessage()));
    }

    /** {url, headers, body} → a POST to one of the AI services, over HTTPS, no redirects. → {status, body} */
    @PluginMethod
    public void post(PluginCall call) {
        String url = call.getString("url", "");
        String body = call.getString("body", "");
        JSObject headers = call.getObject("headers", new JSObject());
        new Thread(() -> {
            HttpURLConnection con = null;
            try {
                URL u = new URL(url);
                if (!"https".equals(u.getProtocol()) || !HOSTS.contains(u.getHost().toLowerCase())) { call.reject("not an AI service"); return; }
                con = (HttpURLConnection) u.openConnection();
                con.setRequestMethod("POST");
                con.setInstanceFollowRedirects(false);
                con.setConnectTimeout(20000);
                con.setReadTimeout(120000);
                con.setDoOutput(true);
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) { String k = it.next(); con.setRequestProperty(k, headers.getString(k)); }
                try (OutputStream out = con.getOutputStream()) { out.write(body.getBytes(StandardCharsets.UTF_8)); }
                int status = con.getResponseCode();
                InputStream in = status >= 400 ? con.getErrorStream() : con.getInputStream();
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                if (in != null) { byte[] b = new byte[16384]; int n; while ((n = in.read(b)) > 0) { buf.write(b, 0, n); if (buf.size() > 8 * 1024 * 1024) break; } in.close(); }
                JSObject o = new JSObject();
                o.put("status", status);
                o.put("body", buf.toString("UTF-8"));
                call.resolve(o);
            } catch (Exception e) {
                call.reject("offline: " + e.getMessage(), "OFFLINE");
            } finally { if (con != null) con.disconnect(); }
        }).start();
    }
}
