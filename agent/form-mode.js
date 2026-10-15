/* Form mode: the mini PC's model fills a whole form page in ONE short question instead of one field
   per step. A small model on a slow processor loses most of its time re-reading the conversation on
   every step (25–90 s each), and makes its slips choosing refs and spelling dropdown choices. Here:
   - the fields on the page are listed for it in a short prompt (label, kind, choices, current value),
     with the task and his details, and nothing else: no conversation, no page text
   - its answer is forced into a JSON shape (Ollama's `format`): one value per field, dropdowns and
     radios can only be one of their real choices (or "" to leave empty), so it can't misspell one or
     invent a ref
   - the app fills them (one at a time, through agent/page-reader.js's step), and the model is told
     what was filled, what's still empty and what he needs to give
   Passwords, SSN, card and bank numbers are never filled, whatever it answers. The browser lock
   (agent/browser-proxy.js) still refuses final clicks: this only types and chooses.
   No Electron here, so it can be tested on its own (agent/local-lane.js passes in `ask`, which calls Ollama). */

const pageReader = require('./page-reader');

const FIELD_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'checkbox', 'radio', 'switch']);
const SITE_CHROME = new Set(['navigation', 'banner', 'contentinfo', 'complementary']);
const SECRET = /password|passcode|\bpin\b|social security|\bssn\b|card number|credit card|debit card|\bcvv\b|\bcvc\b|security code|expir|routing|account number|iban|sort code|tax id|\bitin\b/i;
const MAX_FIELDS = 40;

const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function walk(n, fn) { for (const c of n.children || []) { fn(c); walk(c, fn); } }
const within = (n, roles) => { for (let p = n.parent; p; p = p.parent) if (roles.has(p.role)) return true; return false; };
const checked = (n) => n.attrs.checked === true || n.attrs.checked === 'true';
const required = (n, extra) => /\*|\(required\)/i.test(String(n.name || '') + ' ' + String(extra || '')) || n.attrs.required === true;

// the fillable fields on the page the reader last looked at (state.refs keeps each node's parent)
function formFields(state) {
  const nodes = Object.values((state && state.refs) || {});
  if (!nodes.length) return [];
  let root = nodes[0]; while (root.parent) root = root.parent;
  const out = [], groups = new Map();
  walk(root, (n) => {
    if (!n.ref || !FIELD_ROLES.has(n.role) || n.attrs.disabled || n.attrs.readonly) return;
    if (n.role === 'searchbox' || within(n, SITE_CHROME)) return; // the site's own search box, not the form
    if (n.role === 'radio') {
      let g = n.parent; while (g && g.role !== 'radiogroup' && !(g.role === 'group' && g.name) && g.role !== 'root') g = g.parent;
      const key = g && g.role !== 'root' ? g : n.parent;
      if (!groups.has(key)) { groups.set(key, []); out.push({ kind: 'radio', group: key, radios: groups.get(key) }); }
      groups.get(key).push(n);
      return;
    }
    if (n.role === 'checkbox' || n.role === 'switch') { out.push({ kind: 'check', node: n, label: n.name || 'checkbox', now: checked(n) ? 'yes' : 'no', req: required(n) }); return; }
    const opts = (n.children || []).filter((c) => c.role === 'option').map((o) => o.name).filter(Boolean);
    if ((n.role === 'combobox' || n.role === 'listbox') && opts.length) {
      const sel = (n.children || []).filter((c) => c.role === 'option' && c.attrs.selected).map((o) => o.name);
      const now = sel[0] && !/^(choose|select|please|pick|--|—|-)/i.test(sel[0]) ? sel[0] : '';
      out.push({ kind: 'choice', node: n, label: n.name || 'dropdown', choices: [...new Set(opts)], now, req: required(n) });
      return;
    }
    out.push({ kind: 'text', node: n, label: n.name || n.role, now: n.value || '', req: required(n) });
  });
  for (const f of out) if (f.kind === 'radio') {
    const names = f.radios.map((r) => r.name).filter(Boolean);
    f.label = f.group.name || 'Choose one';
    f.choices = [...new Set(names)];
    f.now = (f.radios.find(checked) || {}).name || '';
    f.req = required(f.group);
  }
  return out.filter((f) => f.kind !== 'radio' || f.choices.length).slice(0, MAX_FIELDS).map((f, i) => Object.assign(f, { id: 'f' + (i + 1), secret: SECRET.test(f.label) }));
}

