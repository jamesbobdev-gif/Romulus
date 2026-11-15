const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { WHATS_NEW, WHATS_NEW_SEEN_KEY, whatsNewSince, whatsNewNewer } = require('../renderer/js/whats-new');
const { stamp, notesFor } = require('../scripts/whats-new');
const { releaseNotes } = require('../scripts/releases-readme');

const entries = [
  { version: 'next', notes: ['A'] },
  { version: '1.3.22', notes: ['B'] },
  { version: '1.3.21', notes: ['C1', 'C2'] },
  { version: '1.3.20', notes: ['D'] },
];
const released = entries.slice(1);

test('after an update: the versions since the one this device last ran, newest first', () => {
  assert.deepStrictEqual(whatsNewSince(released, '1.3.21', '1.3.22'), [{ version: '1.3.22', notes: ['B'] }]);
  assert.deepStrictEqual(whatsNewSince(released, '1.3.20', '1.3.22'), [{ version: '1.3.22', notes: ['B'] }, { version: '1.3.21', notes: ['C1', 'C2'] }]);
  assert.deepStrictEqual(whatsNewSince(released, '1.3.22', '1.3.22'), []);
  assert.deepStrictEqual(whatsNewSince(released, '1.3.23', '1.3.22'), []); // a downgrade says nothing
  assert.deepStrictEqual(whatsNewSince(released, '1.3.21', null), []);
});

test("'next' is the version being built; lines for a version ahead of this build are left out", () => {
  assert.deepStrictEqual(whatsNewSince(entries, '1.3.22', '1.3.23'), [{ version: '1.3.23', notes: ['A'] }]);
  assert.deepStrictEqual(whatsNewSince(entries, '1.3.21', '1.3.23'), [{ version: '1.3.23', notes: ['A'] }, { version: '1.3.22', notes: ['B'] }]);
  // a build of 1.3.22 made after lines went under next carries that work too: one entry, both sets of lines
  assert.deepStrictEqual(whatsNewSince(entries, '1.3.21', '1.3.22'), [{ version: '1.3.22', notes: ['A', 'B'] }]);
  assert.deepStrictEqual(whatsNewSince([{ version: '1.3.24', notes: ['Z'] }].concat(released), '1.3.21', '1.3.22'), [{ version: '1.3.22', notes: ['B'] }]);
});

test('with no version kept yet, just this version', () => {
  assert.deepStrictEqual(whatsNewSince(released, null, '1.3.22'), [{ version: '1.3.22', notes: ['B'] }]);
  assert.deepStrictEqual(whatsNewSince(released, null, '1.3.19'), []);
  assert.deepStrictEqual(whatsNewSince([{ version: '1.3.22', notes: [] }, { version: '1.3.22' }], null, '1.3.22'), []); // nothing written: no card
});

test('the notes file: newest first, a version or next on each entry, plain lines, no emoji', () => {
  assert.ok(WHATS_NEW.length >= 1);
  WHATS_NEW.forEach((e, i) => {
    assert.match(e.version, /^(next|\d+\.\d+\.\d+)$/, 'entry ' + i);
    if (e.version === 'next') assert.strictEqual(i, 0, "'next' is the top entry only");
    assert.ok(Array.isArray(e.notes) && e.notes.length, e.version + ' has lines');
    e.notes.forEach((n) => {
      assert.ok(typeof n === 'string' && n.trim().length > 8, e.version + ': a line');
      assert.doesNotMatch(n, /\p{Extended_Pictographic}/u, e.version + ': no emoji');
    });
    if (i && WHATS_NEW[i - 1].version !== 'next') assert.ok(whatsNewNewer(WHATS_NEW[i - 1].version, e.version), 'newest first at ' + e.version);
  });
});

