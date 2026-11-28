/* What the Agent learns, shared between his computers: a how-to the mini PC worked out is there for the
   computer on his desk, and the other way round. One row next to the agent list (':learned', written
   compare-and-swap like every row, sealed when the list is):
     { v: 1, howtos: [...], tips: { host: ['- (date) tip', ...] }, classLog: [...], routes: { types, counted } }
   - how-tos (agent/howtos.js): each has an id and is never edited, so the two sides are merged as sets. What
     this computer had at its last sync is remembered (learned-sync.json), so one deleted or compacted away on
     either side goes on the other too, instead of coming back.
   - site tips (agent/site-notes.js) and the class log (agent/find-out.js): only ever added to; both sides'
     lines are joined and the newest kept.
   - the lane record (agent/route-learn.js): every computer counts the same finished tasks from the same synced
     list, so the counts are not added up: the higher count wins, and the tasks already counted are shared so
     none is counted again.
   Everything is put in one fixed order before it is compared, so two computers that agree write nothing.
   Keys and sign-ins are not here and never sync. No Electron here, so it can be tested on its own. */
const fs = require('fs');
const path = require('path');

const SUFFIX = ':learned';
const MAX_HOWTOS = 60;      // the same as agent/howtos.js keeps
const MAX_TIPS = 10;        // per site, the same as agent/site-notes.js keeps
const MAX_HOSTS = 150;
const MAX_LOG = 300;        // the same as agent/find-out.js keeps
const MAX_COUNTED = 1000;   // of the lane record's "already counted" marks, in the row
const LANES = ['claude', 'local'];
// never his details: the same test the how-tos and tips pass before they are kept at all
const PERSONAL = /@|\d{3}[\s.-]?\d{3,}|\b\d{6,}\b/;
const HOST_OK = /^[a-z0-9.-]+\.[a-z]{2,}$/; // also keeps a row from naming a file outside the notes folder
const TIP_OK = /^- \(\d{4}-\d{2}-\d{2}\) \S.{10,240}$/;
const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- how-tos ----
function cleanHowto(h) {
  if (!h || typeof h !== 'object' || !/^[a-z0-9]{6,24}$/.test(String(h.id)) || typeof h.text !== 'string') return null;
  const text = str(h.text, 401);
  if (text.length < 20 || PERSONAL.test(text)) return null;
  const words = (Array.isArray(h.words) ? h.words : []).map((w) => str(w, 40).toLowerCase()).filter(Boolean).slice(0, 60);
  if (!words.length) return null;
  const out = { id: String(h.id), task: str(h.task, 120), words, sites: (Array.isArray(h.sites) ? h.sites : []).map((s) => str(s, 80).toLowerCase()).filter((s) => HOST_OK.test(s)).slice(0, 8),
    text, lane: h.lane === 'local' ? 'local' : 'claude', date: /^\d{4}-\d{2}-\d{2}$/.test(String(h.date)) ? h.date : '1970-01-01' };
  if (h.merged > 1) out.merged = Math.floor(h.merged);
  if (h.priv) out.priv = true;
  return out;
}
const howtoOrder = (a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id));
// base: the ids this computer had after its last sync (null on its first, or when there is no row yet)
function mergeHowtos(local, remote, base) {
  const was = new Set(base || []);
  const mine = new Map(), theirs = new Map();
  (local || []).map(cleanHowto).filter(Boolean).forEach((h) => mine.set(h.id, h));
  (Array.isArray(remote) ? remote : []).map(cleanHowto).filter(Boolean).forEach((h) => theirs.set(h.id, h));
  const out = [];
  mine.forEach((h, id) => { if (theirs.has(id) || !was.has(id)) out.push(h); });      // gone from the row since: deleted elsewhere
  theirs.forEach((h, id) => { if (!mine.has(id) && !was.has(id)) out.push(h); });     // gone from here since: deleted here
  return out.sort(howtoOrder).slice(-MAX_HOWTOS);
}

