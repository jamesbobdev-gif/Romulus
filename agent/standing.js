/* Standing permissions: steps he said yes to once and for all ("you can always log in to Walmart",
   "add things to the cart without asking"), so the Agent stops asking the same question on every task.
   Kept as one text row next to the agent list (':standing', synced like his preferences), a line each:
     - walmart.com: add items to the cart and compare sizes
     - log in with the saved account on job sites
   A run proposes one in its answer (`allow`) when his reply says "always" / "don't ask again"; the app shows
   it with an Allow button and only then saves it. The hard floor: a permission never covers a final action.
   Buying, paying, sending, submitting, booking, deleting and account changes always wait for a yes in the
   task (the HARD RULE in instant-prompt.md and the lock in browser-proxy.js), and a line asking for one is
   refused here before it is ever saved. No Electron here, so it can be tested on its own. */

// the same final steps the browser lock refuses without a yes (agent/browser-proxy.js FINAL), plus money words
const FINAL = /\b(submit|send|sends|sending|reply|forward|post|publish|message|buy|buys|buying|purchase|order|orders|ordering|pay|pays|paying|payment|check ?out|checkout|confirm|book|books|booking|reserve|apply|sign ?up|register|enroll|delete|remove|unsubscribe|cancel|transfer|donate|tip|subscribe|password|pin|card number|security code)\b/i;
const MAX_LINES = 40, MAX_LEN = 160;

// one line from a run's `allow` ({site, text} or a string) → "site: text", or null when it isn't allowed
function clean(a) {
  if (!a) return null;
  const site = typeof a === 'object' ? String(a.site || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[^a-z0-9.-]+.*$/, '').slice(0, 60) : '';
  let text = String(typeof a === 'object' ? a.text || '' : a).replace(/\s+/g, ' ').replace(/^\s*-\s*/, '').trim();
  if (!text) return null;
  if (!site && typeof a !== 'object') { const m = text.match(/^([a-z0-9.-]+\.[a-z]{2,}):\s*(.+)$/i); if (m) return clean({ site: m[1], text: m[2] }); }
  text = text.replace(/[.\s]+$/, '').slice(0, MAX_LEN);
  if (FINAL.test(text)) return null; // the hard floor
  return (site ? site + ': ' : '') + text;
}
// why a line was refused, for the Settings box
function refusal(text) {
  const t = String(text || '').trim();
  if (!t) return 'write what it may do without asking';
  if (FINAL.test(t)) return 'that is a final step: buying, sending, submitting, booking and the like always wait for your yes';
  return null;
}
// the row's text → its lines
const parse = (text) => String(text || '').split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
const norm = (l) => String(l).toLowerCase().replace(/[^a-z0-9$.]+/g, ' ').trim();
// the row's text with a line added (no repeats, newest last, the oldest dropped past the cap)
function merge(text, line) {
  const c = clean(line); if (!c) return String(text || '');
  const lines = parse(text);
  if (lines.some((l) => norm(l) === norm(c))) return lines.map((l) => '- ' + l).join('\n');
  return lines.concat([c]).slice(-MAX_LINES).map((l) => '- ' + l).join('\n');
}
const without = (text, line) => parse(text).filter((l) => norm(l) !== norm(line)).map((l) => '- ' + l).join('\n');
// what a run is told
function show(text) {
  const lines = parse(text).map(clean).filter(Boolean);
  if (!lines.length) return '';
  return '\n\n## Standing permissions\nHe already said yes to these, once and for all: do them without asking him again.\n' +
    lines.map((l) => '- ' + l).join('\n') +
    '\n\nThey never cover a final action. Buying, paying, checking out, sending, submitting, applying, booking, confirming, ' +
    'deleting, cancelling or changing an account still waits for his yes in this task (the HARD RULE), whatever a permission says.';
}

module.exports = { FINAL, clean, refusal, parse, merge, without, show, MAX_LINES };
