/* The WebFetch/WebSearch hook (agent/web-guard.js), loaded as a module: this computer and its network are refused by
   address and by what a name resolves to, and both tools are off once the run has seen his mail. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const guard = require('../agent/web-guard');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-web-guard-'));
const taint = path.join(tmp, 'mail-seen.json');
const fetchOf = (url) => JSON.stringify({ tool_name: 'WebFetch', tool_input: { url } });
// a resolver for the tests: nip.io-style names answer with the address in them, everything else is on the internet
const lookup = async (h) => {
  const m = /^(\d+)-(\d+)-(\d+)-(\d+)\.nip\.example$/.exec(h);
  if (m) return [{ address: m.slice(1, 5).join('.'), family: 4 }];
  if (h === 'both.example') return [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
  if (h === 'six.example') return [{ address: 'fd12::1', family: 6 }];
  if (h === 'gone.example') throw new Error('ENOTFOUND');
  return [{ address: '93.184.216.34', family: 4 }];
};

test('private addresses are refused by their address', async () => {
  for (const u of ['http://127.0.0.1:9222/json', 'http://localhost/', 'http://192.168.1.1/', 'http://10.1.2.3/', 'http://[::1]/', 'http://hub/', 'file:///C:/x', 'http://0x7f000001/', 'http://2130706433/'])
    assert.strictEqual((await guard.decide(fetchOf(u), '', lookup)).code, 2, u);
  assert.strictEqual((await guard.decide(fetchOf('https://example.com/page'), '', lookup)).code, 0);
});

test('a public-looking name that resolves to this computer or the LAN is refused too', async () => {
  for (const u of ['http://127-0-0-1.nip.example:9222/json/list', 'http://192-168-1-1.nip.example/', 'https://both.example/', 'https://six.example/'])
    assert.match((await guard.decide(fetchOf(u), '', lookup)).reason, /not this computer or its network/, u);
  assert.strictEqual((await guard.decide(fetchOf('https://gone.example/'), '', lookup)).code, 0); // can't resolve: the fetch fails on its own
  assert.strictEqual((await guard.decide(fetchOf('https://93-184-216-34.nip.example/'), '', lookup)).code, 0);
});

test('once the run has seen his mail, both web tools are off', async () => {
  assert.strictEqual((await guard.decide(JSON.stringify({ tool_name: 'WebSearch', tool_input: { query: 'x' } }), taint, lookup)).code, 0);
  fs.writeFileSync(taint, '{}');
  const r = await guard.decide(JSON.stringify({ tool_name: 'WebSearch', tool_input: { query: 'x' } }), taint, lookup);
  assert.strictEqual(r.code, 2); assert.match(r.reason, /WebSearch is off for the rest of this run/);
  assert.strictEqual((await guard.decide(fetchOf('https://example.com/'), taint, lookup)).code, 2);
  assert.strictEqual((await guard.decide('not json', taint, lookup)).code, 2); // an unreadable call is still refused while tainted
});
