const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const hub = require('../main/hub');

const TOKEN = 'a'.repeat(64);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-hub-'));
let config = { hub: { role: 'server', port: 0, hubToken: TOKEN, cdpPort: 0 }, agentRunner: { enabled: true } };
let reloaded = 0;
hub.init({ readConfig: () => JSON.parse(JSON.stringify(config)), writeConfig: (c) => { config = c; }, userData: () => dir,
  agentLog: () => {}, sendToRenderer: () => {}, reloadWindow: () => { reloaded++; }, version: '1.0.0' });

// a stand-in for the agent browser's DevTools socket: it answers the handshake and keeps what it was sent
const gotByCdp = [];
const cdp = http.createServer();
const cdpSocks = [];
cdp.on('upgrade', (req, sock) => {
  cdpSocks.push(sock);
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  assert.strictEqual(req.headers.origin, undefined);
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 6) {
      const len = buf[1] & 0x7f; // small test frames only
      if (buf.length < 6 + len) break;
      const key = buf.subarray(2, 6), data = Buffer.from(buf.subarray(6, 6 + len)).map((b, i) => b ^ key[i & 3]);
      const op = buf[0] & 0x0f;
      buf = buf.subarray(6 + len);
      if (op !== 1) continue; // the close at the end
      gotByCdp.push(JSON.parse(data.toString()).method);
      const reply = Buffer.from('{"ok":1}');
      sock.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
    }
  });
});

let base;
const handlers = {
  'ai:status': async (_e, x) => ({ order: ['claude', 'gemini', 'openrouter'], x }),
  'live:pages': async () => ({ up: true, pages: [{ id: 'ABCDEF1234567890', title: 'Walmart', url: 'https://walmart.com', ws: 'ws://127.0.0.1:9334/devtools/page/ABCDEF1234567890' }] }),
  'tasks:save': async () => true, // never reachable through the hub
};
test.before(async () => {
  await new Promise((r) => cdp.listen(0, '127.0.0.1', r));
  config.hub.cdpPort = cdp.address().port;
  const s = await hub.startServer(handlers);
  base = 'http://127.0.0.1:' + s.address().port;
});
test.after(() => { hub.stopServer(); cdp.close(); cdp.closeAllConnections(); cdpSocks.forEach((x) => x.destroy()); });
const post = (p, body, token = TOKEN) => fetch(base + p, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('every call needs the hub token', async () => {
  assert.strictEqual((await fetch(base + '/hub/ping')).status, 401);
  assert.strictEqual((await fetch(base + '/hub/ping', { headers: { Authorization: 'Bearer ' + 'b'.repeat(64) } })).status, 401);
  const ok = await fetch(base + '/hub/ping', { headers: { Authorization: 'Bearer ' + TOKEN } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await ok.json()).role, 'server');
});

test('only allow-listed IPC calls are answered', async () => {
  const r = await post('/hub/ipc/ai:status', { args: [7] });
  assert.deepStrictEqual((await r.json()).result, { order: ['claude', 'gemini', 'openrouter'], x: 7 });
  assert.strictEqual((await post('/hub/ipc/tasks:save', { args: ['{}'] })).status, 404);
});

test('Watch: a one-time ticket, and only its own commands reach the browser', async () => {
  const pages = (await (await post('/hub/ipc/live:pages', { args: [] })).json()).result.pages;
  assert.match(pages[0].ws, /^\/hub\/live\/ws\/ABCDEF1234567890\?ticket=[0-9a-f]{48}$/);
  const url = base.replace('http', 'ws') + pages[0].ws;
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const replies = [];
  ws.onmessage = (m) => replies.push(m.data);
  ws.send(JSON.stringify({ id: 1, method: 'Page.startScreencast', params: {} }));
  ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: 'document.cookie' } }));
  ws.send(JSON.stringify({ id: 3, method: 'Network.getAllCookies' }));
  ws.send(JSON.stringify({ id: 4, method: 'Input.insertText', params: { text: 'hi' } }));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(gotByCdp, ['Page.startScreencast', 'Input.insertText']);
  assert.strictEqual(replies.length, 2);
  ws.close();
  // the same ticket can't be used twice
  const again = new WebSocket(url);
  const failed = await new Promise((res) => { again.onopen = () => res(false); again.onerror = () => res(true); });
  assert.ok(failed);
});

test('the laptop hands its settings over; the hub keeps its own and no Windows paths', async () => {
  config.calAccounts = [{ id: 'g1', provider: 'google', tokens: { refresh_token: 'old' } }];
  const r = await post('/hub/import', { config: { hub: { role: 'client', url: 'x' }, loginInit: true, geminiKey: 'k',
    agentRunner: { command: 'C:\\Tools\\claude.exe', enabled: false, gmail: false },
    calAccounts: [{ id: 'g1', provider: 'google', tokens: { refresh_token: 'new' } }, { id: 'm1', provider: 'microsoft' }] },
    files: [{ name: 'task-howtos.json', text: '[]' }, { name: '../evil.js', text: 'x' }, { name: 'site-notes/walmart.com.md', text: '- tip' }] });
  assert.deepStrictEqual(await r.json(), { ok: true, files: 2 });
  assert.strictEqual(config.hub.role, 'server');
  assert.strictEqual(config.hub.hubToken, TOKEN);
  assert.strictEqual(config.loginInit, undefined);
  assert.strictEqual(config.geminiKey, 'k');
  assert.deepStrictEqual(config.agentRunner, { enabled: true, gmail: false });
  assert.deepStrictEqual(config.calAccounts.map((a) => a.id + ':' + (a.tokens ? a.tokens.refresh_token : '')), ['g1:new', 'm1:']);
  assert.ok(fs.existsSync(path.join(dir, 'site-notes', 'walmart.com.md')));
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.js')));
});

test('live run text streams to the laptop', async () => {
  const ac = new AbortController();
  const r = await fetch(base + '/hub/events', { headers: { Authorization: 'Bearer ' + TOKEN }, signal: ac.signal });
  const reader = r.body.getReader();
  await reader.read(); // hello
  hub.broadcast('agent:results', [{ id: 'x' }]); // not a display event: never streamed
  hub.broadcast('agent:live', { id: 't1', text: 'opening walmart.com' });
  const { value } = await reader.read();
  const text = Buffer.from(value).toString();
  assert.match(text, /"ch":"agent:live"/);
  assert.doesNotMatch(text, /agent:results/);
  ac.abort();
});
