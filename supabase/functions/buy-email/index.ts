import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Emails someone the link to a thing they chose in the Tasks app: a product to buy ("Choose this"), a 3D model to
// print ("Print this"), or anything else, like a job posting or booking page ("Send me link"). Sends through
// Resend. Never places an order or starts a print. Two ways in:
//
// 1. Anyone on the Romulus server (renderer/js/link-email.js). The body has an action and the account's personal
//    row key (the lookup id its lists sync under, which only its devices know). Mail only ever goes to the address
//    that account confirmed with a 6-digit code (supabase/migrations/20261118_link_email.sql), so the server can't
//    be used to mail strangers: 'start' mails a code to a new address, 'confirm' takes the code back, 'status' and
//    'forget' read and clear it, 'send' mails one link. Caps per account, per address and in total each day.
// 2. The maintainer's own setup (main/buy-emails.js, older configs): the buy_email_token secret (Authorization:
//    Bearer, or ?token=) and a body with `to`, which has to be the buy_email_to secret.
//
// The token, the Resend key and the sender live in the app_secrets table (row-level security, service role only),
// never in the app or this source. Resend's shared sender (onboarding@resend.dev) only delivers to the Resend
// account's own address: mailing anyone else needs a domain verified at Resend and its address in the
// buy_email_from secret (for example "Tasks <links@yourdomain.com>").
// Deploy with JWT verification off (the app's publishable key isn't a JWT): the row key or token is the check.

const BASE = Deno.env.get("SUPABASE_URL")!;
const SKEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(BASE, SKEY);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ROW_KEY = /^tk_[A-Za-z0-9_-]{13,}$/;

function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