test('npm run release stamps the version on the next entry, and refuses a release with no lines', () => {
  const src = "const WHATS_NEW=[\n  {version:'next',notes:['A']},\n  {version:'1.3.22',notes:['B']}\n];";
  const out = stamp(src, '1.3.23');
  assert.ok(out.includes("{version:'1.3.23',notes:['A']}"));
  assert.ok(!out.includes("'next'"));
  assert.strictEqual(stamp(out, '1.3.23'), out); // run twice: nothing more to do
  assert.strictEqual(stamp(src, 'v1.3.22'), src); // the version is already in the file
  assert.throws(() => stamp(out, '1.3.24'), /No notes for 1.3.24/);
  assert.throws(() => stamp("{version:'1.3.22',notes:['B']}", '1.3.2'), /No notes for 1\.3\.2:/); // 1.3.22 is not 1.3.2
});

test('the release page leads with what changed', () => {
  assert.deepStrictEqual(notesFor('1.3.21', released), ['C1', 'C2']);
  assert.deepStrictEqual(notesFor('v1.3.22', entries), ['A', 'B']);
  assert.strictEqual(notesFor('1.0.0', released), null);
  const e = WHATS_NEW.find((x) => x.version !== 'next');
  const notes = releaseNotes(e.version);
  assert.ok(notes.startsWith('## What changed\n\n- '), notes.slice(0, 40));
  assert.ok(notes.includes('- ' + e.notes[0]));
  assert.ok(notes.includes('Romulus-Setup-' + e.version + '.exe'));
});

// the page: the card after an update, nothing on a fresh install, the version kept either way
async function page(version, store, desktop) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'whats-new.js'), 'utf8');
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, hidden: true, textContent: '', className: '', children: [], on: {}, appendChild(c) { this.children.push(c); return c; }, addEventListener(n, f) { this.on[n] = f; } });
  let made = 0;
  const sandbox = {
    window: desktop ? { desktop } : { ROMULUS_VERSION: version },
    document: { createElement: (tag) => el(tag + '#' + (++made)) },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    $: el, WELCOME_KEY: 'tasks.welcomed.v1',
  };
  vm.runInNewContext(src, sandbox);
  await new Promise((r) => setImmediate(r));
  return els;
}

test('the card shows once after an update, with Got it; a fresh install sees nothing', async () => {
  const current = WHATS_NEW[0].version === 'next' ? '9.9.9' : WHATS_NEW[0].version;
  // an installed copy that ran an older version
  let store = { [WHATS_NEW_SEEN_KEY]: '0.0.1', 'tasks.welcomed.v1': '1' };
  let els = await page(current, store);
  assert.strictEqual(els.whatsNewCard.hidden, false);
  assert.strictEqual(els.whatsNewTitle.textContent, 'What’s new in Romulus ' + current);
  assert.ok(els.whatsNewList.children.length >= WHATS_NEW[0].notes.length);
  assert.strictEqual(store[WHATS_NEW_SEEN_KEY], current);
  els.whatsNewOk.on.click();
  assert.strictEqual(els.whatsNewCard.hidden, true);
  // Settings → Updates: the lines again
  assert.strictEqual(els.updateNotes.hidden, false);
  assert.strictEqual(els.updateNotes.textContent, 'What changed in ' + current);
  els.updateNotes.on.click();
  assert.strictEqual(els.updateNotesList.hidden, false);
  assert.strictEqual(els.updateNotesList.children.length, WHATS_NEW[0].notes.length);
  // opened again: the version is known, no card
  els = await page(current, store);
  assert.strictEqual(els.whatsNewCard.hidden, true);
  // the first version that keeps one: an install that has been through the welcome card is an update
  store = { 'tasks.welcomed.v1': '1' };
  els = await page(current, store);
  assert.strictEqual(els.whatsNewCard.hidden, false);
  // a fresh install
  store = {};
  els = await page(current, store);
  assert.strictEqual(els.whatsNewCard.hidden, true);
  assert.strictEqual(store[WHATS_NEW_SEEN_KEY], current);
  // the computer asks main/updater.js for its version
  store = { [WHATS_NEW_SEEN_KEY]: '0.0.1' };
  els = await page(null, store, { updateVersion: () => Promise.resolve(current) });
  assert.strictEqual(els.whatsNewCard.hidden, false);
  // a plain browser has no version: nothing shown, nothing kept
  store = {};
  els = await page(null, store, {});
  assert.strictEqual(els.whatsNewCard, undefined);
  assert.strictEqual(store[WHATS_NEW_SEEN_KEY], undefined);
});
