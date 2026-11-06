import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Romulus sync, $5 a month or $50 a year (supabase/migrations/20261106_sync_paid_plan.sql). The app opens a Stripe Payment Link
// with ?client_reference_id=<account id> (sha256 of the sync key's id part, never the key: renderer/js/hosted-sync.js).
// Stripe calls this function when someone pays; it gives that account the paid space until a few days past the
// period Stripe billed. A cancelled or failed subscription just stops renewing, so the paid space runs out on
// its own and nothing is deleted.
// Deploy with JWT verification off (Stripe can't send a Supabase token): every request is checked against the
// Stripe signing secret instead, the app_secrets row stripe_webhook_secret (service role only).

const BASE = Deno.env.get("SUPABASE_URL")!;
const SKEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GRACE_S = 3 * 24 * 60 * 60; // a renewal that's a day or two late doesn't pause anyone's sync
const TOLERANCE_S = 5 * 60; // Stripe's own default for how old a signed request may be

async function secret(): Promise<string> {
  const r = await fetch(`${BASE}/rest/v1/app_secrets?name=eq.stripe_webhook_secret&select=value`, {
    headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}` },
  });
  if (!r.ok) return "";
  const rows = await r.json();
  return rows[0]?.value || "";
}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// Stripe-Signature: t=<unix>,v1=<hmac-sha256 of "t.body">[,v1=…]
export async function signedByStripe(header: string, body: string, key: string, now = Date.now() / 1000): Promise<boolean> {
  if (!header || !key) return false;
  const parts = header.split(",").map((p) => p.split("="));
  const t = parts.find((p) => p[0] === "t")?.[1];
  const sigs = parts.filter((p) => p[0] === "v1").map((p) => p[1] || "");
  if (!t || !sigs.length || Math.abs(now - Number(t)) > TOLERANCE_S) return false;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(t + "." + body)));
  return sigs.some((s) => sameText(s, want));
}

async function rpc(fn: string, args: Record<string, unknown>) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(fn + " HTTP " + r.status);
  return await r.json();
}
async function markPaid(account: string | null, subscription: string | null, customer: string | null, untilS: number) {
  const r = await fetch(`${BASE}/rest/v1/rpc/sync_mark_paid`, {
    method: "POST",
    headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_account: account, p_subscription: subscription, p_customer: customer, p_until: new Date(untilS * 1000).toISOString() }),
  });
  if (!r.ok) throw new Error("sync_mark_paid HTTP " + r.status);
  return await r.json();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const body = await req.text();
  if (!(await signedByStripe(req.headers.get("stripe-signature") || "", body, await secret()))) {
    return new Response("bad signature", { status: 400 });
  }
  let ev: any;
  try { ev = JSON.parse(body); } catch { return new Response("bad body", { status: 400 }); }
  const o = ev?.data?.object || {};
  const now = Math.floor(Date.now() / 1000);
  try {
    if (ev.type === "checkout.session.completed" && o.mode === "subscription") {
      // the first payment: the account comes from the link the app opened
      const account = /^[0-9a-f]{64}$/.test(String(o.client_reference_id || "")) ? o.client_reference_id : null;
      if (!account) return new Response("no account on this checkout", { status: 200 });
      const ok = await markPaid(account, o.subscription || null, o.customer || null, now + 31 * 24 * 60 * 60 + GRACE_S);
      // the optional "name for the supporters list" field on the payment link (key: supportername)
      const name = (o.custom_fields || []).find((f: any) => f?.key === "supportername")?.text?.value;
      if (ok && name) await rpc("sync_mark_supporter", { p_account: account, p_name: String(name) }).catch(() => {});
      return new Response(ok ? "ok" : "no such account", { status: 200 });
    }
    // newer Stripe API versions put the subscription under parent.subscription_details
    const sub = o.subscription || o.parent?.subscription_details?.subscription || null;
    if (ev.type === "invoice.paid" && sub) {
      // every renewal: paid until the end of the period just billed (a month, or a year on the yearly link)
      const end = Math.max(...(o.lines?.data || []).map((l: any) => Number(l?.period?.end) || 0), now + 31 * 24 * 60 * 60);
      const ok = await markPaid(null, sub, o.customer || null, end + GRACE_S);
      // the first invoice can arrive before checkout.session.completed has said whose subscription it is:
      // answer 500 so Stripe sends it again in a few minutes, by when it's known (a yearly plan needs its year)
      if (!ok && o.billing_reason === "subscription_create") return new Response("not linked yet", { status: 500 });
      return new Response("ok", { status: 200 });
    }
  } catch (e) {
    return new Response(String((e as Error).message), { status: 500 }); // Stripe retries
  }
  return new Response("ignored", { status: 200 });
});
