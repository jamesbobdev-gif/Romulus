/* Turning on end-to-end encryption (renderer/js/settings.js syncMoveToV2) rotates the sync key: the plain rows sat
   under the key itself, so the project already holds it, and sealing under it would keep nothing from whoever had
   that access. syncV2Moves plans the copy; it is read out of the page script here and run with the page's helpers. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'settings.js'), 'utf8').replace(/\r\n/g, '\n');
const fn = (name) => { const m = new RegExp('\\n(function ' + name + '\\([^)]*\\)\\{[\\s\\S]*?\\n\\})\\n').exec(src); assert.ok(m, name + ' is in settings.js'); return m[1]; };
const line = (re) => { const m = re.exec(src); assert.ok(m, re); return m[0]; };
const deriveSyncKey = (personalKey, list) => { const id = String(personalKey || '').replace(/^tk_/, ''); return id ? 'tk_' + list + '_' + id : ''; }; // sync.js
const validProfile = (p) => !!(p && p.url && p.key && p.syncKey);
const syncV2Moves = new Function('deriveSyncKey', 'validProfile',
  line(/const SYNC_SIDE_ROWS=\{[^\n]*\};/) + '\n' + fn('syncV2Moves') + '\nreturn syncV2Moves;')(deriveSyncKey, validProfile);
const SYNC_MOVED = new Function(line(/const SYNC_MOVED=\{[^\n]*\};/) + '\nreturn SYNC_MOVED;')();

const OLD = 'tk_11111111-1111-4111-8111-111111111111', NEW = 'tk_22222222-2222-4222-8222-222222222222';
const prof = (syncKey, more) => Object.assign({ url: 'https://x.supabase.co', key: 'anon', syncKey }, more);

test('every list and side row is copied from the old plain key to a new sealed key the project never saw', () => {
  const c = { personal: prof(OLD), work: prof(deriveSyncKey(OLD, 'work'), { derived: true }), agent: prof(deriveSyncKey(OLD, 'agent'), { derived: true }), school: prof(deriveSyncKey(OLD, 'school'), { derived: true }) };
  const moves = syncV2Moves(c, NEW, {});
  for (const m of moves) {
    assert.strictEqual(m.from.v2, false); assert.strictEqual(m.to.v2, true);
    assert.ok(m.from.syncKey.startsWith(m.oldBase) && m.to.syncKey.startsWith(m.newBase));
    assert.ok(m.from.syncKey.includes('1111') && !m.from.syncKey.includes('2222'), 'from the old key');
    assert.ok(m.to.syncKey.includes('2222') && !m.to.syncKey.includes('1111'), 'to the new key, never the old');
    assert.strictEqual(m.to.syncKey.slice(m.newBase.length), m.sfx); // the same side row
  }
  assert.deepStrictEqual(moves.filter((m) => m.ws === 'personal').map((m) => m.to.syncKey), [NEW, NEW + ':ideas', NEW + ':hours', NEW + ':updates', NEW + ':finance']);
  assert.strictEqual(moves.find((m) => m.ws === 'agent').newBase, 'tk_agent_' + NEW.slice(3)); // derived lists follow the new personal key
  assert.strictEqual(moves.find((m) => m.ws === 'agent' && m.sfx === ':locked').newBase, 'tk_agent_' + NEW.slice(3)); // its cipher key follows too (syncCopyRows)
  assert.strictEqual(moves.filter((m) => m.ws === 'agent').length, 8);
});

test('a list with a key of its own gets a fresh key of its own, in the shape it needs', () => {
  const own = 'tk_agent_33333333-3333-4333-8333-333333333333';
  const c = { personal: prof(OLD), agent: prof('tk_agent_old-own-key-0000000000000') };
  const moves = syncV2Moves(c, NEW, { agent: own });
  assert.ok(moves.filter((m) => m.ws === 'agent').every((m) => m.newBase === own && m.to.syncKey.startsWith(own)));
  assert.throws(() => syncV2Moves(c, NEW, {}), /no new key for the agent list/); // never silently sealed under the key the project holds
  assert.throws(() => syncV2Moves(c, OLD, { agent: own }), /no new key for the personal list/);
});

test('a list already encrypted is left where it is; the old rows get the moved marker, which the database then keeps plain writes off', () => {
  const c = { personal: prof(OLD, { v2: true }), work: prof(deriveSyncKey(OLD, 'work'), { derived: true, v2: true }) };
  assert.deepStrictEqual(syncV2Moves(c, NEW, {}), []);
  assert.strictEqual(SYNC_MOVED.moved, 'v2');
  assert.strictEqual(SYNC_MOVED.rotated, true);
});
