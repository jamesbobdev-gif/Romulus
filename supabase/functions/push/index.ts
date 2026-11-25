import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Sends one notification to an account's phones through Firebase Cloud Messaging, when the Agent needs the
// person or has finished (renderer/js/push.js calls this from the computer that ran the task).
//
// The body is { account, env }. `account` is one of the account's row keys (the lookup id its lists sync under,
// which only its devices know); `env` is { iv, ct }: the task's title and note, sealed on the sending device
// with a key made from the sync key. This function, the database and Firebase carry only that ciphertext: the
// phone opens it and draws the notification itself (PushService.java). So the message goes out as a data
// message, never a "notification" one, which Firebase would display as it is.
//
// Phones register their tokens, and replies typed into a notification come back, through database functions
// (supabase/migrations/20261125_push.sql), not through here.
//
// Needs the Firebase service account (Firebase console, Project settings, Service accounts, Generate new
// private key) as the whole JSON file in the app_secrets table under the name fcm_service_account. Without it
// this answers 503 and the app carries on without notifications.
// Deploy with JWT verification off (the app's publishable key isn't a JWT): the row key is the check, and
// push_send_tokens caps how many an account can send a day.

const BASE = Deno.env.get("SUPABASE_URL")!;
const SKEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(BASE, SKEY);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ROW_KEY = /^tk_[A-Za-z0-9_-]{13,}$/;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Account = { project_id: string; client_email: string; private_key: string };
let account: Account | null = null; // kept once found; looked up again while it is missing, so adding it needs no redeploy
async function serviceAccount(): Promise<Account | null> {
  if (account) return account;
  const { data } = await db.from("app_secrets").select("value").eq("name", "fcm_service_account").maybeSingle();
  try {
    const a = JSON.parse((data && data.value) || "");
    account = a && a.project_id && a.client_email && a.private_key ? a : null;
  } catch (_e) { account = null; }
  return account;
}

const b64url = (b: Uint8Array | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : b;
  let s = "";
  bytes.forEach((x) => { s += String.fromCharCode(x); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// Google's access token for the service account (a signed JWT traded for it), kept until shortly before it ends
let access: { token: string; until: number } | null = null;
async function accessToken(a: Account): Promise<string | null> {
  if (access && access.until > Date.now() + 60000) return access.token;
  const pem = a.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: a.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + claim)));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: head + "." + claim + "." + b64url(sig) }),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok || !out || !out.access_token) return null;
  access = { token: out.access_token, until: Date.now() + (Number(out.expires_in) || 3600) * 1000 };
  return access.token;
}

// one phone: true = sent, false = not, 'gone' = Firebase no longer knows the token
async function sendOne(a: Account, bearer: string, token: string, env: { iv: string; ct: string }): Promise<boolean | "gone"> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { token, data: { iv: env.iv, ct: env.ct }, android: { priority: "HIGH" } } }),
  });
  if (res.ok) return true;
  const out = await res.json().catch(() => null);
  const code = out && out.error && Array.isArray(out.error.details)
    ? out.error.details.map((d: { errorCode?: string }) => d.errorCode).filter(Boolean)[0] : "";
  return res.status === 404 || code === "UNREGISTERED" ? "gone" : false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });
  // deno-lint-ignore no-explicit-any
  let b: any;
  try { b = await req.json(); } catch (_e) { return json({ error: "bad json" }, 400); }
  const rowKey = String((b && b.account) || "");
  const env = b && b.env;
  if (!ROW_KEY.test(rowKey) || !env || typeof env.iv !== "string" || typeof env.ct !== "string") return json({ error: "bad" }, 400);
  // a data message holds 4 KB in all
  if (env.iv.length > 40 || env.ct.length > 3400) return json({ error: "too_long" }, 400);

  const a = await serviceAccount();
  if (!a) return json({ error: "not_ready" }, 503);
  const { data, error } = await db.rpc("push_send_tokens", { p_row_key: rowKey });
  if (error) return json({ error: "server" }, 500);
  const tokens: string[] = (data || []).map((r: unknown) => String(r));
  if (!tokens.length) return json({ ok: true, sent: 0 }); // no phone registered, or today's share is used up
  const bearer = await accessToken(a);
  if (!bearer) return json({ error: "not_ready" }, 503);
  let sent = 0;
  for (const token of tokens) {
    const r = await sendOne(a, bearer, token, env);
    if (r === true) sent++;
    else if (r === "gone") await db.rpc("push_token_gone", { p_token: token });
  }
  return json({ ok: true, sent });
});