// one value per field; choices limited to the page's own
function schemaFor(fields) {
  const props = {};
  for (const f of fields) {
    props[f.id] = f.kind === 'text' ? { type: 'string' }
      : f.kind === 'check' ? { type: 'string', enum: ['yes', 'no', ''] }
        : { type: 'string', enum: f.choices.concat('') };
  }
  return { type: 'object', properties: { values: { type: 'object', properties: props, required: fields.map((f) => f.id) },
    missing: { type: 'array', items: { type: 'string' } } }, required: ['values', 'missing'] };
}

const RULES = `You fill in web forms for James. You get the task, his details and the form's fields.
For every field, give the value to enter:
- Use only what the task and his details say. If you don't have it, give "" (leave it empty). Never
  make anything up: no guessed dates, numbers, answers or experience.
- Passwords, SSN, card, bank and ID numbers: always "".
- Dropdowns and choices: exactly one of the listed choices, or "".
- Checkboxes: "yes" to tick, "no" to untick, "" to leave as it is. Never tick marketing or newsletter
  boxes; agreeing to terms is his call, so leave those "".
- A field that already has the right value: give that value again.
- Dates, phones and times: write them the way the field's label or example shows.
- His profile's "Form answers" are his standard answers: use them for matching questions, even if
  the wording differs ("Are you legally allowed to work…" = work authorization). A question there
  with no answer means he hasn't decided: give "".
- Quiz or test questions with a right answer (facts, math, definitions): choose the correct choice.
  That is knowledge, not making things up. Questions about him still come only from his details.
In "missing", list the fields the form needs that you left empty, in a few words each.
Reply with only the JSON.`;

function describe(f) {
  const kind = f.kind === 'text' ? 'text' : f.kind === 'check' ? 'checkbox' : f.kind === 'radio' ? 'choose one' : 'dropdown';
  return f.id + ': ' + kind + ' "' + clip(f.label, 100) + '"' + (f.req ? ' (required)' : '') +
    (f.choices ? '  choices: ' + f.choices.map((c) => clip(c, 50)).join(' | ') : '') +
    '  now: ' + (f.now ? '"' + clip(f.now, 80) + '"' : '(empty)');
}

/* Fill the form on the current page.
   browser: the browser tools (call(name, args)); state: page-reader's page state for this task;
   ask(messages, schema) → the model's reply text; task/prefs/locked/details: what it may use. */