// ---- site tips ----
const tipSaid = (l) => l.replace(/^- \(\d{4}-\d{2}-\d{2}\) /, '').toLowerCase();
function cleanTips(map) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const host of Object.keys(map)) {
    if (!HOST_OK.test(host) || !Array.isArray(map[host])) continue;
    const lines = map[host].filter((l) => typeof l === 'string' && TIP_OK.test(l) && !PERSONAL.test(tipSaid(l)));
    if (lines.length) out[host] = lines;
  }
  return out;
}
function mergeTips(local, remote) {
  const a = cleanTips(local), b = cleanTips(remote), all = {};
  for (const host of [...new Set(Object.keys(a).concat(Object.keys(b)))]) {
    const seen = new Set(), lines = [];
    // the older wording of the same tip is the one kept, so its date does not move
    (a[host] || []).concat(b[host] || []).sort().forEach((l) => { if (!seen.has(tipSaid(l))) { seen.add(tipSaid(l)); lines.push(l); } });
    all[host] = lines.slice(-MAX_TIPS);
  }
  // the sites with the newest tips, in a fixed order
  const newest = (h) => all[h][all[h].length - 1].slice(3, 13);
  const out = {};
  Object.keys(all).sort((x, y) => newest(y).localeCompare(newest(x)) || x.localeCompare(y)).slice(0, MAX_HOSTS).sort().forEach((h) => { out[h] = all[h]; });
  return out;
}

// ---- the class log ----
const logKey = (e) => e.course + '|' + String(e.title).toLowerCase();
function cleanLog(list) {
  return (Array.isArray(list) ? list : []).map((e) => {
    if (!e || typeof e !== 'object') return null;
    const course = str(e.course, 30), title = str(e.title, 200);
    if (!course || !title) return null;
    return { course, title, due: /^\d{4}-\d{2}-\d{2}$/.test(String(e.due)) ? e.due : null, at: /^\d{4}-\d{2}-\d{2}$/.test(String(e.at)) ? e.at : '1970-01-01' };
  }).filter(Boolean);
}
function mergeLog(local, remote) {
  const by = new Map();
  cleanLog(remote).concat(cleanLog(local)).forEach((e) => { const k = logKey(e), had = by.get(k); if (!had || e.at >= had.at) by.set(k, e); });
  return [...by.values()].sort((a, b) => a.at.localeCompare(b.at) || logKey(a).localeCompare(logKey(b))).slice(-MAX_LOG);
}

// ---- the lane record ----
const count = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
function cleanRoutes(r) {
  const out = { types: {}, counted: {} };
  if (!r || typeof r !== 'object') return out;
  const types = r.types && typeof r.types === 'object' ? r.types : {};
  for (const type of Object.keys(types).sort()) {
    if (type.length > 40 || /[\r\n]/.test(type) || !types[type] || typeof types[type] !== 'object') continue;
    const row = {};
    for (const lane of LANES) { const c = types[type][lane]; if (c && typeof c === 'object' && (count(c.ok) || count(c.bad))) row[lane] = { ok: count(c.ok), bad: count(c.bad) }; }
    if (Object.keys(row).length) out.types[type] = row;
  }
  const counted = r.counted && typeof r.counted === 'object' ? r.counted : {};
  for (const k of Object.keys(counted)) if (k.length <= 80 && /\|(moved|done)$/.test(k)) out.counted[k] = 1;
  return out;
}
// → {local, remote}: this computer keeps every mark it has; the row carries a fixed-order share of them
function mergeRoutes(local, remote) {
  const a = cleanRoutes(local), b = cleanRoutes(remote), types = {};
  for (const type of [...new Set(Object.keys(a.types).concat(Object.keys(b.types)))].sort()) {
    const row = {};
    for (const lane of LANES) {
      const x = (a.types[type] || {})[lane] || { ok: 0, bad: 0 }, y = (b.types[type] || {})[lane] || { ok: 0, bad: 0 };
      if (x.ok || x.bad || y.ok || y.bad) row[lane] = { ok: Math.max(x.ok, y.ok), bad: Math.max(x.bad, y.bad) };
    }
    types[type] = row;
  }
  const mine = Object.assign({}, a.counted);
  Object.keys(b.counted).forEach((k) => { mine[k] = 1; });
  const shared = {};
  Object.keys(mine).sort().slice(-MAX_COUNTED).forEach((k) => { shared[k] = 1; });
  return { local: { v: 1, types, counted: mine }, remote: { types, counted: shared } };
}

/* everything at once (pure). local: {howtos, tips, classLog, routes} as this computer has them; doc: the row
   (null when there is none); base: the how-to ids from the last sync. → the same shapes to keep, the row to
   write, and which of the two changed. */
