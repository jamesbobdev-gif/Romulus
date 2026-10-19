/* How much of each cloud AI is used up, for the usage bars in Settings → AI connections.
   Claude: the real 5-hour and weekly percentages Claude Code reports (rate_limit_event in stream-json).
   Gemini: calls per Google day (midnight Pacific); its daily limit is learned from the 429 that says so.
   ChatGPT, OpenRouter, Grok, Groq: calls and tokens this month (OpenRouter's credit comes from its /key check).
   Kept in userData/ai-usage.json on this computer only. No Electron here, so it can be tested on its own. */
const fs = require('fs');
const path = require('path');

let ctx = null; // { userData }
let mem = null;
function init(c) { ctx = c; mem = null; }
const file = () => path.join(ctx.userData(), 'ai-usage.json');
function load() {
  if (mem) return mem;
  mem = {};
  if (ctx) try { mem = JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; } catch (e) {}
  return mem;
}
function save() { if (ctx) try { fs.writeFileSync(file(), JSON.stringify(mem)); } catch (e) {} }

// Google's quotas reset at midnight Pacific
const pacificDay = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(now || Date.now()));
function nextPacificMidnight(now) {
  now = now || Date.now();
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23',
    hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(now)).map((x) => [x.type, Number(x.value)]));
  return now + (86400 - (p.hour * 3600 + p.minute * 60 + p.second)) * 1000;
}
const month = (now) => { const d = new Date(now || Date.now()); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };

/* Claude Code's rate_limit_info: {status, resetsAt, unifiedWindows: {five_hour: {utilization, resetsAt}, seven_day: {...}}} */
function noteClaude(info, now) {
  if (!info || typeof info !== 'object') return;
  const w = info.unifiedWindows || {};
  const win = (x) => x && typeof x.utilization === 'number' ? { used: x.utilization, resetsAt: x.resetsAt ? x.resetsAt * 1000 : null } : null;
  const m = load();
  m.claude = { at: now || Date.now(), five: win(w.five_hour), week: win(w.seven_day),
    out: info.status === 'rejected' ? (info.resetsAt ? info.resetsAt * 1000 : null) || true : false };
  save();
}
// a stream-json run's output → the final answer text, noting the usage it reported on the way
function readClaudeStream(out) {
  let text = '', rate = null;
  for (const line of String(out || '').split('\n')) {
    let j; try { j = JSON.parse(line); } catch (e) { continue; }
    if (j.type === 'rate_limit_event') rate = j.rate_limit_info;
    else if (j.type === 'result' || (j.result != null && !j.type)) text = String(j.result || '');
  }
  if (rate) noteClaude(rate);
  return text;
}

// a Gemini 429's details → the per-day request limit it hit, if that's what it was
function geminiDailyLimit(err) {
  for (const d of (err && Array.isArray(err.details) ? err.details : []))
    for (const v of (Array.isArray(d.violations) ? d.violations : []))
      if (/PerDay/i.test(String(v.quotaId || v.quotaMetric || '')) && Number(v.quotaValue) > 0) return Number(v.quotaValue);
  return null;
}
/* one call to a cloud AI: {tokens, limited, perDay (Gemini's daily limit, when a 429 named it)} */
function noteCall(id, r, now) {
  now = now || Date.now();
  r = r || {};
  const m = load();
  if (id === 'gemini') {
    const day = pacificDay(now);
    const g = m.gemini && m.gemini.day === day ? m.gemini : { day, calls: 0, tokens: 0, perDay: m.gemini && m.gemini.perDay || null };
    if (!r.limited) { g.calls++; g.tokens += r.tokens || 0; }
    if (r.perDay) { g.perDay = r.perDay; g.out = nextPacificMidnight(now); } // out for the day: back at midnight Pacific
    else if (r.limited) g.out = now + 60 * 1000; // a per-minute limit: back shortly
    m.gemini = g;
  } else if (id && id !== 'claude') {
    const mo = month(now);
    const o = m[id] && m[id].month === mo ? m[id] : { month: mo, calls: 0, tokens: 0, credit: m[id] && m[id].credit };
    if (!r.limited) { o.calls++; o.tokens += r.tokens || 0; }
    m[id] = o;
  } else return;
  save();
}
/* ChatGPT plan's Codex limits (see providers.codexLimits): each window {used 0..1, mins, resetsAt ms} */
function noteCodex(r, now) {
  if (!r) return;
  const win = (w) => w && typeof w.usedPercent === 'number' ? { used: w.usedPercent / 100, mins: w.windowDurationMins || null, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null } : null;
  const m = load();
  m.codex = { at: now || Date.now(), primary: win(r.primary), secondary: win(r.secondary), reached: !!r.reached, plan: r.plan || null };
  save();
}
function noteCredit(usage, limit, now) { // OpenRouter's /key: dollars used, and the key's limit if it has one
  const m = load();
  m.openrouter = Object.assign({ month: month(now), calls: 0, tokens: 0 }, m.openrouter, { credit: { usage, limit, at: now || Date.now() } });
  save();
}

