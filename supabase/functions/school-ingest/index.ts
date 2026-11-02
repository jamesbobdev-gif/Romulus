import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Weekly LMS deadline ingester. Reads course calendar feeds (Blackboard .ics, D2L .ics) and ADDS new
// assignment deadlines to the School list. It never edits or deletes existing tasks, and it respects
// tombstones (a deadline you deleted is not re-added). Each task's id is derived from the feed UID, so
// re-runs never duplicate.
//
//   POST with Authorization: Bearer <token>   -> commit (writes new tasks)
//   …?dry=1                                   -> dry run (reports what it would add, no write)
//   (?token=<token> in the URL still works for an older scheduler.) Anything without the token 404s.
//
// The token, the School list's key and the feed links live in the app_secrets table (row-level security,
// service role only), never in this file: rows school_ingest_token, sync_key_school and school_feeds
// (a JSON list: [{"src":"bb","name":"CSU Blackboard","url":"https://…/learn.ics","onlyDue":false}, …]).
// A course feed link is a secret too: whoever has it sees the whole course calendar.

const BASE = Deno.env.get("SUPABASE_URL")!;
const SKEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const H = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, "Content-Type": "application/json" };

async function loadSecrets(): Promise<Record<string, string>> {
  try {
    const r = await fetch(`${BASE}/rest/v1/app_secrets?select=name,value&name=in.(school_ingest_token,sync_key_school,school_feeds)`, { headers: H });
    if (!r.ok) return {};
    return Object.fromEntries((await r.json()).map((s: { name: string; value: string }) => [s.name, s.value]));
  } catch { return {}; }
}
const SECRETS = await loadSecrets();
const INGEST_TOKEN = SECRETS.school_ingest_token || "";
const SCHOOL_KEY = SECRETS.sync_key_school || "";