async function secrets(): Promise<Record<string, string>> {
  const { data } = await db.from("app_secrets").select("name,value").in("name", ["buy_email_token", "resend_api_key", "buy_email_to", "buy_email_from"]);
  return Object.fromEntries((data || []).map((s: { name: string; value: string }) => [s.name, s.value]));
}
const SECRETS = await secrets();
const FN_TOKEN = SECRETS.buy_email_token || "";
// the maintainer's own address: the token path only ever mails there, so the token alone can't mail anyone else
const ONLY_TO = (SECRETS.buy_email_to || "").trim().toLowerCase();
const FROM = (SECRETS.buy_email_from || "").trim() || "Tasks <onboarding@resend.dev>";
const resendKey = () => Deno.env.get("RESEND_API_KEY") || SECRETS.resend_api_key || "";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// the token compared in constant time, through a hash so lengths don't tell either
async function tokenOk(given: string | null): Promise<boolean> {
  if (!given || !FN_TOKEN) return false;
  const [a, b] = await Promise.all([given, FN_TOKEN].map((s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// deno-lint-ignore no-explicit-any
function linkHtml(b: any): string {
  let site = "the site";
  try { site = new URL(b.url).hostname.replace(/^www\./, ""); } catch (_e) { /* keep default */ }
  const print = b.kind === "print", link = b.kind === "link";
  const meta = [b.price, b.rating].filter(Boolean).map(esc).join(" &middot; ");
  return '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;color:#161616">' +
    '<h2 style="font-size:18px;margin:0 0 12px">' + esc(b.label) + '</h2>' +
    (b.image && /^https:\/\//i.test(String(b.image)) ? '<img src="' + esc(b.image) + '" alt="" style="max-width:260px;border-radius:10px;border:1px solid #e9e9e5;margin-bottom:12px"><br>' : "") +
    (meta ? '<div style="color:#71716c;margin-bottom:14px">' + meta + '</div>' : "") +
    '<a href="' + esc(b.url) + '" style="display:inline-block;background:#2742c8;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px">' +
    (print ? 'Open the model on ' : link ? 'Open on ' : 'Buy on ') + esc(site) + ' &rarr;</a>' +
    (print ? '<p style="color:#5f5f5a;font-size:14px;margin-top:16px">On the page, use <b>Open in Bambu Studio</b> or <b>Print</b> to send it to your printer. On your phone the link opens in Bambu Handy if you have it.</p>' : "") +
    '<p style="color:#9a9a94;font-size:12px;margin-top:20px">' +
    (print ? 'Sent by your Tasks app because you picked this model to print. It never starts a print by itself.'
      : link ? 'Sent by your Tasks app because you asked for this link.'
      : 'Sent by your Tasks app because you chose this item. It never places orders. The purchase is up to you.') +
    '</p></div>';
}
function codeHtml(code: string): string {
  return '<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;color:#161616">' +
    '<p>Your code for the Tasks app:</p>' +
    '<p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:8px 0 16px">' + esc(code) + '</p>' +
    '<p style="color:#5f5f5a;font-size:14px">Type it in Settings, Device sync, to get the links you choose in the app at this address. It works for 15 minutes.</p>' +
    '<p style="color:#9a9a94;font-size:12px;margin-top:20px">If you didn’t ask for this, ignore it: nothing is sent to you unless the code is typed in.</p></div>';
}
// deno-lint-ignore no-explicit-any
const linkSubject = (b: any) => (b.kind === "print" ? "Print: " : b.kind === "link" ? "Link: " : "Buy: ") + String(b.label).slice(0, 180);

async function mail(to: string, subject: string, html: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const key = resendKey();
  if (!key) return { ok: false, error: "not_ready" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  const data = await res.json().catch(() => null);
  if (res.ok) return { ok: true, id: data && data.id };
  const msg = String((data && (data.message || data.name)) || `HTTP ${res.status}`);
  // the shared sender, or a domain not verified yet: Resend refuses any address but the account's own
  if (res.status === 403 || /verify a domain|testing emails|not verified/i.test(msg)) return { ok: false, error: "not_ready" };
  return { ok: false, error: msg };
}

// deno-lint-ignore no-explicit-any
function linkOk(b: any): string {
  if (!b || !b.url || !b.label) return "need label, url";
  if (!/^https?:\/\//i.test(String(b.url))) return "url must be http(s)"; // the button's link: web pages only
  return "";
}

// 1. everyone on the Romulus server
// deno-lint-ignore no-explicit-any
async function accountAction(b: any): Promise<Response> {
  const rowKey = String(b.account || "");
  if (!ROW_KEY.test(rowKey)) return json({ error: "bad" }, 400);
  if (b.action === "status") {
    const { data, error } = await db.rpc("link_email_status", { p_row_key: rowKey });
    if (error) return json({ error: "server" }, 500);
    return json({ ok: true, email: data || null });
  }
  if (b.action === "forget") {
    const { error } = await db.rpc("link_email_forget", { p_row_key: rowKey });
    return error ? json({ error: "server" }, 500) : json({ ok: true });
  }
  if (b.action === "start") {
    const email = String(b.email || "").trim().toLowerCase();
    const n = new Uint32Array(1);
    crypto.getRandomValues(n);
    const code = String(n[0] % 1000000).padStart(6, "0");
    const { data, error } = await db.rpc("link_email_start", { p_row_key: rowKey, p_email: email, p_code_hash: await sha256(rowKey + ":" + code) });
    if (error) return json({ error: "server" }, 500);
    if (data !== "ok") return json({ error: data }, 429);
    const sent = await mail(email, "Your Tasks code: " + code, codeHtml(code));
    return sent.ok ? json({ ok: true }) : json({ error: sent.error }, 502);
  }
  if (b.action === "confirm") {
    const code = String(b.code || "").replace(/\D/g, "");
    if (code.length !== 6) return json({ error: "wrong" }, 400);
    const { data, error } = await db.rpc("link_email_confirm", { p_row_key: rowKey, p_code_hash: await sha256(rowKey + ":" + code) });
    if (error) return json({ error: "server" }, 500);
    if (data !== "ok") return json({ error: data }, 400);
    const st = await db.rpc("link_email_status", { p_row_key: rowKey });
    return json({ ok: true, email: st.data || null });
  }
  if (b.action === "send") {
    const bad = linkOk(b);
    if (bad) return json({ error: bad }, 400);
    const { data, error } = await db.rpc("link_email_take", { p_row_key: rowKey });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) return json({ error: "server" }, 500);
    if (row.status !== "ok" || !row.email) return json({ error: row.status }, 409);
    const sent = await mail(row.email, linkSubject(b), linkHtml(b));
    return sent.ok ? json({ ok: true, id: sent.id }) : json({ error: sent.error }, 502);
  }
  return json({ error: "bad" }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });
  // deno-lint-ignore no-explicit-any
  let b: any;
  try { b = await req.json(); } catch (_e) { return json({ error: "bad json" }, 400); }
  if (b && typeof b.action === "string") return accountAction(b);

  // 2. the maintainer's own setup
  const url = new URL(req.url);
  if (!FN_TOKEN || !ONLY_TO) return new Response("Not configured: app_secrets needs buy_email_token and buy_email_to", { status: 503 });
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() || null;
  // the app's publishable key rides in Authorization on the account path; a token in the URL wins here
  if (!(await tokenOk(url.searchParams.get("token") || bearer))) return new Response("Not found", { status: 404 });
  if (!b || !b.to) return json({ error: "need to, label, url" }, 400);
  if (String(b.to).trim().toLowerCase() !== ONLY_TO) return json({ error: "recipient not allowed" }, 403);
  const bad = linkOk(b);
  if (bad) return json({ error: bad }, 400);
  if (!resendKey()) return json({ error: "no Resend key configured yet" }, 503);
  const sent = await mail(String(b.to), linkSubject(b), linkHtml(b));
  return sent.ok ? json({ ok: true, id: sent.id }) : json({ error: sent.error }, 502);
});
