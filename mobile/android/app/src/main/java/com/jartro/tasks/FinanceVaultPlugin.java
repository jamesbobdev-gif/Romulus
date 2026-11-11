package com.jartro.tasks;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.UserNotAuthenticatedException;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import androidx.lifecycle.Lifecycle;

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
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Iterator;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Finance on the phone (mobile/finance-phone.js). Its bank data is encrypted in the page with a random key;
 * that key is kept here wrapped by an Android Keystore key that works only for the one operation a strong
 * fingerprint or face prompt unlocks (pairings made before 2026-11-11 have a 30-second key instead, which some
 * phones stopped honouring), so opening Finance always takes his fingerprint. A new fingerprint added to
 * the phone makes the Keystore key unusable: then Finance has to be paired again.
 * Also: scanning the pairing QR code (Google's code scanner: no camera permission for the app), and
 * web requests to SimpleFIN and Yahoo Finance only (the page can't reach them itself).
 */
@CapacitorPlugin(name = "FinanceVault")
public class FinanceVaultPlugin extends Plugin {
    private static final String ALIAS = "tasks_finance_wrap";
    private static final String PREFS = "finance_vault";
    private static final String FILE = "finance.vault";
    private static final int AUTH = BiometricManager.Authenticators.BIOMETRIC_STRONG;

    private SharedPreferences prefs() { return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    private File file() { return new File(getContext().getFilesDir(), FILE); }

    /** Can this phone do a strong fingerprint/face unlock right now? */
    @PluginMethod
    public void available(PluginCall call) {
        int r = BiometricManager.from(getContext()).canAuthenticate(AUTH);
        JSObject o = new JSObject();
        o.put("ok", r == BiometricManager.BIOMETRIC_SUCCESS);
        o.put("reason", r == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ? "Add a fingerprint in your phone's settings first."
                : r == BiometricManager.BIOMETRIC_SUCCESS ? "" : "This phone has no fingerprint or face unlock that Finance can use.");
        call.resolve(o);
    }

    @PluginMethod
    public void isSetUp(PluginCall call) {
        JSObject o = new JSObject();
        o.put("setUp", prefs().contains("wrapped") && file().exists());
        call.resolve(o);
    }

    /** First time: a new Keystore key, his fingerprint, then a random data key wrapped by it. → {key} */
    @PluginMethod
    public void create(PluginCall call) {
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setUserAuthenticationRequired(true)
                    .setInvalidatedByBiometricEnrollment(true);
            // per use: the key works only for the one operation the fingerprint prompt was shown for
            // (a 30-second window after any unlock stopped working on some phones after an Android update)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
            else b.setUserAuthenticationValidityDurationSeconds(-1);
            kg.init(b.build());
            kg.generateKey();
        } catch (Exception e) {
            call.reject("Couldn't make a key on this phone: " + e.getMessage());
            return;
        }
        Cipher enc;
        try {
            enc = Cipher.getInstance("AES/GCM/NoPadding");
            enc.init(Cipher.ENCRYPT_MODE, wrapKey());
        } catch (Exception e) {
            call.reject("Couldn't make a key on this phone: " + e.getMessage());
            return;
        }
        prompt(call, "Set up Finance", "Your fingerprint opens Finance on this phone", enc, c -> {
            byte[] dataKey = new byte[32];
            new SecureRandom().nextBytes(dataKey);
            byte[] wrapped = c.doFinal(dataKey);
            prefs().edit()
                    .putString("wrapped", Base64.encodeToString(wrapped, Base64.NO_WRAP))
                    .putString("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP))
                    .putBoolean("perUse", true)
                    .apply();
            JSObject o = new JSObject();
            o.put("key", Base64.encodeToString(dataKey, Base64.NO_WRAP));
            return o;
        });
    }

    /** Every time: his fingerprint, then the data key. → {key} */
    @PluginMethod
    public void unlock(PluginCall call) {
        String wrapped = prefs().getString("wrapped", null), iv = prefs().getString("iv", null);
        if (wrapped == null || iv == null) { call.reject("Finance isn't set up on this phone.", "NOT_SET_UP"); return; }
        GCMParameterSpec spec = new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP));
        Cipher dec = null;
        if (prefs().getBoolean("perUse", false)) {
            // the key the prompt itself unlocks (paired after this change)
            try {
                dec = Cipher.getInstance("AES/GCM/NoPadding");
                dec.init(Cipher.DECRYPT_MODE, wrapKey(), spec);
            } catch (KeyPermanentlyInvalidatedException e) {
                call.reject("A new fingerprint was added to this phone, so Finance has to be paired again.", "INVALIDATED");
                return;
            } catch (Exception e) {
                call.reject("Couldn't open Finance: " + e.getMessage());
                return;
            }
        }
        final Cipher ready = dec;
        prompt(call, "Open Finance", null, ready, given -> {
            Cipher c = given;
            if (c == null) { // older pairing: a key that works for 30 seconds after the fingerprint
                c = Cipher.getInstance("AES/GCM/NoPadding");
                c.init(Cipher.DECRYPT_MODE, wrapKey(), spec);
            }
            JSObject o = new JSObject();
            o.put("key", Base64.encodeToString(c.doFinal(Base64.decode(wrapped, Base64.NO_WRAP)), Base64.NO_WRAP));
            return o;
        });
    }

    /** The encrypted vault (already encrypted by the page), in the app's private files. */
    @PluginMethod
    public void write(PluginCall call) {
        String data = call.getString("data");
        if (data == null) { call.reject("nothing to write"); return; }
        new Thread(() -> {
            try {
                File tmp = new File(getContext().getFilesDir(), FILE + ".tmp");
                try (OutputStream out = new FileOutputStream(tmp)) { out.write(data.getBytes(StandardCharsets.UTF_8)); }
                if (!tmp.renameTo(file())) throw new Exception("couldn't save");
                call.resolve();
            } catch (Exception e) { call.reject(e.getMessage()); }
        }).start();
    }

    @PluginMethod
    public void read(PluginCall call) {
        new Thread(() -> {
            try {
                JSObject o = new JSObject();
                o.put("data", file().exists() ? new String(Files.readAllBytes(file().toPath()), StandardCharsets.UTF_8) : null);
                call.resolve(o);
            } catch (Exception e) { call.reject(e.getMessage()); }
        }).start();
    }

    /** Forget: the Keystore key, the wrapped data key and the vault file. */
    @PluginMethod
    public void forget(PluginCall call) {
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
        } catch (Exception ignored) {}
        prefs().edit().clear().apply();
        //noinspection ResultOfMethodCallIgnored
        file().delete();
        call.resolve();
    }

    /** While Finance is on screen: no screenshots, screen recording, recent-apps preview, or screen-reading
     *  assistants (Gemini "ask about this screen", Circle to Search) of it. */
    @PluginMethod
    public void secure(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
            else getActivity().getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
            call.resolve();
        });
    }

    /** The pairing QR code from the computer's Finance tab. → {text} */
    @PluginMethod
    public void scan(PluginCall call) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(getActivity(), options);
        scanner.startScan()
                .addOnSuccessListener(code -> { JSObject o = new JSObject(); o.put("text", code.getRawValue()); call.resolve(o); })
                .addOnCanceledListener(() -> call.reject("cancelled", "CANCELLED"))
                .addOnFailureListener(e -> call.reject("The scanner didn't start: " + e.getMessage()));
    }

    /** A GET to SimpleFIN or Yahoo Finance only, over HTTPS, no redirects. → {status, body} */
    @PluginMethod
    public void http(PluginCall call) {
        String url = call.getString("url", "");
        JSObject headers = call.getObject("headers", new JSObject());
        new Thread(() -> {
            HttpURLConnection con = null;
            try {
                URL u = new URL(url);
                String host = u.getHost().toLowerCase();
                boolean ok = "https".equals(u.getProtocol()) && (host.equals("simplefin.org") || host.endsWith(".simplefin.org") || host.equals("query1.finance.yahoo.com"));
                if (!ok) { call.reject("not an address Finance talks to"); return; }
                con = (HttpURLConnection) u.openConnection();
                con.setInstanceFollowRedirects(false);
                con.setConnectTimeout(20000);
                con.setReadTimeout(90000);
                for (Iterator<String> it = headers.keys(); it.hasNext(); ) { String k = it.next(); con.setRequestProperty(k, headers.getString(k)); }
                int status = con.getResponseCode();
                InputStream in = status >= 400 ? con.getErrorStream() : con.getInputStream();
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                if (in != null) { byte[] b = new byte[16384]; int n; while ((n = in.read(b)) > 0) { buf.write(b, 0, n); if (buf.size() > 30 * 1024 * 1024) break; } in.close(); }
                JSObject o = new JSObject();
                o.put("status", status);
                o.put("body", buf.toString("UTF-8"));
                call.resolve(o);
            } catch (Exception e) {
                call.reject("offline: " + e.getMessage(), "OFFLINE");
            } finally { if (con != null) con.disconnect(); }
        }).start();
    }

    /** The work after the fingerprint; gets the cipher the prompt unlocked, or null for an older 30-second key. */
    private interface Step { JSObject run(Cipher c) throws Exception; }

    /** Android's "user not authenticated", whichever exception carries it (doFinal wraps it in another one). */
    private static boolean notAuthed(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof UserNotAuthenticatedException) return true;
            String m = t.getMessage();
            if (m != null && m.toLowerCase().contains("not authenticated")) return true;
        }
        return false;
    }

    private static boolean invalidated(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) if (t instanceof KeyPermanentlyInvalidatedException) return true;
        return false;
    }

    private SecretKey wrapKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        return (SecretKey) ks.getKey(ALIAS, null);
    }

    /** His fingerprint (or face, if the phone counts it as strong), then the step that needs the Keystore key. */
    private BiometricPrompt current; // the prompt showing now, if any (a new one replaces it)

    /* Every call ends: the prompt's answer, or a reject right away when Android can't show it (the app isn't on
       screen, say). A call that never ended left the page's button waiting forever. */
    private void prompt(PluginCall call, String title, String subtitle, Cipher crypto, Step step) {
        FragmentActivity act = (FragmentActivity) getActivity();
        if (act == null) { call.reject("Open the app first.", "NOT_VISIBLE"); return; }
        act.runOnUiThread(() -> {
          try {
            if (!act.getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED) || act.isFinishing()) {
                call.reject("Open the app first.", "NOT_VISIBLE");
                return;
            }
            if (current != null) { try { current.cancelAuthentication(); } catch (Exception ignored) {} }
            BiometricPrompt p = new BiometricPrompt(act, ContextCompat.getMainExecutor(getContext()),
                    new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                            BiometricPrompt.CryptoObject co = result.getCryptoObject();
                            Cipher c = co != null ? co.getCipher() : null;
                            attempt(call, step, c, crypto == null);
                        }

                        @Override
                        public void onAuthenticationError(int code, @NonNull CharSequence msg) {
                            // canceled by leaving the app or by a newer prompt: not his "cancel", and not an error to show
                            String kind = code == BiometricPrompt.ERROR_NEGATIVE_BUTTON || code == BiometricPrompt.ERROR_USER_CANCELED ? "CANCELLED"
                                    : code == BiometricPrompt.ERROR_CANCELED ? "NOT_VISIBLE" : "BIOMETRIC_" + code;
                            call.reject(msg.toString(), kind);
                        }
                    });
            BiometricPrompt.PromptInfo.Builder info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setAllowedAuthenticators(AUTH)
                    .setNegativeButtonText("Cancel");
            if (subtitle != null) info.setSubtitle(subtitle);
            current = p;
            if (crypto != null) p.authenticate(info.build(), new BiometricPrompt.CryptoObject(crypto));
            else p.authenticate(info.build());
          } catch (Exception e) {
            call.reject("The fingerprint prompt didn't open: " + e.getMessage(), "PROMPT_FAILED");
          }
        });
    }

    /* After the fingerprint. An older 30-second key can be refused even right after a good fingerprint (the
       unlock reaching the Keystore late, or a phone update that stopped such keys working): one more try half a
       second later, then pairing again, which makes a per-use key that the prompt unlocks itself. */
    private void attempt(PluginCall call, Step step, Cipher c, boolean retry) {
        try { call.resolve(step.run(c)); }
        catch (Exception e) {
            if (invalidated(e)) { call.reject("A new fingerprint was added to this phone, so Finance has to be paired again.", "INVALIDATED"); return; }
            if (!notAuthed(e)) { call.reject("Couldn't open Finance: " + e.getMessage()); return; }
            if (retry) { new Handler(Looper.getMainLooper()).postDelayed(() -> attempt(call, step, null, false), 500); return; }
            if (prefs().getBoolean("perUse", false)) call.reject("The fingerprint didn't unlock it. Try again.", "NOT_AUTHENTICATED");
            else call.reject("This phone stopped letting Finance's older key open with your fingerprint. Pair Finance again from the computer to fix it.", "INVALIDATED");
        }
    }
}