/* what the bars show: per AI {pct (0..1, or null when there's no limit to measure against), text, out} */
function snapshot(now) {
  now = now || Date.now();
  const m = load(), res = {};
  const fmtT = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
  const c = m.claude;
  if (c) {
    const live = (w) => w && (!w.resetsAt || w.resetsAt > now) ? w : null; // a window that's reset since reads as empty
    const five = live(c.five), week = live(c.week);
    res.claude = { pct: five ? five.used : 0, week: week ? week.used : 0, fiveReset: five && five.resetsAt, weekReset: week && week.resetsAt,
      out: c.out && (c.out === true || c.out > now) ? c.out : false, at: c.at };
  }
  const g = m.gemini && m.gemini.day === pacificDay(now) ? m.gemini : { calls: 0, tokens: 0, perDay: m.gemini && m.gemini.perDay };
  res.gemini = { calls: g.calls, tokens: g.tokens, perDay: g.perDay || null, pct: g.perDay ? Math.min(1, g.calls / g.perDay) : null,
    out: g.out && g.out > now ? g.out : false };
  for (const id of [...new Set(['openai', 'openrouter', ...Object.keys(m).filter((k) => k !== 'claude' && k !== 'gemini')])]) {
    const o = m[id] && m[id].month === month(now) ? m[id] : { calls: 0, tokens: 0, credit: m[id] && m[id].credit };
    res[id] = { calls: o.calls, tokens: o.tokens, tokensText: fmtT(o.tokens), pct: null };
    if (id === 'openrouter' && o.credit) {
      res[id].credit = o.credit;
      if (o.credit.limit) res[id].pct = Math.min(1, (o.credit.usage || 0) / o.credit.limit);
    }
  }
  if (m.codex) { // his ChatGPT plan's real limit windows; one that's reset since reads as empty
    const live = (w) => w && (!w.resetsAt || w.resetsAt > now) ? w : (w ? Object.assign({}, w, { used: 0, resetsAt: null }) : null);
    const wins = [live(m.codex.primary), live(m.codex.secondary)].filter(Boolean);
    const full = wins.find((w) => w.used >= 1);
    res.openai.plan = { windows: wins, name: m.codex.plan, at: m.codex.at,
      out: m.codex.reached || full ? (full && full.resetsAt) || true : false };
  }
  res.gemini.tokensText = fmtT(res.gemini.tokens);
  return res;
}
const claudeCheckedAt = () => (load().claude || {}).at || 0;
const codexCheckedAt = () => (load().codex || {}).at || 0;

module.exports = { init, noteClaude, readClaudeStream, geminiDailyLimit, noteCall, noteCredit, noteCodex, snapshot, claudeCheckedAt, codexCheckedAt, pacificDay, nextPacificMidnight };
