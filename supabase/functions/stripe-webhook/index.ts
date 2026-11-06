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

// One line per call in the function's logs (Supabase → Edge Functions → stripe-webhook → Logs): which Stripe
// event, live or test, and what came of it. Only Stripe's own ids, no names, amounts or account ids, so a
// payment can be matched to Stripe's event deliveries without the logs holding anything personal.
function answer(ev: any, status: number, outcome: string): Response {
  console.log(JSON.stringify({ event: ev?.type || null, id: ev?.id || null, live: ev?.livemode ?? null, status, outcome }));
  return new Response(outcome, { status });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const body = await req.text();
  if (!(await signedByStripe(req.headers.get("stripe-signature") || "", body, await secret()))) {
    // a real Stripe delivery here means stripe_webhook_secret isn't this endpoint's signing secret
    return answer(null, 400, req.headers.get("stripe-signature") ? "bad signature (signed, but not with the saved secret)" : "bad signature (unsigned)");
  }
  let ev: any;
  try { ev = JSON.parse(body); } catch { return answer(null, 400, "bad body"); }
  const o = ev?.data?.object || {};
  const now = Math.floor(Date.now() / 1000);
  try {
    if (ev.type === "checkout.session.completed" && o.mode === "subscription") {
      // the first payment: the account comes from the link the app opened
      const account = /^[0-9a-f]{64}$/.test(String(o.client_reference_id || "")) ? o.client_reference_id : null;
      if (!account) return answer(ev, 200, "no account on this checkout: paid from the bare link, not the app's button");
      const ok = await markPaid(account, o.subscription || null, o.customer || null, now + 31 * 24 * 60 * 60 + GRACE_S);
      // the optional "name for the supporters list" field on the payment link (key: supportername)
      const name = (o.custom_fields || []).find((f: any) => f?.key === "supportername")?.text?.value;
      if (ok && name) await rpc("sync_mark_supporter", { p_account: account, p_name: String(name) }).catch(() => {});
      return answer(ev, 200, ok ? "paid: plan on" + (name ? ", supporter name saved" : "") : "no such account: that app hasn't synced yet");
    }
    // newer Stripe API versions put the subscription under parent.subscription_details
    const sub = o.subscription || o.parent?.subscription_details?.subscription || null;
    if (ev.type === "invoice.paid" && sub) {
      // every renewal: paid until the end of the period just billed (a month, or a year on the yearly link)
      const end = Math.max(...(o.lines?.data || []).map((l: any) => Number(l?.period?.end) || 0), now + 31 * 24 * 60 * 60);
      const ok = await markPaid(null, sub, o.customer || null, end + GRACE_S);
      // the first invoice can arrive before checkout.session.completed has said whose subscription it is:
      // answer 500 so Stripe sends it again in a few minutes, by when it's known (a yearly plan needs its year)
      if (!ok && o.billing_reason === "subscription_create") return answer(ev, 500, "not linked yet: Stripe sends it again");
      return answer(ev, 200, ok ? "renewed: paid until " + new Date((end + GRACE_S) * 1000).toISOString().slice(0, 10) : "renewal for a subscription no account has");
    }
  } catch (e) {
    return answer(ev, 500, "error: " + String((e as Error).message)); // Stripe retries
  }
  return answer(ev, 200, "ignored");
});