function merge(local, doc, base) {
  const d = doc && typeof doc === 'object' ? doc : null;
  const howtos = mergeHowtos(local.howtos, d && d.howtos, d ? base : null);
  const tips = mergeTips(local.tips, d && d.tips);
  const classLog = mergeLog(local.classLog, d && d.classLog);
  const routes = mergeRoutes(local.routes, d && d.routes);
  const next = Object.assign({}, d, { v: 1, howtos, tips, classLog, routes: routes.remote });
  const wasRoutes = cleanRoutes(local.routes);
  // a how-to here that the row can't carry (an odd one from an old version) stays here, unshared
  const shared = new Set(howtos.map((h) => h.id));
  const odd = (local.howtos || []).filter((h) => h && h.id && !shared.has(h.id) && !cleanHowto(h));
  const has = (host, line) => ((local.tips || {})[host] || []).includes(line);
  return {
    local: { howtos: odd.concat(howtos), tips, classLog, routes: routes.local },
    doc: next,
    base: howtos.map((h) => h.id),
    changedRemote: !same(next, d),
    changed: {
      howtos: !same(odd.concat(howtos).map((h) => h.id).sort(), (local.howtos || []).map((h) => h && h.id).sort()),
      tips: Object.keys(tips).filter((host) => tips[host].some((l) => !has(host, l))), // only a site with a tip this computer lacks
      classLog: !same(classLog, local.classLog || []),
      routes: !same(routes.local.types, wasRoutes.types) || Object.keys(routes.local.counted).length !== Object.keys(wasRoutes.counted).length,
    },
  };
}

// ---- this computer's files ----
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } };
function writeJson(file, value, indent) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, indent));
  fs.renameSync(file + '.tmp', file);
}
function readTips(dir) {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch (e) { return out; }
  for (const f of files) {
    const host = f.replace(/\.md$/, '');
    try { out[host] = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r/g, '').split('\n').filter((l) => l.startsWith('- ')); } catch (e) {}
  }
  return out;
}
function writeTips(dir, host, lines) {
  if (!HOST_OK.test(host)) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, host + '.md'), '---\nname: ' + host + '\nsites: ' + host + '\n---\n' + lines.join('\n') + '\n');
}

/* one pass: read the row, merge, keep what is new here, write what is new there.
   o: { a (the agent channel), supabase, howtos, routeLearn, files: {howtos, tipsDir, classLog, state} }
   → {ok, got: what came in, sent: true when the row was written} or {ok: false, error}. Never throws. */
async function sync(o) {
  const { a, supabase, howtos, routeLearn, files } = o;
  if (!a) return { ok: false, error: 'sync isn’t set up on this computer' };
  try {
    for (let i = 0; i < 3; i++) {
      const row = await supabase.readRow(a, SUFFIX);
      // from here to the files being written nothing waits, so a how-to learned meanwhile is not lost
      const state = readJson(files.state, {});
      const local = { howtos: howtos.load(files.howtos), tips: readTips(files.tipsDir), classLog: readJson(files.classLog, []), routes: routeLearn.snapshot() };
      const r = merge(local, row ? row.doc : null, Array.isArray(state.howtoIds) ? state.howtoIds : null);
      const got = [];
      if (r.changed.howtos) { howtos.save(files.howtos, r.local.howtos); got.push('how-tos'); }
      r.changed.tips.forEach((host) => writeTips(files.tipsDir, host, r.local.tips[host]));
      if (r.changed.tips.length) got.push('site tips');
      if (r.changed.classLog) { writeJson(files.classLog, r.local.classLog, 1); got.push('class log'); }
      if (r.changed.routes) { routeLearn.adopt(r.local.routes); got.push('lane record'); }
      if (!r.changedRemote) { writeJson(files.state, { howtoIds: r.base }); return { ok: true, got, sent: false }; }
      if (await supabase.writeRow(a, SUFFIX, r.doc, row ? row.updated_at : null)) { writeJson(files.state, { howtoIds: r.base }); return { ok: true, got, sent: true }; }
      // the row changed meanwhile: the ids remembered stay as they were, and the next read merges again
    }
    return { ok: false, error: 'the row kept changing while it was being written' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

module.exports = { SUFFIX, mergeHowtos, mergeTips, mergeLog, mergeRoutes, merge, readTips, sync, MAX_HOWTOS, MAX_TIPS, MAX_COUNTED };
