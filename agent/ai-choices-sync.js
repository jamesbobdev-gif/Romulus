/* His choices under Settings → AI connections, the same on every one of his computers: the order the cloud AIs
   are tried in and which are switched on, the model picked for each, and the switches next to them (web search,
   helpers, use the browser...). They used to live only in one computer's config.json, so reordering the AIs
   on his desk changed nothing on the mini PC.
   What does NOT travel, ever: keys, sign-ins, extra accounts and their labels, and how ChatGPT is reached (his
   plan or a key), which depends on what is signed in on that computer (main/store.js: keys are never synced).
   An AI switched on here that the other computer has no key for simply isn't used there.
   They ride in the ':settings' row next to the personal list, under two names of their own ('ai.order',
   'ai.models'), by the same rule as the page's shared settings (renderer/js/shared-settings.js, whose merge this
   uses): the newer change wins, name by name; what a computer had before it first ran this counts as old; one
   that never chose anything can't overwrite one that did. The page leaves names it doesn't know alone, so the
   two share the row. No Electron here, so it can be tested on its own. */
const fs = require('fs');
const path = require('path');
const providers = require('./providers');
const accounts = require('./ai-accounts');
const { sharedNote, sharedMerge } = require('../renderer/js/shared-settings');

const SUFFIX = ':settings';
const KEYS = ['ai.order', 'ai.models'];
const TEXT = ['claudeModel', 'codexModel', 'geminiModel', 'openaiModel', 'openrouterModel', ...providers.COMPAT_IDS.map((id) => id + 'Model')];
const FLAGS = ['openrouterWeb', 'openrouterZdr', 'openrouterFree', 'helpers', 'claudeLast', ...providers.COMPAT_IDS.map((id) => id + 'Browser')];
const okModel = (v) => typeof v === 'string' && v.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9._:\/@+-]*$/.test(v);

// → {'ai.order': text or null, 'ai.models': text or null}: his choices as they travel, in one fixed form
function pick(ai) {
  ai = ai || {};
  const order = (Array.isArray(ai.order) ? ai.order : [])
    .filter((p) => p && providers.PROVIDERS.includes(String(p.id)) && !accounts.isAccount(p.id))
    .map((p) => ({ id: String(p.id), on: !!p.on }));
  const models = {};
  for (const k of TEXT.slice().sort()) if (okModel(ai[k])) models[k] = ai[k];
  for (const k of FLAGS.slice().sort()) if (typeof ai[k] === 'boolean') models[k] = ai[k];
  return { 'ai.order': order.length ? JSON.stringify(order) : null, 'ai.models': Object.keys(models).length ? JSON.stringify(models) : null };
}

// config.ai with choices from another computer put in. set: {name: text or null} for the names that came in
function apply(ai, set) {
  const out = Object.assign({}, ai);
  if ('ai.order' in set) {
    let theirs = []; try { theirs = JSON.parse(set['ai.order'] || '[]'); } catch (e) { theirs = []; }
    theirs = (Array.isArray(theirs) ? theirs : []).filter((p) => p && providers.PROVIDERS.includes(String(p.id)) && !accounts.isAccount(p.id))
      .map((p) => ({ id: String(p.id), on: !!p.on }));
    const seen = new Set();
    theirs = theirs.filter((p) => !seen.has(p.id) && seen.add(p.id));
    // this computer's extra accounts stay, each right after the AI it is an account of
    const mine = (Array.isArray(ai && ai.order) ? ai.order : []).filter((p) => p && accounts.isAccount(p.id));
    const next = [];
    for (const p of theirs) { next.push(p); mine.filter((m) => accounts.baseOf(m.id) === p.id).forEach((m) => next.push(m)); }
    mine.filter((m) => !seen.has(accounts.baseOf(m.id))).forEach((m) => next.push(m));
    if (next.length) out.order = next; else delete out.order;
  }
  if ('ai.models' in set) {
    let theirs = {}; try { theirs = JSON.parse(set['ai.models'] || '{}') || {}; } catch (e) { theirs = {}; }
    for (const k of TEXT) { if (okModel(theirs[k])) out[k] = theirs[k]; else delete out[k]; }
    for (const k of FLAGS) { if (typeof theirs[k] === 'boolean') out[k] = theirs[k]; else delete out[k]; }
  }
  return out;
}

// the personal list's place on the server, from config.json; null when sync isn't set up
function personal(cfg) {
  const p = cfg && cfg.sync && cfg.sync.personal;
  return p && p.url && p.key && p.syncKey ? Object.assign({ url: p.url, key: p.key, syncKey: p.syncKey }, p.v2 ? { v2: true } : {}) : null;
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } };

/* one pass. o: { supabase, readConfig, writeConfig, stamps (ai-choices-sync.json), now? }
   → {ok, got: [names that came in], sent} or {ok: false, error}. Never throws. */
async function sync(o) {
  try {
    const p = personal(o.readConfig());
    if (!p) return { ok: false, error: 'sync isn’t set up on this computer' };
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await o.supabase.readRow(p, SUFFIX);
      // from here to the config being written nothing waits, so a choice he makes meanwhile is not lost
      const c = o.readConfig(), now = o.now ? o.now() : Date.now();
      const kept = readJson(o.stamps, {}), stamps = kept.stamps || {}, held = kept.held || {};
      // a choice that came in and could not be kept whole here (an AI this version doesn't know) is held in a
      // shorter form: while it is still held that way, it counts as the choice that came in, not a change made here
      const mine = pick(c.ai);
      KEYS.forEach((k) => { if (k in held && stamps[k] && mine[k] === held[k]) mine[k] = stamps[k].seen; });
      const r = sharedMerge(sharedNote(stamps, mine, KEYS, now), row ? row.doc : null, KEYS);
      const got = Object.keys(r.set);
      if (got.length) {
        c.ai = apply(c.ai, r.set);
        o.writeConfig(c);
        const now2 = pick(c.ai);
        got.forEach((k) => { if (now2[k] !== r.stamps[k].seen) held[k] = now2[k]; else delete held[k]; });
      }
      KEYS.forEach((k) => { if (k in held && pick(c.ai)[k] !== held[k]) delete held[k]; }); // he has changed it here since
      const save = () => { try { fs.mkdirSync(path.dirname(o.stamps), { recursive: true }); fs.writeFileSync(o.stamps, JSON.stringify({ stamps: r.stamps, held })); } catch (e) {} };
      if (!r.changedRemote) { save(); return { ok: true, got, sent: false }; }
      // only the two names here are this file's to write: everything else in the row is carried as it was read
      if (await o.supabase.writeRow(p, SUFFIX, Object.assign({}, row ? row.doc : null, r.doc), row ? row.updated_at : null)) { save(); return { ok: true, got, sent: true }; }
      save(); // what came in is kept; what goes up is worked out again from the row as it is now
    }
    return { ok: false, error: 'the shared settings kept changing while they were being written' };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

module.exports = { SUFFIX, KEYS, pick, apply, personal, sync };
