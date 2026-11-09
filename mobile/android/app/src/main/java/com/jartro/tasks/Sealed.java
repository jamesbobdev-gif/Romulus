package com.jartro.tasks;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Strings sealed under a key that lives in the Android Keystore and never leaves it (AES-256-GCM), so a
 * copy of the app's preferences files (a rooted phone, a backup tool that ignores the exclusion rules, an
 * ADB pull of the app's data) holds nothing readable. The key needs no fingerprint: this is for values the
 * app uses on its own, such as the calendar sign-in tokens. The format is "<iv>:<ciphertext>", both base64.
 */
final class Sealed {
    private Sealed() {}

    private static final String ALIAS = "tasks_prefs_seal";

    static String seal(String plain) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
    }

    static String open(String sealed) throws Exception {
        int i = sealed.indexOf(':');
        if (i < 0) throw new Exception("not a sealed value");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(sealed.substring(0, i), Base64.NO_WRAP)));
        return new String(c.doFinal(Base64.decode(sealed.substring(i + 1), Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }

    private static synchronized SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) return (SecretKey) ks.getKey(ALIAS, null);
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }
}
