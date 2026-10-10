/* The mini PC model's answers and memory, kept forgiving and small.
   - readAnswer: its final JSON, even when it's slightly off. Seen in testing: real line breaks inside
     the note string (gemma), and the whole text (an essay) written before an empty-note JSON (Holo4).
   - fitContext: keeps a long task (30-page forms run 60-90 steps) inside the model's context. When
     Ollama's context overflows it silently drops the OLDEST messages, the task itself among them, and
     the model then works on without knowing what it was asked (or its chat template refuses outright).
   No Electron here, so it can be tested on its own. */

// raw control characters inside JSON strings → escapes, so JSON.parse accepts them
function escapeInStrings(s) {
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      else if (ch === '\n') { out += '\\n'; continue; }
      else if (ch === '\r') continue;
      else if (ch === '\t') { out += '\\t'; continue; }
    } else if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

/* content → the answer object, or null when there's no JSON answer in it */
function readAnswer(content) {
  const text = String(content || '').replace(/```(?:json)?/gi, '');
  const at = text.indexOf('{"status"') >= 0 ? text.indexOf('{"status"') : text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (at < 0 || end <= at) return null;
  const j = text.slice(at, end + 1);
  let a = null;
  try { a = JSON.parse(j); } catch (e) { try { a = JSON.parse(escapeInStrings(j)); } catch (e2) { return null; } }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  // the real answer written out before the JSON, with the note left empty: use that text as the note
  // (minus a lead-in line like "Based on your notes, here's your essay:")
  const before = text.slice(0, at).trim().replace(/^[^\n]{0,160}:[ \t]*\n+/, '');
  if (!String(a.note || '').trim() && before.split(/\s+/).length >= 25) a.note = before;
  return a;
}

/* Its answer as plain text instead of JSON (Holo4 does this, often with the right answer): the retry is
   forced into this shape with Ollama's `format`, as a bare "reply with only the JSON" made it lose the
   thread ('{"answer":"(c)"}'). */
const ANSWER_SCHEMA = { type: 'object', properties: {
  status: { type: 'string', enum: ['done', 'needs-you'] }, note: { type: 'string' },
  options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, desc: { type: 'string' }, url: { type: 'string' } } } },
  site_tips: { type: 'array', items: { type: 'object', properties: { site: { type: 'string' }, tip: { type: 'string' } } } },
}, required: ['status', 'note'] };
const ASK_FOR_JSON = 'Now give that as the JSON answer only: {"status":"done" or "needs-you","note":"<the answer you just wrote, in full>","options":[],"site_tips":[]}';
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
/* the forced retry kept, but its note swapped for the plain-text answer when that said more */
function keepDraft(answer, draft) {
  if (answer && words(draft) >= 8 && words(answer.note) < words(draft) / 2) answer.note = String(draft).trim();
  return answer;
}

/* Options written into the note ("1. **Soundcore Space Q45** - $129.99 … https://…") but none in
   `options`: one per link, named by the bold text (or the line) it sits under. Up to 6. */
function optionsFromText(text) {
  const out = [], lines = String(text || '').split('\n');
  let label = '', desc = '';
  for (const line of lines) {
    const url = (line.match(/https:\/\/[^\s)"'<>\]]+/) || [])[0];
    const bold = (line.match(/\*\*([^*]{2,80})\*\*/) || [])[1];
    const rest = line.replace(/https:\/\/\S+/g, '').replace(/\*\*[^*]*\*\*/, '').replace(/^[\s\d.)*•-]+|[\s(:–-]+$/g, '').trim();
    if (bold) { label = bold.trim(); desc = rest.replace(/^[-–:]\s*/, ''); }
    if (!url || out.some((o) => o.url === url.replace(/[.,;]+$/, ''))) continue;
    out.push({ label: (label || rest || url).slice(0, 80), desc: (bold ? rest : label ? desc : '').slice(0, 200), url: url.replace(/[.,;]+$/, '') });
    label = ''; desc = '';
    if (out.length === 6) break;
  }
  return out;
}

/* Was this link on something it actually saw (search results, pages, the browser)? Holo4 suggested
   products with made-up links once it stopped finding them on the page. Exact match (ignoring www. and a
   trailing slash), or its host and its path both seen (pages often link with relative paths). */
function linkSeen(url, seen) {
  let u; try { u = new URL(String(url)); } catch (e) { return false; }
  const host = u.hostname.replace(/^www\./, ''), path = (u.pathname + u.search).replace(/\/$/, '');
  const text = String(seen || '').replace(/https?:\/\/(www\.)?/g, '');
  if (text.includes(host + path)) return true;
  // the browser's page view shortens links to 90 characters (agent/page-reader.js): the start must match
  return path.length >= 8 && text.includes(host) && text.includes(path.slice(0, 60));
}

const size = (m) => String(m.content || '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0) + 20;

/* Shrink the conversation in place so it fits `limit` characters (system prompt and tools included in
   `fixed`). messages[0] = system and messages[1] = the task are always kept. In order: older tool results
   get shortened to 300 characters (the latest `keepFull` stay whole), then to 80, then the oldest steps
   (a call and its results) are dropped, with a line saying how many went. */
function fitContext(messages, { keepFull = 1, limit = 44000, fixed = 0 } = {}) {
  const toolIdx = () => messages.map((m, i) => m.role === 'tool' ? i : -1).filter((i) => i >= 0);
  const total = () => fixed + messages.reduce((n, m) => n + size(m), 0);
  const shorten = (to) => toolIdx().slice(0, -keepFull || undefined).forEach((i) => {
    const c = String(messages[i].content);
    if (c.length > to + 30) messages[i].content = c.slice(0, to) + ' …(older result shortened)';
  });
  shorten(300);
  if (total() <= limit) return 0;
  shorten(80);
  let dropped = 0;
  const tag = /^\((\d+) earlier steps removed[^)]*\)\n/;
  const firstTool = messages.find((m, k) => k >= 2 && m.role === 'tool');
  const before = Number(((firstTool && String(firstTool.content).match(tag)) || [])[1] || 0); // from earlier calls
  // the oldest step after the task: an assistant turn plus the tool results that answer it
  while (total() > limit && messages.length > 4) {
    let i = 2; while (i < messages.length && messages[i].role !== 'assistant') i++;
    let j = i + 1; while (j < messages.length && messages[j].role === 'tool') j++;
    if (i >= messages.length - 2 || j >= messages.length) break; // never the latest step
    messages.splice(i, j - i); dropped++;
  }
  if (dropped) {
    const note = messages.find((m, k) => k >= 2 && m.role === 'tool');
    if (note) note.content = '(' + (dropped + before) + ' earlier steps removed to save memory; the page below shows where you are)\n' + String(note.content).replace(tag, '');
  }
  return dropped;
}

module.exports = { readAnswer, fitContext, escapeInStrings, ANSWER_SCHEMA, ASK_FOR_JSON, keepDraft, linkSeen, optionsFromText };
