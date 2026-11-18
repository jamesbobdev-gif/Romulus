import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk@1.10.0";
import { CLOUD_PROMPT } from "./prompt.ts";

// Romulus cloud: answers one Agent task for a person whose own computers are all off (renderer/js/cloud-agent.js
// asks, after they opted in on that device). The account is the one their lists sync under on this project; its
// monthly allowance, the model and the limits are in the cloud_agent_* tables (supabase/migrations/20261120_cloud_agent.sql).
//
// What it keeps and what it doesn't:
// - The AI key is this function's own secret (ANTHROPIC_API_KEY, set in the dashboard under Edge Functions →
//   Secrets). It is not in this file, the repository, a table or the app, so publishing the code gives nothing away.
// - The task is held only in memory while it's answered: never written to a table, never logged.
// - The answer is sealed with a key only the asking device has (ECDH P-256 + AES-GCM, the device's one-time public key
//   comes with the task), kept until that device picks it up, then deleted. Unclaimed ones go after 2 days.
// - Finance, the Locked profile and tasks with private words never get here: the app doesn't send them.
//
// POST {action: 'status', syncKey}                          → {enabled, plan, used, limit}
// POST {action: 'start', syncKey, pub, task, prefs, today}  → {ok, job, used, limit} | {ok: false, why}
// POST {action: 'take', syncKey, job}                       → {state: 'working'|'done'|'failed'|'gone', sealed?, why?}
// syncKey is the lookup id the device already syncs under (the server never sees the real key).

const BASE = Deno.env.get("SUPABASE_URL")!;
const SKEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AI_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const H = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, "Content-Type": "application/json" };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// list prices in dollars per million tokens, and per web search, to count what each task cost (for the limits;
// Anthropic's bill is the real number). A model not listed here is counted at the Opus price.
const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
};
const SEARCH_CENTS = 1; // $10 per 1,000 searches
const RUN_MS = 330 * 1000; // the function may live 400 s on this plan: stop in time to save the answer

async function rpc(fn: string, args: Record<string, unknown>) {
  const r = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: "POST", headers: H, body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status}`);
  return r.json();
}
const okKey = (k: unknown) => typeof k === "string" && /^tk_[A-Za-z0-9_-]{20,120}$/.test(k);
const okJob = (j: unknown) => typeof j === "string" && /^[0-9a-f-]{36}$/.test(j);
async function ipHash(req: Request): Promise<string | null> {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
  if (!ip) return null;
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("romulus-cloud|" + ip));
  return Array.from(new Uint8Array(d).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── the task, as the app sends it ─────────────────────────────────────────
type Turn = { who: string; text: string };
type Task = { title: string; notes: string; reply: string; history: Turn[] };
const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);
function cleanTask(t: any): Task | null {
  if (!t || typeof t !== "object") return null;
  const title = clip(t.title, 500).trim();
  if (!title) return null;
  const history = (Array.isArray(t.history) ? t.history : []).slice(-20)
    .map((h: any) => ({ who: h && h.who === "you" ? "you" : "assistant", text: clip(h && h.text, 3000) }))
    .filter((h: Turn) => h.text.trim());
  return { title, notes: clip(t.notes, 4000), reply: clip(t.reply, 3000), history };
}
function taskText(t: Task, prefs: string, today: string): string {
  const parts = [`Today is ${today}.`];
  if (prefs.trim()) parts.push(`What they've told the app about themselves (use it where it helps):\n${prefs}`);
  parts.push(`The task: ${t.title}`);
  if (t.notes.trim()) parts.push(`Their notes on it:\n${t.notes}`);
  if (t.history.length) parts.push("The conversation on this task so far, oldest first:\n" +
    t.history.map((h) => `${h.who === "you" ? "They" : "You"}: ${h.text}`).join("\n\n"));
  if (t.reply.trim()) parts.push(`Their latest reply, which you're answering now:\n${t.reply}`);
  return parts.join("\n\n");
}

// the JSON object at the end of the answer → {status, note, options}; without one, the whole text is the note
function readAnswer(text: string) {
  const s = text.trim();
  const at = s.lastIndexOf('{"status"');
  if (at >= 0) {
    try {
      const o = JSON.parse(s.slice(at).replace(/```\s*$/, "").trim());
      const options = (Array.isArray(o.options) ? o.options : []).slice(0, 6)
        .map((x: any) => ({ label: clip(x && x.label, 80), desc: clip(x && x.desc, 200), url: /^https:\/\//i.test(String(x && x.url)) ? clip(x.url, 2000) : undefined }))
        .filter((x: { label: string }) => x.label);
      const note = clip(o.note, 6000).trim();
      if (note) return { status: o.status === "done" ? "done" : "needs-you", note, options };
    } catch { /* not valid JSON: fall through */ }
  }
  const note = s.replace(/```(json)?[\s\S]*$/, "").trim().slice(0, 6000);
  return note ? { status: "needs-you", note, options: [] } : null;
}

// ── sealing for the asking device ─────────────────────────────────────────
// the same steps as cloudAgOpen in renderer/js/cloud-agent.js, the other way round
async function seal(pub: JsonWebKey, data: unknown) {
  const theirs = await crypto.subtle.importKey("jwk", pub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const mine = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "ECDH", public: theirs }, mine.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data))));
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  const epk = await crypto.subtle.exportKey("jwk", mine.publicKey);
  return { v: 1, epk: { kty: epk.kty, crv: epk.crv, x: epk.x, y: epk.y }, iv: b64(iv), ct: b64(ct) };
}
const okPub = (p: any) => p && p.kty === "EC" && p.crv === "P-256" && typeof p.x === "string" && typeof p.y === "string" && !p.d;

