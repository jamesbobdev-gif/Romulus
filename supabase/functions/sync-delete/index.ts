import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// "Delete my synced data" (Settings → Device sync, renderer/js/hosted-sync.js hostedDeleteAll). The app sends the
// sync keys it holds; knowing a key is what lets anyone read or write those lists, so it is also what lets them
// be deleted here, as everywhere else in sync. For each key this removes every row of its account
// (sync_delete_account, supabase/migrations/20261106_sync_delete_account.sql), cancels the account's $5 plan at
// Stripe when it had one, and empties the account's folder in the two storage buckets (photos on Agent tasks,
// the local model's downloads): storage.objects refuses plain SQL deletes, so that goes through the Storage API.
// Deploy with JWT verification off (the app's publishable key isn't a JWT): the keys in the body are the check.
// Stripe needs the app_secrets row stripe_api_key (a restricted key with Subscriptions: write is enough); without
// it the reply says cancelled: false and the app tells the person to cancel from their Stripe receipt.

const BASE = Deno.env.get("SUPABASE_URL")!;
const SKEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(BASE, SKEY);
const KEY = /^tk_[A-Za-z0-9_-]{13,}$/;
const BUCKETS = ["agent-attachments", "agent-files"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
// the same folder name as renderer/js/agent-chat.js attachFolder and agent/worker-files.js folderFor
export async function folderFor(agentKey: string): Promise<string> {
  return "tk_agent_att_" + hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(agentKey))).slice(0, 40);
}

// the account's folder in task-files, photos and files on any task (supabase/functions/task-files-remove)
export async function accountFolder(key: string): Promise<string> {
  const id = key.replace(/^tk_(work_|agent_|school_)?/, "").replace(/:.*$/, "");
  return "acct_" + hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)));
}

async function stripeKey(): Promise<string> {
  const { data } = await db.from("app_secrets").select("value").eq("name", "stripe_api_key").maybeSingle();
  return data?.value || "";
}
async function cancelAtStripe(sub: string): Promise<boolean> {
  const k = await stripeKey();
  if (!k) return false;
  const r = await fetch("https://api.stripe.com/v1/subscriptions/" + encodeURIComponent(sub), {
    method: "DELETE",
    headers: { Authorization: "Bearer " + k },
  });
  // already cancelled (404 / resource_missing) counts as done
  return r.ok || r.status === 404;
}
async function emptyFolder(bucket: string, folder: string): Promise<number> {
  let removed = 0;
  for (let round = 0; round < 50; round++) {
    const { data: files, error } = await db.storage.from(bucket).list(folder, { limit: 100 });
    if (error || !files || !files.length) break;
    const { data } = await db.storage.from(bucket).remove(files.map((f) => folder + "/" + f.name));
    removed += (data || []).length;
    if (!data || !data.length) break; // nothing went: don't loop on it
  }
  return removed;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "bad body" }, { status: 400, headers: CORS }); }
  const keys: string[] = Array.isArray(body?.keys) ? body.keys.filter((k: unknown) => typeof k === "string" && KEY.test(k)).slice(0, 8) : [];
  const agentKeys: string[] = Array.isArray(body?.agentKeys) ? body.agentKeys.filter((k: unknown) => typeof k === "string" && KEY.test(k)).slice(0, 4) : [];
  if (!keys.length) return Response.json({ ok: false, error: "no sync key" }, { status: 400, headers: CORS });

  let rows = 0, files = 0, cancelled = true;
  const subs = new Set<string>();
  for (const k of keys) {
    const { data, error } = await db.rpc("sync_delete_account", { p_sync_key: k });
    if (error) return Response.json({ ok: false, error: error.message }, { status: 500, headers: CORS });
    for (const r of data || []) {
      rows += Number(r.rows_deleted) || 0;
      if (r.stripe_subscription) subs.add(r.stripe_subscription);
    }
  }
  for (const s of subs) cancelled = (await cancelAtStripe(s)) && cancelled;
  const folders = new Set<string>();
  for (const k of keys) folders.add(await accountFolder(k));
  for (const f of folders) files += await emptyFolder("task-files", f);
  for (const k of agentKeys) {
    const folder = await folderFor(k);
    for (const b of BUCKETS) files += await emptyFolder(b, folder);
  }
  return Response.json({ ok: true, rows, files, paid: subs.size > 0, cancelled: subs.size ? cancelled : true }, { headers: CORS });
});
