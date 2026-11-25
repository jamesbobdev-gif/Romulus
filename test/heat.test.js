const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const heat = require('../agent/heat');

function zones(list) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heat-'));
  list.forEach(([type, temp], i) => {
    const z = path.join(dir, 'thermal_zone' + i);
    fs.mkdirSync(z);
    fs.writeFileSync(path.join(z, 'type'), type + '\n');
    fs.writeFileSync(path.join(z, 'temp'), temp + '\n');
  });
  return dir;
}

test('reads the hottest processor sensor and leaves the others out', () => {
  assert.strictEqual(heat.readTemp(zones([['acpitz', 99000], ['x86_pkg_temp', 71000], ['TCPU', 74000]])), 74);
  assert.strictEqual(heat.readTemp(zones([['acpitz', 27800], ['nvme', 45000]])), null);
  assert.strictEqual(heat.readTemp(zones([['x86_pkg_temp', 0], ['coretemp', 'junk']])), null); // not real readings
  assert.strictEqual(heat.readTemp(path.join(os.tmpdir(), 'no-such-folder-' + Date.now())), null); // Windows, Mac
});

test('cool or unreadable: the call goes straight ahead', async () => {
  let slept = 0; const sleep = async () => { slept++; };
  assert.deepStrictEqual(await heat.waitCool({ read: () => 70, sleep }), { waited: 0, from: null, to: 70 });
  assert.deepStrictEqual(await heat.waitCool({ read: () => null, sleep }), { waited: 0, from: null, to: null });
  assert.strictEqual(slept, 0);
});

test('hot: it waits until the processor has cooled, and says so once', async () => {
  const temps = [95, 93, 88, 81]; const said = [];
  const r = await heat.waitCool({ read: () => temps.shift(), sleep: async () => {}, log: (m) => said.push(m) });
  assert.deepStrictEqual(r, { waited: 15000, from: 95, to: 81 });
  assert.strictEqual(said.length, 1);
  assert.match(said[0], /95 °C, waited 15 s \(now 81 °C\)/);
});

test('a sensor that never comes down, or stops answering, does not hold the model for long', async () => {
  const stuck = await heat.waitCool({ read: () => 97, sleep: async () => {} });
  assert.strictEqual(stuck.waited, heat.MAX_WAIT_MS);
  const temps = [97, null];
  const gone = await heat.waitCool({ read: () => temps.shift(), sleep: async () => {} });
  assert.deepStrictEqual(gone, { waited: 5000, from: 97, to: null });
});
