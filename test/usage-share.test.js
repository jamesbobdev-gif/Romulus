const test = require('node:test');
const assert = require('node:assert');
const u = require('../renderer/js/usage-share');

const NOW = Date.UTC(2026, 10, 27, 12);
const HOUR = 3600000;
const pcRows = [
  { id: 'claude', name: 'Claude · 5h', pct: 0.2512, text: '25% used · resets 3:00 PM', out: false, share: NOW + 2 * HOUR },
  { id: 'claude', name: 'Claude · week', pct: 0.58, text: '58% used', out: false, share: true },
  { id: 'gemini', name: 'Gemini', pct: null, text: 'no key yet', out: false, share: false },
];

test('only real readings are posted, with when they reset', () => {
  const mine = u.usageShareMine(pcRows, NOW);
  assert.deepStrictEqual(Object.keys(mine.rows), ['claude']);
  assert.deepStrictEqual(mine.rows.claude[0], { name: 'Claude · 5h', pct: 0.251, text: '25% used · resets 3:00 PM', out: false, until: NOW + 2 * HOUR });
  assert.strictEqual(mine.rows.claude[1].until, undefined);
  assert.strictEqual(u.usageShareMine([pcRows[2]], NOW), null); // a computer with nothing signed in posts nothing
});

test('a first reading goes up at once, a changed one every 15 minutes, an unchanged one never', () => {
  const mine = u.usageShareMine(pcRows, NOW);
  assert.strictEqual(u.usageShareChanged(undefined, mine, NOW), true);
  assert.strictEqual(u.usageShareChanged(mine, u.usageShareMine(pcRows, NOW + HOUR), NOW + HOUR), false);
  const moved = u.usageShareMine([Object.assign({}, pcRows[0], { pct: 0.4 }), pcRows[1]], NOW + 60000);
  assert.strictEqual(u.usageShareChanged(mine, moved, NOW + 60000), false);
  assert.strictEqual(u.usageShareChanged(mine, moved, NOW + u.USAGE_SHARE_EVERY), true);
  assert.strictEqual(u.usageShareChanged(mine, null, NOW + HOUR), false);
  // the database hands keys back in another order: still the same reading
  const back = { rows: { claude: mine.rows.claude.map((r) => ({ out: r.out, text: r.text, until: r.until, pct: r.pct, name: r.name })) }, at: NOW };
  assert.strictEqual(u.usageShareChanged(back, mine, NOW + HOUR), false);
});

test('a device with no reading of its own shows the newest one another device posted', () => {
  const doc = { devices: {
    pc: { name: 'Desk', usage: u.usageShareMine(pcRows, NOW - HOUR) },
    old: { name: 'Laptop', usage: { at: NOW - 3 * HOUR, rows: { claude: [{ name: 'Claude', pct: 0.9, text: 'old', out: false }] } } },
    stale: { name: 'Attic', usage: { at: NOW - u.USAGE_SHARE_KEEP - 1, rows: { groq: [{ name: 'Groq', pct: null, text: 'x', out: false }] } } },
    lupa: { name: 'Lupa', usage: { at: NOW, rows: { claude: [{ name: 'mine', pct: 1, text: 'mine', out: false }] } } },
  } };
  const others = u.usageShareOthers(doc, 'lupa', NOW);
  assert.deepStrictEqual(Object.keys(others), ['claude']);
  assert.strictEqual(others.claude.from, 'Desk');
  const local = [{ id: 'claude', name: 'Claude', pct: null, text: 'not signed in on this computer', out: false, share: false }];
  const rows = u.usageShareMerge(local, others, ['claude'], NOW);
  assert.deepStrictEqual(rows.map((r) => r.text), ['25% used · resets 3:00 PM · from Desk', '58% used · from Desk']);
  assert.strictEqual(rows[0].pct, 0.251);
});

test('its own reading wins, and AIs only another device uses are added after', () => {
  const others = { claude: { rows: [{ name: 'Claude', pct: 0.9, text: 'theirs', out: false }], from: 'Desk', at: NOW },
    gemini: { rows: [{ name: 'Gemini', pct: null, text: '4 today', out: false }], from: 'Desk', at: NOW } };
  const local = [{ id: 'claude', name: 'Claude · 5h', pct: 0.1, text: '10% used', out: false, share: true }];
  const rows = u.usageShareMerge(local, others, ['claude'], NOW);
  assert.deepStrictEqual(rows.map((r) => r.text), ['10% used', '4 today · from Desk']);
  assert.deepStrictEqual(u.usageShareMerge([], {}, [], NOW), []);
});

test('a window that has reset since it was read shows as empty, not as the old number', () => {
  const r = u.usageShareRow({ name: 'Claude · 5h', pct: 0.8, text: '80% used', out: false, until: NOW - 1 }, 'Desk', NOW);
  assert.deepStrictEqual(r, { name: 'Claude · 5h', pct: 0, text: 'has reset since it was read · from Desk', out: false });
  const out = u.usageShareRow({ name: 'Claude', pct: 1, text: 'out until 3 PM', out: true, until: NOW + 5 }, 'Desk', NOW);
  assert.strictEqual(out.out, true);
});