async function fill({ browser, state, ask, task, prefs, locked, details }) {
  if (!state.refs) await pageReader.step(browser, 'browser_snapshot', {}, state);
  const fields = formFields(state);
  if (!fields.length) return { text: 'There is no form to fill on this page. Open the form first (or click the button that shows it).', filled: 0 };
  const open = fields.filter((f) => !f.secret);
  const page = state.url || '';
  const prompt = '## The task\n' + JSON.stringify(task, null, 1) +
    (details ? '\n\n## Found while working on it\n' + clip(details, 1500) : '') +
    '\n\n## His preferences\n' + (String(prefs || '').trim() || '(none)') +
    '\n\n## His locked profile (private details for forms)\n' + (String(locked || '').trim() || '(empty)') +
    '\n\n## The form' + (page ? ' on ' + page : '') + '\n' + open.map(describe).join('\n');
  let plan;
  const raw = await ask([{ role: 'system', content: RULES }, { role: 'user', content: prompt }], schemaFor(open));
  try { plan = JSON.parse(raw); } catch (e) { return { text: 'Form mode couldn\'t read its own answer. Fill the fields with browser_fill_form instead.', filled: 0 }; }
  const values = (plan && plan.values) || {};

  // the model takes a minute or more: look again, and find each field on the page as it is now (by its
  // kind and label), so the refs aren't stale
  const ids = {}, key = (f) => f.kind + '|' + f.label;
  const count = (list) => list.map((f) => { const k = key(f); ids[k] = (ids[k] || 0) + 1; return k + '|' + ids[k]; });
  const before = count(fields);
  for (const k in ids) delete ids[k];
  const seen = await pageReader.step(browser, 'browser_snapshot', {}, state);
  // another tab came to the front, or the page moved on: type nothing into a page it didn't plan for
  if (page && state.url && state.url !== page) return { text: 'The browser moved to a different page while form mode was thinking (now ' + state.url + '). Nothing was entered. Open the form again, then call fill_form.\n\nThe page now:\n' + seen.text, filled: 0 };
  const nowFields = formFields(state), nowKeys = count(nowFields);
  const current = (i) => nowFields[nowKeys.indexOf(before[i])];

  // what to do, field by field; only changes go to the page
  const todo = [], said = [], left = [];
  for (const [i, f0] of fields.entries()) {
    const f = Object.assign({}, current(i) || f0, { id: f0.id, secret: f0.secret });
    if (!current(i)) { left.push('"' + clip(f0.label, 60) + '" (no longer on the page)'); continue; }
    const v = f.secret ? '' : String(values[f.id] == null ? '' : values[f.id]).trim();
    if (!v || v === f.now) {
      if (!v && !f.now && (f.req || f.secret)) left.push('"' + clip(f.label, 60) + '"' + (f.secret ? ' (he fills this himself)' : ''));
      continue;
    }
    if (f.kind === 'text') todo.push({ target: f.node.ref, name: f.label, type: 'textbox', value: v });
    else if (f.kind === 'choice') todo.push({ target: f.node.ref, name: f.label, type: 'combobox', value: v });
    else if (f.kind === 'check') todo.push({ target: f.node.ref, name: f.label, type: 'checkbox', value: v === 'yes' ? 'true' : 'false' });
    else { const r = f.radios.find((x) => x.name === v); if (r) todo.push({ target: r.ref, name: r.name, type: 'radio', value: 'true' }); }
    said.push('"' + clip(f.label, 50) + '" = ' + (f.kind === 'check' ? v : '"' + clip(v, 60) + '"'));
  }
  const missing = [...new Set((Array.isArray(plan.missing) ? plan.missing : []).map((m) => clip(m, 80)).filter(Boolean).concat(left))].slice(0, 12);
  if (!todo.length) return { text: 'Form mode had nothing new to enter on this page.' + (missing.length ? '\nMissing (he needs to give these): ' + missing.join(', ') : '') + '\n\nThe page now:\n' + seen.text.replace(/\n\n\(You already looked[^)]*\)$/, ''), filled: 0, missing };
  const r = await pageReader.step(browser, 'browser_fill_form', { fields: todo }, state);
  const [how, view] = splitView(r.text);
  // a time or date box (<input type=time/date>) refuses "7pm" or "Oct 9": write it the way they take it, once
  const again = todo.filter((f) => new RegExp('✗ "' + escapeRe(f.name.slice(0, 49)) + '[^"]*" \\[' + escapeRe(f.target) + '\\]: Malformed value').test(how))
    .map((f) => Object.assign({}, f, { value: machineValue(f.value) })).filter((f) => f.value != null);
  let retried = '', pageNow = view;
  if (again.length) {
    const r2 = await pageReader.step(browser, 'browser_fill_form', { fields: again }, state);
    retried = '\nRewrote for the page and tried again: ' + again.map((f) => '"' + clip(f.name, 50) + '" = "' + f.value + '"').join(', ') + (r2.failed ? ' (still refused)' : ' (✓)');
    pageNow = splitView(r2.text)[1] || pageNow;
  }
  return {
    text: 'Form mode tried ' + todo.length + ' field(s): ' + said.join(', ') + '.\n' + how + retried +
      (missing.length ? '\nMissing (he needs to give these): ' + missing.join(', ') : '') +
      '\nCheck the page below: fix only what is wrong or still empty and that you have details for.' + (page ? '\n\nThe page now:\n' + page : ''),
    filled: todo.length, missing,
  };
}

// a step's text → [what happened, the page now]
const splitView = (t) => { const i = String(t).indexOf('\n\nThe page now:\n'); return i < 0 ? [String(t), ''] : [t.slice(0, i), t.slice(i + 16)]; };
const escapeRe =(s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "7pm" / "7:30 PM" → "19:00" / "19:30"; "October 9, 2026" / "10/9/2026" → "2026-10-09"; null if neither
function machineValue(v) {
  const s = String(v).trim();
  const t = s.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?$/i);
  if (t) { let h = Number(t[1]) % 12; if (/p/i.test(t[3])) h += 12; return String(h).padStart(2, '0') + ':' + (t[2] || '00'); }
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return us[3] + '-' + us[1].padStart(2, '0') + '-' + us[2].padStart(2, '0');
  const d = new Date(s);
  if (/[a-z]{3}/i.test(s) && /\d{4}/.test(s) && !isNaN(d)) return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return null;
}

module.exports = { fill, formFields, schemaFor, machineValue };
