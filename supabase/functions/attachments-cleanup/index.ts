import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Deletes agent-attachments files (photos on Agent tasks, the agent's "I'm stuck" screenshots) once they are
// KEEP_DAYS old. The bucket is public, so a screenshot of an order or account page should not stay up for
// good. The desktop app calls this about once a day (agent/supabase.js cleanupAttachments); storage.objects refuses
// plain SQL deletes, so it goes through the Storage API with the service role. It only ever removes files
// past their age, so anyone calling it early or often changes nothing: no auth needed.

// Both public buckets: photos on tasks, and the local model's downloads (agent-files), which are worksheets nobody
// needs a month on.
const KEEP_DAYS = 30;
const BUCKETS = ["agent-attachments", "agent-files"];
const MAX_PER_RUN = 1000;
const MIN_GAP_MS = 10 * 60 * 1000; // listing every folder is the costly part: at most once in ten minutes per instance
let lastRun = 0;

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  if (Date.now() - lastRun < MIN_GAP_MS) return Response.json({ ok: true, removed: 0, keepDays: KEEP_DAYS, throttled: true });
  lastRun = Date.now();
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const BUCKET of BUCKETS) {
  const old: string[] = [];
  // the bucket holds one folder per agent key (tk_agent_att_…), the files inside it. Folders are listed page by
  // page: on a shared project there can be more than one page of them, and the ones past it would never be cleaned
  const folders: { id: string | null; name: string }[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db.storage.from(BUCKET).list("", { limit: 1000, offset: off });
    if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
    folders.push(...(data || []));
    if (!data || data.length < 1000 || folders.length >= 20000) break;
  }
  for (const f of folders) {
    if (old.length >= MAX_PER_RUN) break;
    if (f.id) continue; // a file at the top level: not one the app writes
    let offset = 0;
    while (old.length < MAX_PER_RUN) {
      const { data: files } = await db.storage.from(BUCKET).list(f.name, { limit: 1000, offset, sortBy: { column: "created_at", order: "asc" } });
      if (!files || !files.length) break;
      for (const x of files) {
        if (x.id && x.created_at && Date.parse(x.created_at) < cutoff) old.push(f.name + "/" + x.name);
      }
      if (files.length < 1000) break;
      offset += files.length;
    }
  }
  const batch = old.slice(0, MAX_PER_RUN);
  for (let i = 0; i < batch.length; i += 100) {
    const { data } = await db.storage.from(BUCKET).remove(batch.slice(i, i + 100));
    removed += (data || []).length;
  }
  }
  return Response.json({ ok: true, removed, keepDays: KEEP_DAYS });
});
