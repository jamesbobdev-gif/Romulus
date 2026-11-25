/* More than one account per AI: a second Claude plan, another ChatGPT plan, a spare Gemini or Groq key...
   Each extra account is its own entry in the AI order (Settings → AI connections), so when one account runs
   out of usage or fails, the next one carries on, the same as moving to another AI.

   config.json → ai.accounts: [{id: 'claude~2', label, ...that AI's own key fields}]. An account's id is its
   AI's id, '~', and a number. Only the sign-in or key is the account's own; models and switches follow the
   main account of that AI. A Claude or ChatGPT plan sign-in is kept in a folder of its own under the app's
   data (CLAUDE_CONFIG_DIR for Claude Code, CODEX_HOME for Codex), so each account signs in separately.
   Keys stay in config.json on this computer, never synced. No Electron here, so it can be tested on its own. */
const path = require('path');

const SEP = '~';
const ID_RE = /^([a-z]+)~(\d{1,3})$/;
const MAX_PER_AI = 9;
const baseOf = (id) => String(id || '').split(SEP)[0];
const isAccount = (id) => ID_RE.test(String(id || ''));

// the settings an extra account keeps for itself; compatIds: the key-only AIs (Grok, Groq...)
function ownFields(base, compatIds = []) {
  if (base === 'claude') return ['anthropicKey'];
  if (base === 'gemini') return ['geminiKey'];
  if (base === 'openai') return ['openaiVia', 'openaiKey'];
  if (base === 'openrouter') return ['openrouterKey'];
  if (compatIds.includes(base)) return [base + 'Key'];
  return [];
}

// the extra accounts saved in config, cleaned up: known AIs only, one of each id
function list(cfg, known) {
  const ai = (cfg && cfg.ai) || {}, seen = new Set();
  return (Array.isArray(ai.accounts) ? ai.accounts : []).filter((a) => {
    if (!a || !isAccount(a.id) || seen.has(a.id)) return false;
    if (known && !known.includes(baseOf(a.id))) return false;
    seen.add(a.id); return true;
  });
}
const find = (cfg, id) => list(cfg).find((a) => a.id === id) || null;

// the next free id for one more account of an AI: claude~2, claude~3...
function nextId(cfg, base) {
  const used = new Set(list(cfg).map((a) => a.id));
  for (let n = 2; n <= MAX_PER_AI + 1; n++) if (!used.has(base + SEP + n)) return base + SEP + n;
  return null;
}

/* what Settings and logs call an account: "Claude 2", or "Claude (Work)" when he named it.
   names: providers.NAMES */
function nameOf(id, cfg, names) {
  const base = baseOf(id), main = (names && names[base]) || base;
  if (!isAccount(id)) return main;
  const a = find(cfg, id), label = a && String(a.label || '').trim();
  return label ? main + ' (' + label + ')' : main + ' ' + id.split(SEP)[1];
}

// where an account's own sign-in lives: <app data>/ai-accounts/claude-2
const dirFor = (userData, id) => path.join(userData, 'ai-accounts', String(id).replace(SEP, '-'));

/* the config a run on this account uses: the main config with the account's own key in place of the main
   account's (a blank one stays blank, never falls back to the main key), and its own sign-in folder.
   A main id comes back as it is. */
function cfgFor(cfg, id, { userData, compatIds = [] } = {}) {
  if (!isAccount(id)) return cfg;
  const a = find(cfg, id) || {}, base = baseOf(id);
  const ai = Object.assign({}, (cfg && cfg.ai) || {});
  for (const k of ownFields(base, compatIds)) ai[k] = typeof a[k] === 'string' ? a[k] : '';
  if (base === 'openai' && !a.openaiVia) ai.openaiVia = a.openaiKey ? 'key' : 'chatgpt';
  if (userData && base === 'claude') ai.claudeConfigDir = dirFor(userData, id);
  if (userData && base === 'openai') ai.codexHome = dirFor(userData, id);
  ai.accountId = id;
  return Object.assign({}, cfg, { ai });
}

/* the changes, each returning a new ai object (config.json → ai) */
// one more account of an AI, switched on, right after that AI's other entries in the order
function add(ai, base, { known = [], label = '' } = {}) {
  ai = Object.assign({}, ai);
  if (known.length && !known.includes(base)) return { ai, error: 'unknown AI' };
  const id = nextId({ ai }, base);
  if (!id) return { ai, error: 'that’s the most accounts one AI can have' };
  ai.accounts = list({ ai }).concat([{ id, label: String(label || '').trim().slice(0, 40) }]);
  const order = Array.isArray(ai.order) ? ai.order.slice() : [];
  let at = -1;
  order.forEach((p, i) => { if (p && baseOf(p.id) === base) at = i; });
  order.splice(at < 0 ? order.length : at + 1, 0, { id, on: true });
  ai.order = order;
  return { ai, id };
}
function remove(ai, id) {
  ai = Object.assign({}, ai);
  ai.accounts = list({ ai }).filter((a) => a.id !== id);
  ai.order = (Array.isArray(ai.order) ? ai.order : []).filter((p) => p && p.id !== id);
  return ai;
}
// its label and its own key fields; anything else in the change is ignored
function update(ai, id, change, compatIds = []) {
  ai = Object.assign({}, ai);
  const own = ownFields(baseOf(id), compatIds);
  ai.accounts = list({ ai }).map((a) => {
    if (a.id !== id) return a;
    a = Object.assign({}, a);
    if (typeof change.label === 'string') a.label = change.label.trim().slice(0, 40);
    for (const k of own) if (typeof change[k] === 'string') a[k] = change[k].trim().slice(0, 300);
    if (a.openaiVia && a.openaiVia !== 'chatgpt' && a.openaiVia !== 'key') delete a.openaiVia;
    return a;
  });
  return ai;
}

/* an account that ran out of usage waits until its reset, on this computer only (the main Claude
   account has its own hold, agent/usage-limit.js) */
const held = {};
const HOLD_MS = 60 * 60 * 1000; // when the AI didn't say when it resets
function hold(id, until, now = Date.now()) { held[id] = until && until > now ? until : now + HOLD_MS; }
const heldUntil = (id, now = Date.now()) => held[id] && held[id] > now ? held[id] : 0;
const clearHold = (id) => { delete held[id]; };

module.exports = { SEP, baseOf, isAccount, ownFields, list, find, nextId, nameOf, dirFor, cfgFor, add, remove, update, hold, heldUntil, clearHold, MAX_PER_AI };
