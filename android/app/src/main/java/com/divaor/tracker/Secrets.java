package com.divaor.tracker;

import android.content.Context;
import android.content.SharedPreferences;
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
 * Secrets (the GitHub token, model and speech keys): encrypted with an AES key that never
 * leaves the Android Keystore, kept in the "secrets" preferences (left out of backups: a copy
 * restored on another phone could not be read). The page reaches them through the plugin's
 * secretGet/secretSet; the change checks (Changes) read the token here.
 */
final class Secrets {

    private static final String KEY_ALIAS = "tracker-secrets";
    private static final String PREFS = "secrets";

    private Secrets() {}

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(
            new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return generator.generateKey();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** A secret, or null (none, or its key was lost with a restore to another phone). */
    static synchronized String read(Context context, String name) {
        String stored = name == null ? null : prefs(context).getString(name, null);
        if (stored == null) return null;
        try {
            byte[] all = Base64.decode(stored, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, 12));
            return new String(cipher.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    /** Keeps a secret (null or empty: forgets it). */
    static synchronized void write(Context context, String name, String value) throws Exception {
        if (value == null || value.isEmpty()) {
            prefs(context).edit().remove(name).apply();
            return;
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV();
        byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] all = new byte[iv.length + sealed.length];
        System.arraycopy(iv, 0, all, 0, iv.length);
        System.arraycopy(sealed, 0, all, iv.length, sealed.length);
        prefs(context).edit().putString(name, Base64.encodeToString(all, Base64.NO_WRAP)).apply();
    }
}
