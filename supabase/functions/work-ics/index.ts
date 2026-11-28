import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { makeStore } from "../_shared/sync-crypto.mjs";

// The Work list as a calendar feed for Outlook (one all-day or 30-minute event per open task with a due date).
// Outlook fetches a subscribe link with no auth headers, so access control is the secret token in the URL
// (verify_jwt is off for that reason); a Bearer header works too for anything that can send one.
// The token and the list's key live in the app_secrets table (row-level security, service role only),
// never in this file: rows work_ics_token and sync_key_work.

const BASE = Deno.env.get("SUPABASE_URL")!;
const SKEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: SKEY, Authorization: `Bearer ${SKEY}` };

async function loadSecrets(): Promise<Record<string, string>> {
  try {
    const r = await fetch(`${BASE}/rest/v1/app_secrets?select=name,value&name=in.(work_ics_token,sync_key_work)`, { headers: H });
    if (!r.ok) return {};
    return Object.fromEntries((await r.json()).map((s: { name: string; value: string }) => [s.name, s.value]));
  } catch { return {}; }
}
const SECRETS = await loadSecrets();
const FEED_TOKEN = SECRETS.work_ics_token || "";
// a function secret (SYNC_KEY_WORK, Edge Functions → Secrets) wins over the table: it keeps the key out of the
// database and its backups, which matters once the list is encrypted, since the key is what opens it
const WORK_SYNC_KEY = Deno.env.get("SYNC_KEY_WORK") || SECRETS.sync_key_work || "";

// the token compared in constant time, through a hash so lengths don't tell either
async function tokenOk(given: string | null): Promise<boolean> {
  if (!given || !FEED_TOKEN) return false;
  const [a, b] = await Promise.all([given, FEED_TOKEN].map((s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function pad(n: number) { return String(n).padStart(2, "0"); }
function esc(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^\d{1,2}:\d{2}$/;

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (!FEED_TOKEN || !WORK_SYNC_KEY) return new Response("Not configured: app_secrets needs work_ics_token and sync_key_work", { status: 503 });
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() || null;
  if (!(await tokenOk(bearer || url.searchParams.get("token")))) return new Response("Not found", { status: 404 });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

  // through the same sync_get function the app uses: the list key travels in the request body, never in the address,
  // so it stays out of the API gateway's request logs
  // A list the app has encrypted end to end is opened here with its own sync key (../_shared/sync-crypto.mjs); this feed only reads.
  const store = makeStore({
    get: async (key: string) => {
      const res = await fetch(`${BASE}/rest/v1/rpc/sync_get`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ p_sync_key: key }) });
      const rows = res.ok ? await res.json() : [];
      return rows.length && rows[0].updated_at ? { doc: rows[0].doc, updated_at: rows[0].updated_at } : null;
    },
    put: () => Promise.resolve(false),
  });
  let doc;
  // a list that can't be opened answers with an error: an empty calendar would look like "no tasks"
  try { doc = (await store.read(WORK_SYNC_KEY)).doc; }
  catch { return new Response("The Work list couldn't be opened with the key this feed has.", { status: 409 }); }
  const tasks = doc && Array.isArray(doc.tasks) ? doc.tasks : [];

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Tasks//work feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Work Tasks",
  ];
  const now = new Date();
  const dtstamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}00Z`;

  for (const t of tasks) {
    if (!t || t.done || !DATE.test(String(t.due || ""))) continue;
    const [y, m, d] = String(t.due).split("-").map(Number);
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${String(t.id || "").replace(/[^A-Za-z0-9_.-]/g, "_")}@tasks-work`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`SUMMARY:${esc(String(t.title || "Task")).slice(0, 500)}`);
    if (TIME.test(String(t.dueTime || ""))) {
      // floating local time: correct as long as home and office share a timezone
      const [h, mi] = String(t.dueTime).split(":").map(Number);
      const end = new Date(y, m - 1, d, h, mi + 30);
      lines.push(`DTSTART:${y}${pad(m)}${pad(d)}T${pad(h)}${pad(mi)}00`);
      lines.push(`DTEND:${end.getFullYear()}${pad(end.getMonth() + 1)}${pad(end.getDate())}T${pad(end.getHours())}${pad(end.getMinutes())}00`);
    } else {
      const end = new Date(y, m - 1, d + 1);
      lines.push(`DTSTART;VALUE=DATE:${y}${pad(m)}${pad(d)}`);
      lines.push(`DTEND;VALUE=DATE:${end.getFullYear()}${pad(end.getMonth() + 1)}${pad(end.getDate())}`);
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");

  return new Response(req.method === "HEAD" ? null : lines.join("\r\n"), {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "private, no-store" },
  });
});
