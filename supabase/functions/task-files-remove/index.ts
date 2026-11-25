import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Removes photos and files from tasks (renderer/js/task-files.js) in the task-files bucket. The app's key may
// upload there but not list or delete (supabase/migrations/20261109_task_files.sql), so nobody can remove
// someone else's files: this function takes the sync key, works out its account the way the database does
// (sync_account_of: sha256 of the key's id part), and removes only files in that account's folder.
// Deploy with JWT verification off (the app sends its publishable key, not a user token).
// body: { key: "tk_…", paths: ["acct_<account>/<name>", …] } → { ok, removed }

const BASE = Deno.env.get("SUPABASE_URL")!;
const SKEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(BASE, SKEY);
const KEY = /^tk_[A-Za-z0-9_-]{13,}(:[a-z-]+)?$/;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
// the folder of the account a sync key belongs to (the same as sync_account_of in supabase/setup.sql)
export async function accountFolder(key: string): Promise<string> {
  const id = key.replace(/^tk_(work_|agent_|school_)?/, "").replace(/:.*$/, "");
  return "acct_" + hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)));
}
// the paths of a request that are in that folder, as single files (no "..", no sub-folders)
export function ownPaths(folder: string, paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  return paths.filter((p): p is string => typeof p === "string" && p.startsWith(folder + "/") && /^[A-Za-z0-9_-]+$/.test(p.slice(folder.length + 1))).slice(0, 50);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "bad body" }, { status: 400, headers: CORS }); }
  const key = typeof body?.key === "string" && KEY.test(body.key) ? body.key : "";
  if (!key) return Response.json({ ok: false, error: "no sync key" }, { status: 400, headers: CORS });
  const paths = ownPaths(await accountFolder(key), body?.paths);
  if (!paths.length) return Response.json({ ok: true, removed: 0 }, { headers: CORS });
  const { data, error } = await db.storage.from("task-files").remove(paths);
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500, headers: CORS });
  return Response.json({ ok: true, removed: (data || []).length }, { headers: CORS });
});
