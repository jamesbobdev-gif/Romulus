package com.jartro.tasks;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/**
 * The widgets' end-to-end sync crypto against a vector the Node side made (test/sync-crypto.test.js holds the
 * same one), so the phone opens what the computer seals. Runs on the plain JVM: ./gradlew testGithubDebugUnitTest.
 */
public class SyncCryptoTest {
    static final String KEY = "tk_6f1d2c3b-4a5e-4f60-9b7c-8d9e0f1a2b3c";
    static final String AGENT = "tk_agent_6f1d2c3b-4a5e-4f60-9b7c-8d9e0f1a2b3c";
    static final String LOOKUP = "tk_vbFuoN_JuIW3TBw81Ag-JYlKzjIGJtyM";
    static final String IV = "AAECAwQFBgcICQoL";
    static final String CT = "+ehlC9I6y2FOMdccH/oiIOBIGKkt//JZQjyxNkrT0xTWV0PaKi6jKpUY6Gbk9t1JGQdTXaYPF7VSgqGSXR3KEbZt3NJVe0ljbMpdwtc0EL0ZwU/nHM3oTUNYQr7ZtYwPkwQ8KCo+";

    private static JSONObject sealedRow() throws Exception {
        return new JSONObject().put("e", 1).put("iv", IV).put("ct", CT);
    }

    @Test
    public void lookupIdsMatchTheOtherSides() throws Exception {
        assertEquals(LOOKUP, SyncCrypto.rowKey(KEY));
        assertEquals("tk_agent_vbFuoN_JuIW3TBw81Ag-JYlKzjIGJtyM", SyncCrypto.rowKey(AGENT));
        assertEquals("tk_agent_vbFuoN_JuIW3TBw81Ag-JYlKzjIGJtyM:prefs", SyncCrypto.rowKey(AGENT + ":prefs"));
        assertFalse(SyncCrypto.rowKey(KEY).contains("6f1d2c3b"));
    }

    @Test
    public void opensARowTheComputerSealed() throws Exception {
        JSONObject doc = SyncCrypto.open(KEY, sealedRow());
        assertEquals(1, doc.getInt("v"));
        assertEquals("Call the dentist", doc.getJSONArray("tasks").getJSONObject(0).getString("title"));
        assertTrue(SyncCrypto.isSealed(sealedRow()));
        assertFalse(SyncCrypto.isSealed(doc));
    }

    @Test
    public void sealsWhatItCanOpenAgain() throws Exception {
        JSONObject doc = new JSONObject().put("v", 1).put("tasks", new org.json.JSONArray().put(new JSONObject().put("id", "a1").put("title", "Zürich 東京")));
        JSONObject row = SyncCrypto.seal(AGENT + ":prefs", doc);
        assertTrue(SyncCrypto.isSealed(row));
        assertFalse(row.toString().contains("Zürich"));
        assertEquals("Zürich 東京", SyncCrypto.open(AGENT, row).getJSONArray("tasks").getJSONObject(0).getString("title"));
        // the fixed iv from the vector gives the vector's ciphertext back, byte for byte
        JSONObject fixed = SyncCrypto.seal(KEY, SyncCrypto.open(KEY, sealedRow()), SyncCrypto.unB64(IV));
        assertEquals(sealedRow().getString("iv"), fixed.getString("iv"));
        assertEquals("Call the dentist", SyncCrypto.open(KEY, fixed).getJSONArray("tasks").getJSONObject(0).getString("title"));
    }

    @Test(expected = Exception.class)
    public void anotherListsKeyDoesNotOpenIt() throws Exception {
        SyncCrypto.open(AGENT, sealedRow());
    }

    @Test
    public void base64RoundTrips() throws Exception {
        byte[] all = new byte[256];
        for (int i = 0; i < 256; i++) all[i] = (byte) i;
        for (int n = 0; n <= 256; n++) {
            byte[] part = java.util.Arrays.copyOf(all, n);
            assertEquals(n, SyncCrypto.unB64(SyncCrypto.b64(part)).length);
            assertTrue(java.util.Arrays.equals(part, SyncCrypto.unB64(SyncCrypto.b64(part))));
        }
        assertEquals("AAECAwQFBgcICQoL", SyncCrypto.b64(SyncCrypto.unB64(IV)));
        assertFalse(SyncCrypto.b64url(new byte[] { (byte) 0xfb, (byte) 0xff }).contains("="));
    }
}
