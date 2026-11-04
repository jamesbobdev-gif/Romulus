const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const worker = require('../agent/worker');

// renderer/js/init.js claimIsMine on its own (the rest of init.js starts the whole page)
function claimIsMine() {
  const src = fs.readFileSync(path.join(__dirname, '../renderer/js/init.js'), 'utf8');
  const fn = src.match(/function claimIsMine\(t,host\)\{[\s\S]*?\r?\n\}/);
  assert.ok(fn, 'init.js has claimIsMine');
  const ctx = {}; vm.createContext(ctx); vm.runInContext(fn[0] + ';this.claimIsMine=claimIsMine;', ctx);
  return ctx.claimIsMine;
}

test('opening the app on one computer leaves the mini PC\'s running tasks alone', () => {
  const mine = claimIsMine(), now = Date.now();
  assert.strictEqual(mine({ claimedBy: 'relay@lupa-BYNUC13PG', claimedAt: now - 60000 }, 'DESKTOP-82R42T6'), false, 'Lupa is on it');
  assert.strictEqual(mine({ claimedBy: 'relay@DESKTOP-82R42T6', claimedAt: now - 60000 }, 'DESKTOP-82R42T6'), true, 'its own run, cut off by the restart');
  assert.strictEqual(mine({ claimedBy: 'claude@DESKTOP-82R42T6' }, 'DESKTOP-82R42T6'), true);
  assert.strictEqual(mine({}, 'DESKTOP-82R42T6'), true, 'nobody claimed it');
  assert.strictEqual(mine({ claimedBy: 'relay@lupa-BYNUC13PG', claimedAt: now - 4 * 3600e3 }, 'DESKTOP-82R42T6'), true, 'left for hours: back in the queue');
  assert.strictEqual(mine({ claimedBy: 'relay@lupa-BYNUC13PG', claimedAt: now }, null), true, 'no name to compare: as before');
});

test('the heartbeat says what it is doing and which version it runs', () => {
  const doing = { what: 'task', id: 'x', title: 'Homework: Gas Giants', step: 7, of: 40, on: 'browser_click', since: 1, stepAt: 2 };
  const hb = worker.heartbeat({ name: 'Lupa', model: 'holo4', busy: true, doing, version: '1.0.25' }, 5);
  assert.deepStrictEqual(hb.doing, doing);
  assert.strictEqual(hb.version, '1.0.25');
  const idle = worker.heartbeat({ name: 'Lupa', busy: false }, 5);
  assert.ok(!('doing' in idle) && !('version' in idle));
  // the other computers still read it the same way
  assert.strictEqual(worker.freshWorker(hb, 5).busy, true);
});