// ── one task, start to finish ─────────────────────────────────────────────
async function answer(job: string, pub: JsonWebKey, task: Task, prefs: string, today: string, cfg: any) {
  let cents = 0;
  try {
    const client = new Anthropic({ apiKey: AI_KEY, timeout: RUN_MS, maxRetries: 1 });
    const model = String(cfg.model || "claude-opus-5-5");
    const price = PRICES[model] || PRICES["claude-opus-5-5"];
    const capCents = Number(cfg.task_cents) || 60;
    const started = Date.now();
    // deno-lint-ignore no-explicit-any
    const messages: any[] = [{ role: "user", content: taskText(task, prefs, today) }];
    let text = "";
    for (let turn = 0; turn < 5; turn++) {
      const left = RUN_MS - (Date.now() - started);
      if (left < 20 * 1000) break;
      // deno-lint-ignore no-explicit-any
      const params: any = {
        model, max_tokens: 16000, system: CLOUD_PROMPT, messages,
        output_config: { effort: String(cfg.effort || "medium") },
        tools: [
          { type: "web_search_20260209", name: "web_search", max_uses: 8 },
          { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8, max_content_tokens: 20000 },
        ],
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default", // a request one model declines is retried on the one Anthropic picks for it
      };
      const msg = await client.beta.messages.stream(params, { timeout: left }).finalMessage();
      const u: any = msg.usage || {};
      cents += ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)) * price.in / 1e4
        + (u.cache_read_input_tokens || 0) * price.in / 1e5
        + (u.output_tokens || 0) * price.out / 1e4
        + ((u.server_tool_use && u.server_tool_use.web_search_requests) || 0) * SEARCH_CENTS;
      if (msg.stop_reason === "refusal") throw new Error("The AI wouldn’t answer this one. Try wording it differently.");
      text = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      if (msg.stop_reason !== "pause_turn") break;
      if (cents >= capCents) break; // long enough: answer with what it has
      // resume: the question and everything it has done so far, nothing added (the server picks up where it paused)
      if (messages.length > 1) messages[1] = { role: "assistant", content: messages[1].content.concat(msg.content) };
      else messages.push({ role: "assistant", content: msg.content });
    }
    const a = readAnswer(text);
    if (!a) throw new Error("No answer came back. Try again.");
    await rpc("cloud_agent_finish", { p_job: job, p_sealed: await seal(pub, a), p_why: null, p_cents: Math.round(cents * 100) / 100 });
  } catch (e) {
    const why = e instanceof Anthropic.APIError
      ? (e.status === 429 || (e.status || 0) >= 500 ? "Romulus cloud is busy right now. Try again in a few minutes." : "Romulus cloud couldn’t ask the AI (HTTP " + e.status + ").")
      : String((e as Error).message || e).slice(0, 200);
    console.error("cloud-agent job failed:", e instanceof Anthropic.APIError ? `HTTP ${e.status}` : (e as Error).name); // never the task
    await rpc("cloud_agent_finish", { p_job: job, p_sealed: null, p_why: why, p_cents: Math.round(cents * 100) / 100 }).catch(() => {});
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  if (!b || !okKey(b.syncKey)) return json({ error: "bad request" }, 400);
  try {
    if (b.action === "status") {
      const s = await rpc("cloud_agent_status", { p_sync_key: b.syncKey });
      return json({ enabled: !!s.enabled && !!AI_KEY, plan: s.plan || null, used: s.used || 0, limit: s.limit || 0 });
    }
    if (b.action === "take") {
      if (!okJob(b.job)) return json({ error: "bad request" }, 400);
      return json(await rpc("cloud_agent_take", { p_sync_key: b.syncKey, p_job: b.job }));
    }
    if (b.action === "start") {
      const task = cleanTask(b.task);
      if (!task || !okPub(b.pub)) return json({ error: "bad request" }, 400);
      if (!AI_KEY) return json({ ok: false, why: "off" });
      const r = await rpc("cloud_agent_start", { p_sync_key: b.syncKey, p_ip_hash: await ipHash(req) });
      if (!r.ok) return json({ ok: false, why: r.why, used: r.used, limit: r.limit });
      const today = clip(b.today, 80) || new Date().toUTCString();
      EdgeRuntime.waitUntil(answer(r.job, b.pub, task, clip(b.prefs, 6000), today, r));
      return json({ ok: true, job: r.job, used: r.used, limit: r.limit });
    }
    return json({ error: "bad request" }, 400);
  } catch (e) {
    console.error("cloud-agent:", (e as Error).message);
    return json({ error: "server" }, 500);
  }
});
