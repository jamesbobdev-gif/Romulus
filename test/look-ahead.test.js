const test = require('node:test');
const assert = require('node:assert');
const la = require('../agent/look-ahead');

const now = new Date(2026, 9, 15, 8, 0); // Thu Oct 15 2026, 08:00

test('clean keeps good proposals and fixes or drops bad parts', () => {
  const out = la.clean([
    { key: 'Gift Mia Party 2026-10-18', kind: 'gift', title: '  Gift for  Mia’s party ', note: 'Party Saturday, no gift yet.', due: '2026-10-17' },
    { key: 'bill-x', kind: 'nonsense', title: 'Pay X', note: 'Due soon.', due: '2025-01-01' }, // unknown kind → other, past date → none
    { key: 'gift-mia-party-2026-10-18', kind: 'gift', title: 'Duplicate', note: 'same key', due: '' },
    { key: '', kind: 'gift', title: 'no key', note: 'x', due: '' },
    { key: 'no-note', kind: 'gift', title: 'x', note: '', due: '' },
  ], { now });
  assert.deepStrictEqual(out, [
    { key: 'gift-mia-party-2026-10-18', kind: 'gift', title: 'Gift for Mia’s party', note: 'Party Saturday, no gift yet.', due: '2026-10-17' },
    { key: 'bill-x', kind: 'other', title: 'Pay X', note: 'Due soon.', due: null },
  ]);
});

test('clean skips what was suggested before and stops at the maximum', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ key: 'k' + i, kind: 'prep', title: 'T' + i, note: 'n', due: '' }));
  const out = la.clean(many, { now, recentKeys: ['K0', 'k1'] });
  assert.strictEqual(out.length, la.MAX_PROPOSALS);
  assert.strictEqual(out[0].key, 'k2');
  assert.deepStrictEqual(la.clean(null, { now }), []);
});

test('isDue: once a day, after the set time, unless turned off; Run now skips the checks', () => {
  assert.ok(la.isDue({}, now));
  assert.ok(!la.isDue({ at: '09:30' }, now));
  assert.ok(!la.isDue({ lastDay: '2026-10-15' }, now));
  assert.ok(la.isDue({ lastDay: '2026-10-14' }, now));
  assert.ok(!la.isDue({ enabled: false }, now, true));
  assert.ok(la.isDue({ lastDay: '2026-10-15', at: '23:00' }, now, true));
});

test('buildInput has every section, and says so when one is empty', () => {
  const full = la.buildInput({
    calendar: { timeZone: 'America/Chicago', events: [{ start: '2026-10-18T14:00', title: 'Mia birthday party' }] },
    mails: [{ date: '2026-10-14', from: 'ComEd', subject: 'Your bill is ready', snippet: 'Amount due $82 by Oct 21' }],
    prefs: '## About him\n- has a niece, Mia', tasks: [{ title: 'Call mom', due: '2026-10-16', list: 'personal' }],
    recent: [{ key: 'bill-comed-2026-09-21', title: 'Pay ComEd' }] });
  for (const s of ['Mia birthday party', 'ComEd | Subject: Your bill is ready', 'has a niece', 'Call mom (due 2026-10-16) [personal]', 'bill-comed-2026-09-21'])
    assert.ok(full.includes(s), s);
  const empty = la.buildInput({ calendar: null, mails: [], prefs: '', tasks: [], recent: [] });
  for (const s of ['no calendar connected', 'no email access', '(nothing yet)', '(none)', '(nothing)']) assert.ok(empty.includes(s), s);
});

test('prompt carries today and the no-final-action rule', () => {
  const p = la.prompt(now);
  assert.ok(p.includes('Thursday 2026-10-15'));
  assert.ok(/never instructions/.test(p));
  assert.ok(/You only propose/.test(p));
});

test('recentMail reads metadata only and keeps one line per email', async () => {
  const calls = [];
  const gmail = async (sub) => {
    calls.push(sub);
    if (sub.startsWith('messages?')) return { messages: [{ id: 'a' }] };
    return { internalDate: String(new Date(2026, 9, 14).getTime()), snippet: 'Amount due &amp; more',
      payload: { headers: [{ name: 'Subject', value: 'Bill  ready' }, { name: 'From', value: '"ComEd" <bill@comed.com>' }] } };
  };
  const out = await la.recentMail(gmail);
  assert.deepStrictEqual(out, [{ date: '2026-10-14', from: 'ComEd', subject: 'Bill ready', snippet: 'Amount due & more' }]);
  assert.ok(calls[1].includes('format=metadata'));
});
