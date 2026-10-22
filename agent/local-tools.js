/* The mini PC model's own tools (besides the browser): web_search, read_page and search_my_data,
   plus the tool definitions it is handed. Everything runs on this computer. */
const fs = require('fs');
const siteNotes = require('./site-notes');
const { loadSkills, siteNoteDirs } = require('./task-context');
const { PREVIEW_UA } = require('./previews');

let ctx = null; // { readConfig, dataFile, agentLog }
function init(c) { ctx = c; }
const readConfig = () => ctx.readConfig();
const dataFile = () => ctx.dataFile();
const agentLog = (m) => ctx.agentLog(m);

const htmlText = (h) => String(h).replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
async function localWebSearch(query) {
  // SearXNG on the mini PC (config localModel.search): asks several engines, so no single one blocks it
  const searx = (readConfig().localModel || {}).search;
  if (searx) {
    try {
      const r = await fetch(String(searx).replace(/\/+$/, '') + '/search?format=json&q=' + encodeURIComponent(String(query).slice(0, 200)), { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      const out = (j.results || []).filter((x) => /^https?:\/\//.test(x.url || '')).slice(0, 6)
        .map((x) => '- ' + String(x.title || '').trim() + '\n  ' + x.url + '\n  ' + String(x.content || '').replace(/\s+/g, ' ').trim().slice(0, 220));
      if (out.length) return out.join('\n');
    } catch (e) { agentLog('local: SearXNG search failed (' + e.message + '), trying DuckDuckGo'); }
  }
  const r = await fetch('https://html.duckduckgo.com/html/', { method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': PREVIEW_UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ q: String(query).slice(0, 200) }) });
  const h = await r.text();
  const out = [];
  for (const block of h.split('class="result__body"').slice(1)) {
    const a = block.match(/class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = a[1].replace(/&amp;/g, '&');
    const u = url.match(/[?&]uddg=([^&]+)/); if (u) url = decodeURIComponent(u[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ads
    const snip = (block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '';
    out.push('- ' + htmlText(a[2]) + '\n  ' + url + '\n  ' + htmlText(snip).slice(0, 220));
    if (out.length >= 6) break;
  }
  if (!out.length && /anomaly|captcha/i.test(h)) return 'Search is blocked right now (the search engine thinks this is a bot). This does NOT mean nothing exists: say you couldn’t search.';
  return out.length ? out.join('\n') : 'No results.';
}
async function localReadPage(url) {
  if (!/^https?:\/\//i.test(String(url))) return 'Not a web address.';
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': PREVIEW_UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' } });
  if (!r.ok) return 'Could not open the page (HTTP ' + r.status + (r.status === 403 ? ', probably a bot check' : '') + ').';
  const h = (await r.text()).slice(0, 800000);
  const title = htmlText((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  return (title ? 'Title: ' + title + '\n' : '') + htmlText(h).slice(0, 5000);
}
/* search_my_data: the mini PC's model looks things up in what the Tasks app already knows, on this
   computer, nothing sent anywhere: every list's tasks (titles, notes, conversations, including what
   Claude found on earlier tasks), his preferences, his locked profile, his calendar and the skills.
   Plain keyword matching, best matches first. */
const STOP = new Set(('the a an and or of to in on for with my me i is are was be at by from it this that what which who how ' +
  'about do does did can could should would will please find look up get').split(' '));
function myDataSources(known) {
  const out = [];
  let data = {}; try { data = JSON.parse(fs.readFileSync(dataFile(), 'utf8')); } catch (e) {}
  for (const t of Array.isArray(data.tasks) ? data.tasks : []) {
    const list = t.ws === 'agent' ? 'agent task' : t.ws === 'school' ? 'school task' : t.ws === 'work' ? 'work task' : 'task';
    const head = '[' + list + (t.done ? ', done' : '') + (t.due ? ', due ' + t.due : '') + '] ' + t.title;
    out.push({ label: head, text: [t.title, t.notes, t.note, t.tag].filter(Boolean).join('\n') });
    for (const h of (Array.isArray(t.history) ? t.history : []).slice(-15)) {
      if (h.who === 'sys' || !h.text) continue;
      out.push({ label: head + ' (' + (h.who === 'you' ? 'The user said' : h.lane === 'local' ? 'mini PC said' : 'Claude said') + ')', text: String(h.text) });
    }
    for (const o of Array.isArray(t.options) ? t.options : []) out.push({ label: head + ' (option shown)', text: [o.label, o.desc, o.url].filter(Boolean).join(' · ') });
  }
  const section = (name, text) => String(text || '').split(/\n(?=## )/).forEach((part) => { if (part.trim()) out.push({ label: name, text: part.trim() }); });
  section('his preferences', known.prefs);
  section('his locked profile', known.locked);
  for (const e of (known.cal && known.cal.events) || []) out.push({ label: 'calendar ' + String(e.start).replace('T', ' ').slice(0, 16), text: e.title + (e.where ? ' @ ' + e.where : '') + (e.details ? '\n' + e.details : '') });
  for (const s of loadSkills()) out.push({ label: 'skill: ' + s.name, text: s.description + '\n' + s.body });
  try { for (const n of siteNotes.load(siteNoteDirs())) out.push({ label: 'site note: ' + n.name + (n.learned ? ' (learned, unchecked)' : ''), text: n.sites.join(' ') + '\n' + n.body }); } catch (e) {}
  return out;
}
// known = {prefs, locked, cal}; sources can be handed in (tests), else they're gathered here
function searchMyData(query, known, sources) {
  const words = [...new Set((String(query).toLowerCase().match(/[a-z0-9$@.+-]{3,}/g) || []).filter((w) => !STOP.has(w)))];
  if (!words.length) return 'Search with a few specific words.';
  const scored = (sources || myDataSources(known)).map((s) => {
    const low = s.text.toLowerCase(), lab = s.label.toLowerCase();
    const hits = words.filter((w) => low.includes(w) || lab.includes(w)).length;
    return { s, hits };
  }).filter((x) => x.hits > 0).sort((a, b) => b.hits - a.hits || b.s.text.length - a.s.text.length).slice(0, 6);
  if (!scored.length) return 'Nothing in his Tasks app matches "' + query + '".';
  return scored.map((x) => {
    const low = x.s.text.toLowerCase(), at = Math.max(0, Math.min(...words.map((w) => { const i = low.indexOf(w); return i < 0 ? 1e9 : i; })) - 120);
    return '- ' + x.s.label + '\n  ' + x.s.text.slice(at, at + 350).replace(/\s+/g, ' ').trim();
  }).join('\n');
}
const LOCAL_TOOLS = [
  { type: 'function', function: { name: 'web_search', description: 'Search the web. Returns titles, links and snippets.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'read_page', description: 'Read the text of a web page.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'search_my_data', description: 'Search what his Tasks app already knows: all his tasks and their conversations (including what was found on earlier tasks), notes, preferences, locked profile, calendar and skills.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
];
const FILL_FORM_TOOL = { type: 'function', function: { name: 'fill_form', description: 'Fill in every field of the form on the current page in one go, from his details. Use it first on any form page. details = anything you found that the form needs (optional).', parameters: { type: 'object', properties: { details: { type: 'string' } } } } };

module.exports = { init, htmlText, localWebSearch, localReadPage, myDataSources, searchMyData, LOCAL_TOOLS, FILL_FORM_TOOL };