type Feed = { src: string; name: string; url: string; onlyDue: boolean };
function loadFeeds(): Feed[] {
  try {
    const list = JSON.parse(SECRETS.school_feeds || "[]");
    if (!Array.isArray(list)) return [];
    return list.filter((f) => f && typeof f.url === "string" && /^https:\/\//i.test(f.url) && typeof f.src === "string")
      .map((f) => ({ src: String(f.src).replace(/[^a-z0-9]/gi, "").slice(0, 12) || "feed", name: String(f.name || f.src).slice(0, 60), url: f.url, onlyDue: !!f.onlyDue }))
      .slice(0, 10);
  } catch { return []; }
}
const FEEDS = loadFeeds();

// the token compared in constant time, through a hash so lengths don't tell either
async function tokenOk(given: string | null): Promise<boolean> {
  if (!given || !INGEST_TOKEN) return false;
  const [a, b] = await Promise.all([given, INGEST_TOKEN].map((s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ── ics parsing ────────────────────────────────────────────────────────────
const MAX_ICS = 2 * 1024 * 1024; // a course calendar is a few hundred KB at most
function unfold(ics: string): string[] {
  // RFC5545 line folding: a line starting with space/tab continues the prior.
  const raw = ics.split(/\r?\n/);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else out.push(line);
  }
  return out;
}
function unesc(s: string): string {
  return s.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}
type Ev = { uid: string; summary: string; date: string };
function parse(ics: string): Ev[] {
  const lines = unfold(ics);
  const evs: Ev[] = [];
  let cur: Partial<Ev> | null = null;
  for (const ln of lines) {
    if (ln === "BEGIN:VEVENT") cur = {};
    else if (ln === "END:VEVENT") {
      if (cur && cur.uid && cur.summary && cur.date) evs.push(cur as Ev);
      cur = null;
    } else if (cur) {
      const c = ln.indexOf(":");
      if (c < 0) continue; // a stray line spoils that line, not the whole feed
      const key = ln.slice(0, c);
      const val = ln.slice(c + 1);
      if (key === "UID") cur.uid = val.trim().slice(0, 200);
      else if (key === "SUMMARY") cur.summary = unesc(val).slice(0, 300);
      else if (key.startsWith("DTSTART")) {
        const d = val.replace(/[^0-9]/g, "").slice(0, 8);
        if (d.length === 8) cur.date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      }
    }
  }
  return evs;
}

// Pull a class code like "PHYS 1010", "ENT 315", "ACT 222" from a title.
function classCode(s: string): string | null {
  const m = s.match(/\b([A-Z]{2,4})[ -]?(\d{3,4})\b/);
  return m ? `${m[1]} ${m[2]}` : null;
}
function cleanTitle(s: string): string {
  return s.replace(/\s*-\s*(Due|Availability Ends|Available|Ends|Starts|Start)\s*$/i, "").trim();
}
function isExam(s: string): boolean {
  return /\b(exam|test|midterm|final)\b/i.test(s);
}
function todayStr(): string {
  const d = new Date();
  // America/New_York-ish: the feeds are Eastern; a date-only compare is fine.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

class UserError extends Error {}

// ── storage (compare-and-swap, mirrors tasks-mcp) ───────────────────────────
async function load() {
  const r = await fetch(
    `${BASE}/rest/v1/tasks_sync?sync_key=eq.${encodeURIComponent(SCHOOL_KEY)}&select=doc,updated_at`,
    { headers: H },
  );
  if (!r.ok) throw new Error(`load: HTTP ${r.status}`);
  const rows = await r.json();
  const doc = rows.length ? rows[0].doc : null;
  // the app moved this list to end-to-end encryption and left a marker under the old key: writing a plain list
  // over it would destroy the marker and never reach the real (sealed) list
  if (doc && doc.moved === "v2") throw new UserError("The School list is end-to-end encrypted on the devices; this server can't read or change it.");
  return {
    doc: {
      v: 1,
      tasks: doc && Array.isArray(doc.tasks) ? doc.tasks : [],
      tombstones: doc && Array.isArray(doc.tombstones) ? doc.tombstones : [],
    },
    updated_at: rows.length ? rows[0].updated_at : null,
  };
}
// deno-lint-ignore no-explicit-any
async function save(row: any): Promise<boolean> {
  const body = { doc: row.doc, updated_at: new Date().toISOString() };
  if (row.updated_at === null) {
    const r = await fetch(`${BASE}/rest/v1/tasks_sync`, {
      method: "POST",
      headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify([{ sync_key: SCHOOL_KEY, ...body }]),
    });
    if (r.status === 409) return false;
    if (!r.ok) throw new Error(`save: HTTP ${r.status}`);
    return true;
  }
  const r = await fetch(
    `${BASE}/rest/v1/tasks_sync?sync_key=eq.${encodeURIComponent(SCHOOL_KEY)}&updated_at=eq.${encodeURIComponent(row.updated_at)}`,
    { method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(body) },
  );
  if (!r.ok) throw new Error(`save: HTTP ${r.status}`);
  return (await r.json()).length === 1;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!INGEST_TOKEN || !SCHOOL_KEY) return new Response("Not configured: app_secrets needs school_ingest_token, sync_key_school and school_feeds", { status: 503 });
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() || null;
  if (!(await tokenOk(bearer || url.searchParams.get("token")))) return new Response("Not found", { status: 404 });
  const dry = url.searchParams.get("dry") === "1";
  const today = todayStr();

  // 1. gather candidate deadlines from every feed
  const candidates: { id: string; title: string; due: string; tag: string | null; kind: string; feed: string }[] = [];
  // deno-lint-ignore no-explicit-any
  const feedReport: any[] = [];
  for (const f of FEEDS) {
    try {
      const res = await fetch(f.url, { headers: { "User-Agent": "tasks-school-ingest/1" }, redirect: "error", signal: AbortSignal.timeout(20000) });
      if (!res.ok) { feedReport.push({ feed: f.name, error: `HTTP ${res.status}` }); continue; }
      const text = await res.text();
      if (text.length > MAX_ICS) { feedReport.push({ feed: f.name, error: "feed too large" }); continue; }
      const evs = parse(text);
      let kept = 0;
      for (const e of evs) {
        if (f.onlyDue && !/-\s*(Due|Availability Ends)\s*$/i.test(e.summary)) continue;
        if (e.date < today) continue; // only upcoming
        const id = `${f.src}-${e.uid.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
        candidates.push({
          id,
          title: cleanTitle(e.summary),
          due: e.date,
          tag: classCode(e.summary),
          kind: isExam(e.summary) ? "exam" : "regular",
          feed: f.name,
        });
        kept++;
        if (candidates.length >= 500) break;
      }
      feedReport.push({ feed: f.name, events: evs.length, upcomingKept: kept });
    } catch (err) {
      feedReport.push({ feed: f.name, error: String((err as Error).message) });
    }
  }

  // 2. CAS add only the genuinely-new ones
  // deno-lint-ignore no-explicit-any
  let added: any[] = [];
  let skipped = 0;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await load();
      // deno-lint-ignore no-explicit-any
      const haveTask = new Set(row.doc.tasks.map((t: any) => t.id));
      // deno-lint-ignore no-explicit-any
      const haveTomb = new Set(row.doc.tombstones.map((t: any) => t.id));
      // deno-lint-ignore no-explicit-any
      const toAdd: any[] = [];
      added = [];
      skipped = 0;
      for (const c of candidates) {
        if (haveTask.has(c.id) || haveTomb.has(c.id)) { skipped++; continue; }
        const now = Date.now();
        toAdd.push({
          id: c.id, title: c.title, done: false, due: c.due, dueTime: null,
          tag: c.tag, kind: c.kind, notes: null, subs: [], googleEventId: null,
          created: now, updatedAt: now,
        });
        added.push({ title: c.title, due: c.due, tag: c.tag, kind: c.kind, feed: c.feed });
      }
      if (dry) break;            // dry run: never write
      if (!toAdd.length) break;  // nothing new
      row.doc.tasks = row.doc.tasks.concat(toAdd);
      if (await save(row)) break;
      if (attempt === 4) return new Response(JSON.stringify({ error: "list kept changing; try again" }), { status: 503 });
    }
  } catch (e) {
    if (e instanceof UserError) return new Response(JSON.stringify({ error: e.message }), { status: 409, headers: { "Content-Type": "application/json" } });
    throw e;
  }

  return new Response(
    JSON.stringify({ mode: dry ? "dry-run (nothing written)" : "committed", today, feeds: feedReport, wouldAddOrAdded: added.length, skippedAlreadyPresent: skipped, items: added }, null, 2),
    { headers: { "Content-Type": "application/json" } },
  );
});
