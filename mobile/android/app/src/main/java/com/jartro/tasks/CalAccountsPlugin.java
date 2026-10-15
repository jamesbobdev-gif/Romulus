package com.jartro.tasks;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import androidx.browser.customtabs.CustomTabsIntent;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Calendar accounts on the phone: Google and Microsoft sign-in, plus calendar links (.ics).
 * The phone side of agent/calendars.js. Sign-in opens a Custom Tab with PKCE and comes back on
 * a redirect only this app answers (Google: com.jartro.tasks:/oauth2redirect, from an Android-type
 * OAuth client with "custom URI scheme" switched on; Microsoft: msauth://com.jartro.tasks/<signature
 * hash>, from the Entra app's Android platform). Codes are swapped for tokens here, not in the page,
 * because Microsoft refuses a token request that carries a web Origin from a non-SPA client.
 *
 * Tokens and calendar links stay in this app's private storage (left out of Android backups) and never
 * reach the page: it asks for calendar data through api() and feed(), which add the token themselves
 * and only talk to the Google Calendar and Microsoft Graph APIs.
 */
@CapacitorPlugin(name = "CalAccounts")
public class CalAccountsPlugin extends Plugin {
    private static final String STORE = "cal_accounts";
    private static final String GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
    private static final String GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
    private static final String GOOGLE_API = "https://www.googleapis.com/calendar/v3/";
    // read-only on the phone: the desktop app is the one that puts tasks on a calendar
    private static final String GOOGLE_SCOPE = "openid email https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly";
    private static final String MS_AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
    private static final String MS_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
    private static final String MS_API = "https://graph.microsoft.com/v1.0/";
    private static final String MS_SCOPE = "openid email profile offline_access User.Read Calendars.Read";

    private final ExecutorService net = Executors.newCachedThreadPool();
    private final Handler main = new Handler(Looper.getMainLooper());
    private PluginCall pending;      // the connect() waiting for the browser to come back
    private boolean exchanging;

    @Override
    public void load() {
        // the app was closed while the browser was open: finish the sign-in it comes back with
        Intent i = getActivity().getIntent();
        if (isRedirect(i)) { Uri u = i.getData(); i.setData(null); finishSignIn(u); }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (isRedirect(intent)) { Uri u = intent.getData(); intent.setData(null); finishSignIn(u); }
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        // back in the app without a redirect: the browser was closed, so don't leave the button hanging
        if (pending == null || exchanging) return;
        final PluginCall c = pending;
        main.postDelayed(() -> {
            if (pending == c && !exchanging) { pending = null; c.resolve(fail("Sign-in was cancelled.")); }
        }, 2500);
    }

    /* ---------- sign-in ---------- */

    @PluginMethod
    public void connect(PluginCall call) {
        String provider = call.getString("provider", "");
        if (!"google".equals(provider) && !"microsoft".equals(provider)) { call.resolve(fail("Unknown provider")); return; }
        String clientId = clientId(provider);
        if (clientId == null) {
            JSObject r = fail(("google".equals(provider) ? "Google" : "Microsoft") + " sign-in isn’t set up in this build.");
            r.put("needsClient", true);
            call.resolve(r);
            return;
        }
        try {
            String verifier = b64url(random(32));
            String challenge = b64url(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes("US-ASCII")));
            String state = hex(random(16));
            String redirect = redirectUri(provider);
            // kept on disk too, in case Android closes the app while the browser is open
            JSONObject p = new JSONObject();
            p.put("provider", provider); p.put("verifier", verifier); p.put("state", state); p.put("redirect", redirect);
            prefs().edit().putString("pending", p.toString()).apply();

            Map<String, String> q = new LinkedHashMap<>();
            q.put("client_id", clientId);
            q.put("redirect_uri", redirect);
            q.put("response_type", "code");
            q.put("scope", "google".equals(provider) ? GOOGLE_SCOPE : MS_SCOPE);
            q.put("state", state);
            q.put("code_challenge", challenge);
            q.put("code_challenge_method", "S256");
            q.put("prompt", "google".equals(provider) ? "consent" : "select_account");
            String url = ("google".equals(provider) ? GOOGLE_AUTH : MS_AUTH) + "?" + form(q);

            if (pending != null) pending.resolve(fail("Sign-in was restarted."));
            pending = call;
            exchanging = false;
            getActivity().runOnUiThread(() -> {
                try {
                    new CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(getActivity(), Uri.parse(url));
                } catch (Exception e) {
                    // no Custom Tabs browser: any browser will do
                    try { getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); }
                    catch (Exception e2) { pending = null; call.resolve(fail("Could not open the browser.")); }
                }
            });
        } catch (Exception e) {
            call.resolve(fail(e.getMessage()));
        }
    }

    private boolean isRedirect(Intent i) {
        if (i == null || !Intent.ACTION_VIEW.equals(i.getAction()) || i.getData() == null) return false;
        Uri u = i.getData();
        String pkg = getContext().getPackageName();
        return ("msauth".equals(u.getScheme()) && pkg.equals(u.getHost()))
                || (pkg.equals(u.getScheme()) && "/oauth2redirect".equals(u.getPath()));
    }

    private void finishSignIn(Uri u) {
        exchanging = true;
        final PluginCall call = pending;
        pending = null;
        net.execute(() -> {
            JSObject r;
            try { r = exchange(u); } catch (Exception e) { r = fail(e.getMessage()); }
            exchanging = false;
            if (call != null) call.resolve(r);
            else notifyListeners("connected", r); // cold start: the page refreshes its list
        });
    }

    private JSObject exchange(Uri u) throws Exception {
        String saved = prefs().getString("pending", null);
        if (saved == null) return fail("Sign-in expired. Try again.");
        JSONObject p = new JSONObject(saved);
        prefs().edit().remove("pending").apply();
        String err = u.getQueryParameter("error_description");
        if (err == null) err = u.getQueryParameter("error");
        if (err != null) return fail(err);
        String code = u.getQueryParameter("code");
        if (code == null || !p.getString("state").equals(u.getQueryParameter("state"))) return fail("Invalid response from the sign-in page.");
        String provider = p.getString("provider");
        String clientId = clientId(provider);
        if (clientId == null) return fail("Sign-in isn’t set up in this build.");

        Map<String, String> q = new LinkedHashMap<>();
        q.put("code", code);
        q.put("client_id", clientId);
        q.put("redirect_uri", p.getString("redirect"));
        q.put("grant_type", "authorization_code");
        q.put("code_verifier", p.getString("verifier"));
        if ("microsoft".equals(provider)) q.put("scope", MS_SCOPE);
        Http res = post("google".equals(provider) ? GOOGLE_TOKEN : MS_TOKEN, form(q));
        JSONObject td = json(res.body);
        if (res.status != 200) return fail(td.optString("error_description", td.optString("error", "Token exchange failed.")));
        if (!td.has("refresh_token")) return fail(("google".equals(provider) ? "Google" : "Microsoft") + " did not return a refresh token. Remove the app’s access in your account settings and try again.");
        String email = idTokenEmail(td.optString("id_token", ""));

        synchronized (CalAccountsPlugin.class) {
            JSONArray list = accounts();
            JSONObject a = null;
            // signing in again with the same account refreshes it instead of adding a copy
            for (int i = 0; i < list.length(); i++) {
                JSONObject x = list.getJSONObject(i);
                if (provider.equals(x.optString("provider")) && email != null && email.equalsIgnoreCase(x.optString("email"))) { a = x; break; }
            }
            if (a == null) { a = new JSONObject(); a.put("id", provider.charAt(0) + "-" + hex(random(4))); a.put("provider", provider); list.put(a); }
            if (email != null) a.put("email", email);
            a.put("scope", td.optString("scope", ""));
            JSONObject t = new JSONObject();
            t.put("access_token", td.getString("access_token"));
            t.put("refresh_token", td.getString("refresh_token"));
            t.put("expiry_date", System.currentTimeMillis() + td.optLong("expires_in", 3600) * 1000);
            a.put("tokens", t);
            a.remove("broken");
            save(list);
            JSObject r = new JSObject();
            r.put("ok", true); r.put("id", a.getString("id")); r.put("email", email);
            return r;
        }
    }

    /* ---------- what the page may ask ---------- */

    /** The connected accounts, without tokens or links. */
    @PluginMethod
    public void list(PluginCall call) {
        try {
            JSONArray list = accounts(), out = new JSArray();
            for (int i = 0; i < list.length(); i++) {
                JSONObject a = list.getJSONObject(i), o = new JSONObject();
                for (String k : new String[]{"id", "provider", "email", "name", "broken"}) if (a.has(k)) o.put(k, a.get(k));
                // to-do ids hash this, so the desktop gives the same event the same id (calendars.js pullKey)
                o.put("key", "ics".equals(a.optString("provider")) ? "ics:" + a.optString("url")
                        : a.has("email") ? a.optString("provider") + ":" + a.optString("email").toLowerCase() : a.optString("id"));
                out.put(o);
            }
            JSObject r = new JSObject();
            r.put("accounts", out);
            JSObject built = new JSObject();
            built.put("google", clientId("google") != null);
            built.put("microsoft", clientId("microsoft") != null);
            r.put("builtIn", built);
            call.resolve(r);
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    /** One Google Calendar / Microsoft Graph read for an account: {id, path} → {status, body}. */
    @PluginMethod
    public void api(PluginCall call) {
        net.execute(() -> {
            try {
                String id = call.getString("id", "");
                JSONObject a = find(id);
                if (a == null) { call.reject("That account is no longer connected"); return; }
                String base = "google".equals(a.optString("provider")) ? GOOGLE_API : "microsoft".equals(a.optString("provider")) ? MS_API : null;
                if (base == null) { call.reject("Not a sign-in account"); return; }
                String path = call.getString("path", "");
                String url = path.startsWith(base) ? path : base + path.replaceFirst("^/+", "");
                if (url.contains("..") || !url.startsWith(base)) { call.reject("Not a calendar request"); return; }
                Http res = get(url, token(id, false));
                if (res.status == 401) res = get(url, token(id, true));
                JSObject r = new JSObject();
                r.put("status", res.status);
                r.put("body", res.body);
                call.resolve(r);
            } catch (Exception e) { call.reject(e.getMessage()); }
        });
    }

    /** A calendar link's contents: {id} → {status, body}. */
    @PluginMethod
    public void feed(PluginCall call) {
        net.execute(() -> {
            try {
                JSONObject a = find(call.getString("id", ""));
                if (a == null || !"ics".equals(a.optString("provider"))) { call.reject("That calendar link is gone"); return; }
                Http res = getText(a.getString("url"));
                JSObject r = new JSObject();
                r.put("status", res.status); r.put("body", res.body);
                call.resolve(r);
            } catch (Exception e) { call.reject(e.getMessage()); }
        });
    }

    @PluginMethod
    public void addLink(PluginCall call) {
        net.execute(() -> {
            try {
                String u = call.getString("url", "").trim().replaceFirst("(?i)^webcals?://", "https://");
                Uri x = Uri.parse(u);
                if (!"https".equals(x.getScheme()) || x.getHost() == null) { call.resolve(fail("Use an https:// or webcal:// link.")); return; }
                Http res;
                try { res = getText(u); } catch (Exception e) { call.resolve(fail("Couldn’t read it: " + e.getMessage())); return; }
                if (res.status != 200 || !res.body.contains("BEGIN:VCALENDAR")) { call.resolve(fail("Couldn’t read it: " + (res.status == 200 ? "not a calendar" : "HTTP " + res.status))); return; }
                synchronized (CalAccountsPlugin.class) {
                    JSONArray list = accounts();
                    for (int i = 0; i < list.length(); i++) if (u.equals(list.getJSONObject(i).optString("url"))) { call.resolve(fail("Already added.")); return; }
                    String name = call.getString("name", "").trim();
                    if (name.length() > 40) name = name.substring(0, 40);
                    JSONObject a = new JSONObject();
                    a.put("id", "i-" + hex(random(4))); a.put("provider", "ics"); a.put("url", u);
                    a.put("name", name.isEmpty() ? x.getHost() : name);
                    list.put(a);
                    save(list);
                    JSObject r = new JSObject();
                    r.put("ok", true); r.put("id", a.getString("id"));
                    call.resolve(r);
                }
            } catch (Exception e) { call.resolve(fail(e.getMessage())); }
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            synchronized (CalAccountsPlugin.class) {
                String id = call.getString("id", "");
                JSONArray list = accounts(), keep = new JSONArray();
                for (int i = 0; i < list.length(); i++) if (!id.equals(list.getJSONObject(i).optString("id"))) keep.put(list.get(i));
                save(keep);
            }
            call.resolve();
        } catch (Exception e) { call.reject(e.getMessage()); }
    }

    /* ---------- tokens ---------- */

    private String token(String id, boolean force) throws Exception {
        synchronized (CalAccountsPlugin.class) {
            JSONArray list = accounts();
            JSONObject a = null;
            for (int i = 0; i < list.length(); i++) if (id.equals(list.getJSONObject(i).optString("id"))) a = list.getJSONObject(i);
            if (a == null) throw new Exception("That account is no longer connected");
            JSONObject t = a.optJSONObject("tokens");
            if (t == null) t = new JSONObject();
            if (!force && t.has("access_token") && t.optLong("expiry_date") > System.currentTimeMillis() + 60000) return t.getString("access_token");
            if (!t.has("refresh_token")) throw new Exception("Sign in again");
            String provider = a.optString("provider");
            String clientId = clientId(provider);
            if (clientId == null) throw new Exception("Sign-in isn’t set up in this build");
            Map<String, String> q = new LinkedHashMap<>();
            q.put("client_id", clientId);
            q.put("refresh_token", t.getString("refresh_token"));
            q.put("grant_type", "refresh_token");
            if ("microsoft".equals(provider)) q.put("scope", MS_SCOPE);
            Http res = post("google".equals(provider) ? GOOGLE_TOKEN : MS_TOKEN, form(q));
            JSONObject d = json(res.body);
            if (res.status != 200) {
                if ("invalid_grant".equals(d.optString("error"))) { a.put("broken", true); save(list); }
                throw new Exception(d.optString("error_description", d.optString("error", "Token refresh failed")));
            }
            t.put("access_token", d.getString("access_token"));
            t.put("expiry_date", System.currentTimeMillis() + d.optLong("expires_in", 3600) * 1000);
            if (d.has("refresh_token")) t.put("refresh_token", d.getString("refresh_token"));
            a.put("tokens", t);
            a.remove("broken");
            save(list);
            return t.getString("access_token");
        }
    }

    /* ---------- storage ---------- */

    private SharedPreferences prefs() { return getContext().getSharedPreferences(STORE, Context.MODE_PRIVATE); }
    private JSONArray accounts() {
        try { return new JSONArray(prefs().getString("accounts", "[]")); } catch (Exception e) { return new JSONArray(); }
    }
    private void save(JSONArray list) { prefs().edit().putString("accounts", list.toString()).apply(); }
    private JSONObject find(String id) throws Exception {
        JSONArray list = accounts();
        for (int i = 0; i < list.length(); i++) if (id.equals(list.getJSONObject(i).optString("id"))) return list.getJSONObject(i);
        return null;
    }

    /** res/raw/oauth_clients.json, written by prepare-www.js from oauth-clients.json. */
    private String clientId(String provider) {
        try {
            int res = getContext().getResources().getIdentifier("oauth_clients", "raw", getContext().getPackageName());
            if (res == 0) return null;
            JSONObject c = new JSONObject(SyncStore.readAll(getContext().getResources().openRawResource(res)));
            String id = c.optJSONObject(provider) == null ? "" : c.getJSONObject(provider).optString("clientId", "");
            return id.isEmpty() ? null : id;
        } catch (Exception e) { return null; }
    }

    private String redirectUri(String provider) throws Exception {
        String pkg = getContext().getPackageName();
        if ("google".equals(provider)) return pkg + ":/oauth2redirect";
        return "msauth://" + pkg + "/" + URLEncoder.encode(signatureHash(), "UTF-8");
    }

    /** Base64 of the SHA-1 of the app's signing certificate: what Entra's Android platform asks for. */
    private String signatureHash() throws Exception {
        PackageManager pm = getContext().getPackageManager();
        String pkg = getContext().getPackageName();
        Signature[] sigs;
        if (Build.VERSION.SDK_INT >= 28) {
            PackageInfo pi = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES);
            sigs = pi.signingInfo.hasMultipleSigners() ? pi.signingInfo.getApkContentsSigners() : pi.signingInfo.getSigningCertificateHistory();
        } else {
            sigs = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES).signatures;
        }
        return Base64.encodeToString(MessageDigest.getInstance("SHA-1").digest(sigs[0].toByteArray()), Base64.NO_WRAP);
    }

    /* ---------- http ---------- */

    private static final class Http { int status; String body; }

    private Http post(String url, String form) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(15000); c.setReadTimeout(20000);
        c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
        c.setRequestProperty("Accept", "application/json");
        c.setDoOutput(true);
        try (OutputStream os = c.getOutputStream()) { os.write(form.getBytes("UTF-8")); }
        return read(c, 1 << 20);
    }

    private Http get(String url, String token) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000); c.setReadTimeout(20000);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Accept", "application/json");
        if (url.startsWith(MS_API)) c.setRequestProperty("Prefer", "outlook.timezone=\"UTC\"");
        return read(c, 8 << 20);
    }

    private Http getText(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(15000); c.setReadTimeout(20000);
        c.setRequestProperty("Accept", "text/calendar");
        Http h = read(c, 8 << 20);
        if (!c.getURL().getProtocol().equals("https")) throw new Exception("redirected off https");
        return h;
    }

    private Http read(HttpURLConnection c, int max) throws Exception {
        try {
            Http h = new Http();
            h.status = c.getResponseCode();
            InputStream in = h.status >= 400 ? c.getErrorStream() : c.getInputStream();
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            if (in != null) {
                byte[] b = new byte[16384]; int n;
                while ((n = in.read(b)) > 0) { buf.write(b, 0, n); if (buf.size() > max) throw new Exception("response too large"); }
                in.close();
            }
            h.body = buf.toString("UTF-8");
            return h;
        } finally { c.disconnect(); }
    }

    /* ---------- small helpers ---------- */

    private static JSObject fail(String msg) {
        JSObject r = new JSObject();
        r.put("ok", false);
        r.put("error", msg == null ? "Sign-in failed." : msg);
        return r;
    }
    private static JSONObject json(String s) {
        try { return new JSONObject(s); } catch (Exception e) { return new JSONObject(); }
    }
    private static String form(Map<String, String> q) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : q.entrySet()) {
            if (sb.length() > 0) sb.append('&');
            sb.append(URLEncoder.encode(e.getKey(), "UTF-8")).append('=').append(URLEncoder.encode(e.getValue(), "UTF-8"));
        }
        return sb.toString();
    }
    private static byte[] random(int n) { byte[] b = new byte[n]; new SecureRandom().nextBytes(b); return b; }
    private static String b64url(byte[] b) { return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING); }
    private static String hex(byte[] b) { StringBuilder sb = new StringBuilder(); for (byte x : b) sb.append(String.format("%02x", x)); return sb.toString(); }
    private static String idTokenEmail(String idToken) {
        try {
            String[] p = idToken.split("\\.");
            JSONObject o = new JSONObject(new String(Base64.decode(p[1], Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP), "UTF-8"));
            String e = o.optString("email", "");
            if (e.isEmpty()) e = o.optString("preferred_username", "");
            return e.isEmpty() ? null : e;
        } catch (Exception e) { return null; }
    }
}
