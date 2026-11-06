const test = require('node:test');
const assert = require('node:assert');
const d = require('../renderer/js/devices');

const NOW = Date.UTC(2026, 10, 6, 12);
const pair = async () => {
  const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const j = await crypto.subtle.exportKey('jwk', k.publicKey);
  return { priv: k.privateKey, pub: { kty: j.kty, crv: j.crv, x: j.x, y: j.y } };
};

test('a heartbeat adds or updates this device and keeps the others', () => {
  const me = { name: 'Desk', kind: 'computer', os: 'Windows', version: '1.0.28', pub: null };
  const doc = { v: 1, devices: { phone: { name: 'Pixel', seen: 5 } } };
  const out = d.devicesWithMe(doc, 'pc', me, NOW);
  assert.deepStrictEqual(Object.keys(out.devices).sort(), ['pc', 'phone']);
  assert.strictEqual(out.devices.pc.added, NOW);
  const later = d.devicesWithMe(out, 'pc', Object.assign({}, me, { name: 'Office' }), NOW + 1000);
  assert.strictEqual(later.devices.pc.added, NOW);
  assert.strictEqual(later.devices.pc.name, 'Office');
  assert.strictEqual(doc.devices.pc, undefined); // the doc read isn't changed in place
});

test('a heartbeat goes up only when something changed or an hour went by', () => {
  const me = { name: 'Desk', kind: 'computer', os: 'Windows', version: '1.0.28', pub: null };
  const doc = d.devicesWithMe(null, 'pc', me, NOW);
  assert.strictEqual(d.devicesNeedBeat(doc, 'pc', me, NOW + 60000), false);
  assert.strictEqual(d.devicesNeedBeat(doc, 'pc', me, NOW + d.DEVICES_BEAT_MS), true);
  assert.strictEqual(d.devicesNeedBeat(doc, 'pc', Object.assign({}, me, { version: '1.0.29' }), NOW + 1), true);
  assert.strictEqual(d.devicesNeedBeat(doc, 'other', me, NOW), true);
});

test('the list puts this device first, then the latest seen', () => {
  const doc = { devices: { a: { seen: 1 }, b: { seen: 3 }, me: { seen: 2 } } };
  assert.deepStrictEqual(d.devicesList(doc, 'me').map((x) => x.id), ['me', 'b', 'a']);
  assert.deepStrictEqual(d.devicesList(null, 'me'), []);
});

test('labels', () => {
  assert.strictEqual(d.devicesSeenLabel(NOW - 5 * 60000, NOW), 'active in the last hour');
  assert.strictEqual(d.devicesSeenLabel(NOW - 5 * 3600000, NOW), 'seen 5 hours ago');
  assert.strictEqual(d.devicesSeenLabel(NOW - 30 * 3600000, NOW), 'seen yesterday');
  assert.strictEqual(d.devicesSeenLabel(NOW - 4 * 86400000, NOW), 'seen 4 days ago');
  assert.strictEqual(d.devicesKindLabel({ kind: 'phone', os: 'Android' }), 'Android phone');
  assert.strictEqual(d.devicesKindLabel({ kind: 'computer', os: 'Windows' }), 'Windows computer');
});

test('the hand-off opens only with the kept device\'s own key', async () => {
  const phone = await pair(), lupa = await pair(), removed = await pair();
  const doc = { devices: { phone: { name: 'Pixel', pub: phone.pub }, lupa: { name: 'Lupa', pub: lupa.pub }, old: { name: 'Old laptop' }, gone: { name: 'Lost', pub: removed.pub } } };
  const secret = JSON.stringify({ personal: { url: 'https://x.supabase.co', key: 'k', syncKey: 'tk_new' } });
  const h = await d.devicesHandoff(doc, ['phone', 'lupa', 'old'], secret);
  assert.deepStrictEqual(Object.keys(h.handoff).sort(), ['lupa', 'phone']);
  assert.deepStrictEqual(h.left, ['Old laptop']);
  assert.strictEqual(await d.devicesOpen(phone.priv, h.handoff.phone), secret);
  assert.strictEqual(await d.devicesOpen(lupa.priv, h.handoff.lupa), secret);
  assert.ok(!JSON.stringify(h).includes('tk_new')); // nothing readable in what's stored
  await assert.rejects(d.devicesOpen(removed.priv, h.handoff.phone)); // the removed device can't open anyone's
});
