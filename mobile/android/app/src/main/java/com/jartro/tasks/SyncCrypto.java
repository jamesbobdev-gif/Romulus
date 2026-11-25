package com.jartro.tasks;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * End-to-end encrypted sync ("v2") for the widgets: the same derivation as renderer/js/sync-crypto.js and
 * agent/sync-crypto.js, so the phone's home-screen widgets can open the rows the app writes.
 *
 * From a list's sync key, HKDF-SHA256 with the salt "romulus-sync-v2" makes two things:
 *   - the row's lookup id (info "lookup", 24 bytes, base64url without padding, after the key's tk_[list_]
 *     prefix): the only thing the server sees. It is made from the key without its prefix, so every list
 *     made from one sync key shares one id and stays one account.
 *   - the content key (info "content", 32 bytes, from the whole key): AES-256-GCM over the document.
 * A sealed row is {"e":1,"iv":...,"ct":...}, both base64, the 16-byte GCM tag at the end of ct (as WebCrypto
 * and Java both write it). A side row ("tk_...:prefs") is its list's lookup id plus the same suffix, under
 * the list's key.
 *
 * No Android classes here, so it runs in a plain JVM unit test (SyncCryptoTest) against a vector that the
 * Node side made (test/sync-crypto.test.js holds the same one).
 */
final class SyncCrypto {
    private SyncCrypto() {}

    private static final byte[] SALT = "romulus-sync-v2".getBytes(StandardCharsets.UTF_8);

    /** "tk_agent_abc:prefs" → ["tk_agent_abc", ":prefs"]; no suffix → "". */
    static String[] splitKey(String k) {
        int i = k.indexOf(':');
        return i < 0 ? new String[] { k, "" } : new String[] { k.substring(0, i), k.substring(i) };
    }
    /** The tk_ / tk_work_ / tk_agent_ / tk_school_ prefix of a base key. */
    static String keyPrefix(String base) {
        for (String p : new String[] { "tk_work_", "tk_agent_", "tk_school_" }) if (base.startsWith(p)) return p;
        return "tk_";
    }

    /** The key the database knows a row by: lookup id + suffix. */
    static String rowKey(String syncKey) throws Exception {
        String[] s = splitKey(syncKey);
        String pre = keyPrefix(s[0]);
        byte[] id = hkdf(s[0].substring(pre.length()).getBytes(StandardCharsets.UTF_8), "lookup", 24);
        return pre + b64url(id) + s[1];
    }

    static boolean isSealed(JSONObject doc) {
        return doc != null && doc.optInt("e") == 1 && doc.has("iv") && doc.has("ct");
    }

    static JSONObject seal(String syncKey, JSONObject doc) throws Exception {
        byte[] iv = new byte[12];
        new SecureRandom().nextBytes(iv);
        return seal(syncKey, doc, iv);
    }
    /** With a given iv: only the unit test calls this (a fixed iv makes a fixed row). */
    static JSONObject seal(String syncKey, JSONObject doc, byte[] iv) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, contentKey(syncKey), new GCMParameterSpec(128, iv));
        byte[] ct = c.doFinal(doc.toString().getBytes(StandardCharsets.UTF_8));
        JSONObject out = new JSONObject();
        out.put("e", 1);
        out.put("iv", b64(iv));
        out.put("ct", b64(ct));
        return out;
    }

    static JSONObject open(String syncKey, JSONObject env) throws Exception {
        byte[] iv = unB64(env.getString("iv")), ct = unB64(env.getString("ct"));
        if (iv.length != 12 || ct.length < 16) throw new Exception("bad sealed row");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, contentKey(syncKey), new GCMParameterSpec(128, iv));
        return new JSONObject(new String(c.doFinal(ct), StandardCharsets.UTF_8));
    }

    private static SecretKeySpec contentKey(String syncKey) throws Exception {
        String base = splitKey(syncKey)[0];
        return new SecretKeySpec(hkdf(base.getBytes(StandardCharsets.UTF_8), "content", 32), "AES");
    }

    /* ── HKDF-SHA256 (RFC 5869): extract with the fixed salt, then expand with the info ── */
    static byte[] hkdf(byte[] ikm, String info, int length) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SALT, "HmacSHA256"));
        byte[] prk = mac.doFinal(ikm);
        mac.init(new SecretKeySpec(prk, "HmacSHA256"));
        byte[] infoB = info.getBytes(StandardCharsets.UTF_8);
        byte[] out = new byte[length];
        byte[] t = new byte[0];
        int done = 0;
        for (int i = 1; done < length; i++) {
            mac.update(t);
            mac.update(infoB);
            mac.update((byte) i);
            t = mac.doFinal();
            int n = Math.min(t.length, length - done);
            System.arraycopy(t, 0, out, done, n);
            done += n;
        }
        return out;
    }

    /* ── base64, written out here so this class needs neither android.util.Base64 (absent in a JVM test)
         nor java.util.Base64 (API 26; the app supports 24) ── */
    private static final String ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    static String b64(byte[] b) {
        StringBuilder sb = new StringBuilder((b.length + 2) / 3 * 4);
        for (int i = 0; i < b.length; i += 3) {
            int n = (b[i] & 0xff) << 16 | (i + 1 < b.length ? (b[i + 1] & 0xff) << 8 : 0) | (i + 2 < b.length ? b[i + 2] & 0xff : 0);
            sb.append(ABC.charAt(n >> 18 & 63)).append(ABC.charAt(n >> 12 & 63));
            sb.append(i + 1 < b.length ? ABC.charAt(n >> 6 & 63) : '=');
            sb.append(i + 2 < b.length ? ABC.charAt(n & 63) : '=');
        }
        return sb.toString();
    }
    static String b64url(byte[] b) {
        return b64(b).replace('+', '-').replace('/', '_').replaceAll("=+$", "");
    }
    static byte[] unB64(String s) throws Exception {
        s = s.trim().replaceAll("=+$", "");
        int len = s.length() * 6 / 8;
        byte[] out = new byte[len];
        int acc = 0, bits = 0, o = 0;
        for (int i = 0; i < s.length(); i++) {
            int v = ABC.indexOf(s.charAt(i));
            if (v < 0) throw new Exception("bad base64");
            acc = acc << 6 | v;
            bits += 6;
            if (bits >= 8) { bits -= 8; if (o < len) out[o++] = (byte) (acc >> bits & 0xff); }
        }
        return out;
    }
}
