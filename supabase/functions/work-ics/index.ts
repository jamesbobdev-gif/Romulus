import "jsr:@supabase/functions-js/edge-runtime.d.ts";

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
const WORK_SYNC_KEY = SECRETS.sync_key_work || "";

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

  const res = await fetch(
    `${BASE}/rest/v1/tasks_sync?sync_key=eq.${encodeURIComponent(WORK_SYNC_KEY)}&select=doc`,
    { headers: H },
  );
  const rows = res.ok ? await res.json() : [];
  const doc = rows.length ? rows[0].doc : null;
  // the app moved this list to end-to-end encryption: this server can't read it any more, and an empty calendar
  // would look like "no tasks" rather than "can't read"
  if (doc && doc.moved === "v2") return new Response("The Work list is end-to-end encrypted on the devices; this feed can't read it.", { status: 409 });
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
