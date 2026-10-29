/* The hub: the agent, its browser, mail and calendar work run on a mini PC ("server"), and the laptop's app is a
   "client" of it over Tailscale. config.json → hub: {role: 'server' | 'client', port, url, hubToken}. No hub
   config = everything runs on this computer, as before.
   Server: a small gateway inside this app's main process, on 127.0.0.1 only. `tailscale serve` publishes it to
   his tailnet (HTTPS, never Funnel), and every call needs the hub token. It answers an allow-listed set of the
   app's own IPC calls, streams the live run text, takes a one-time settings hand-over, and relays Watch to the
   agent browser with only the screen/mouse/keyboard commands Watch uses (no reading pages or cookies).
   Client: those IPC calls go to the gateway instead of running here. */
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PORT = 8790;
const CDP_PORT = 9334; // agent/agent-browser.js AGENT_BROWSER_PORT
// the app's IPC calls that belong to the hub: what the agent, mail, calendars and the agent browser do
const REMOTE = ['ai:status', 'ai:save', 'ai:gemini-install', 'ai:codex-install', 'ai:codex-login', 'ai:openrouter-check', 'ai:compat-check', 'ai:usage',
  'agent:retry', 'agent:open-browser', 'live:pages', 'live:open', 'live:start', 'local:status', 'routing:changed',
  'howtos:list', 'howtos:delete', 'howtos:compact', 'feeds:get', 'feeds:save', 'feeds:fetch',
  'mail:status', 'mail:set-enabled', 'mail:check', 'lookahead:status', 'lookahead:set-enabled', 'lookahead:tick', 'triggers:tick', 'agent:actions', 'agent:log',
  'cal:overview', 'cal:add-link', 'cal:remove', 'cal:set-prefs', 'cal:pull', 'gcal:sync-now', 'gcal:delete-event'];
// what the server's main process tells its window that the client's window shows too (display only:
// anything that changes tasks is applied by the server's window and reaches the laptop through sync)
const EVENTS = ['agent:live'];
// the only DevTools commands Watch sends (renderer/js/agent-live-view.js)
const LIVE_METHODS = new Set(['Page.enable', 'Page.bringToFront', 'Page.startScreencast', 'Page.stopScreencast', 'Page.screencastFrameAck',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText']);
// settings that stay with each computer when the laptop hands its settings over
const KEEP_HERE = ['hub', 'loginInit'];
// files of what the agent has learned, handed over with the settings (in the user-data folder)
const LEARNED_FILES = ['task-howtos.json', 'local-learned.json'];

let ctx = null; // { readConfig, writeConfig, userData, agentLog, sendToRenderer, reloadWindow, version }
let handlers = {};
function init(c) { ctx = c; }
const cfg = () => (ctx.readConfig().hub || {});
function role() { const r = cfg().role; return r === 'server' || r === 'client' ? r : null; }
const isClient = () => role() === 'client';
const log = (m) => ctx.agentLog('hub: ' + m);
const sameSecret = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length >= 32 && crypto.timingSafeEqual(x, y);
};

/* ── server ── */
const sse = new Set();
const relays = new Set(); // open Watch sockets
const tickets = new Map(); // one-time Watch tickets: ticket → {id, exp}
function newTicket(id) {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.exp < now) tickets.delete(k);
  const t = crypto.randomBytes(24).toString('hex');
  tickets.set(t, { id, exp: now + 2 * 60 * 1000 });
  return t;
}
function ensureToken() {
  const c = ctx.readConfig();
  c.hub = Object.assign({}, c.hub);
  if (!c.hub.hubToken || String(c.hub.hubToken).length < 32) { c.hub.hubToken = crypto.randomBytes(32).toString('hex'); ctx.writeConfig(c); }
  // for him to copy to the laptop (`cat ~/.config/Tasks/hub-token.txt` over SSH); only his user can read it
  try { fs.writeFileSync(path.join(ctx.userData(), 'hub-token.txt'), c.hub.hubToken + '\n', { mode: 0o600 }); } catch (e) {}
  return c.hub.hubToken;
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', (d) => { n += d.length; if (n > limit) { reject(new Error('too big')); req.destroy(); } else parts.push(d); });
    req.on('end', () => { try { resolve(n ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { reject(new Error('bad JSON')); } });
    req.on('error', reject);
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj === undefined ? null : obj)); };

// the laptop's settings arrive once: his sign-ins, keys, sync links and what the agent learned
function importSettings(body) {
  const incoming = body && typeof body.config === 'object' && body.config ? body.config : {};
  const c = ctx.readConfig();
  for (const [k, v] of Object.entries(incoming)) {
    if (KEEP_HERE.includes(k)) continue;
    if (k === 'calAccounts' && Array.isArray(v)) {
      const mine = Array.isArray(c.calAccounts) ? c.calAccounts : [];
      c.calAccounts = mine.filter((a) => !v.some((b) => b && b.id === a.id)).concat(v);
    } else if (k === 'agentRunner' && v && typeof v === 'object') {
      const r = Object.assign({}, v); delete r.command; delete r.enabled; // a Windows path; and the runner always works here
      c.agentRunner = Object.assign({}, c.agentRunner, r);
    } else c[k] = v;
  }
  ctx.writeConfig(c);
  let files = 0;
  for (const f of Array.isArray(body.files) ? body.files : []) {
    const name = String(f && f.name || '');
    const ok = LEARNED_FILES.includes(name) || /^site-notes\/[\w.-]+\.md$/.test(name);
    if (!ok || typeof f.text !== 'string' || f.text.length > 2 * 1024 * 1024) continue;
    const dest = path.join(ctx.userData(), ...name.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.text); files++;
  }
  log('settings handed over from ' + String(body.from || 'the laptop').slice(0, 60) + ' (' + Object.keys(incoming).length + ' settings, ' + files + ' files)');
  setTimeout(() => ctx.reloadWindow(), 500); // its page picks up the sync links
  return { ok: true, files };
}

async function onRequest(req, res) {
  const u = new URL(req.url, 'http://hub');
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!sameSecret(auth, cfg().hubToken)) return send(res, 401, { error: 'wrong or missing hub token' });
  try {
    if (req.method === 'GET' && u.pathname === '/hub/ping') return send(res, 200, { ok: true, role: 'server', host: os.hostname(), version: ctx.version });
    if (req.method === 'GET' && u.pathname === '/hub/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': hello\n\n');
      sse.add(res);
      const keep = setInterval(() => res.write(': keep\n\n'), 25 * 1000);
      req.on('close', () => { clearInterval(keep); sse.delete(res); });
      return;
    }
    if (req.method === 'POST' && u.pathname === '/hub/import') return send(res, 200, importSettings(await readBody(req, 20 * 1024 * 1024)));
    const m = /^\/hub\/ipc\/([a-z-]+:[a-z-]+)$/.exec(u.pathname);
    if (req.method === 'POST' && m) {
      const ch = m[1];
      if (!REMOTE.includes(ch) || !handlers[ch]) return send(res, 404, { error: 'not a hub call: ' + ch });
      const body = await readBody(req, 4 * 1024 * 1024);
      let out = await handlers[ch]({ hub: true }, ...(Array.isArray(body.args) ? body.args : []));
      if (ch === 'live:pages' && out && Array.isArray(out.pages)) {
        out = Object.assign({}, out, { pages: out.pages.map((p) => Object.assign({}, p, { ws: '/hub/live/ws/' + p.id + '?ticket=' + newTicket(p.id) })) });
      }
      return send(res, 200, { result: out });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: String(e && e.message || e).slice(0, 300) }); }
}

/* Watch: the laptop's page ↔ the agent browser's DevTools socket for one tab. What the browser sends goes
   through untouched (the picture); what the page sends is read frame by frame and only Watch's own commands
   are let through, so the socket can't be used to read pages, cookies or run code. */
function liveFilter(up, down) {
  let buf = Buffer.alloc(0);
  const fail = (why) => { log('watch: closed (' + why + ')'); try { down.destroy(); } catch (e) {} try { up.destroy(); } catch (e) {} };
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; const big = buf.readBigUInt64BE(2); if (big > 1048576n) return fail('frame too big'); len = Number(big); at = 10; }
      if (!masked) return fail('unmasked frame');
      if (len > 1048576) return fail('frame too big');
      if (buf.length < at + 4 + len) return;
      const frame = buf.subarray(0, at + 4 + len), key = buf.subarray(at, at + 4);
      buf = buf.subarray(at + 4 + len);
      if (op === 8 || op === 9 || op === 10) { up.write(frame); continue; } // close, ping, pong
      if (op !== 1 || !fin) return fail('not a whole text frame');
      const data = Buffer.alloc(len);
      for (let i = 0; i < len; i++) data[i] = frame[at + 4 + i] ^ key[i & 3];
      let msg = null; try { msg = JSON.parse(data.toString('utf8')); } catch (e) {}
      if (msg && LIVE_METHODS.has(msg.method)) up.write(frame);
      else log('watch: refused ' + String(msg && msg.method).slice(0, 60));
    }
  };
}
function onUpgrade(req, socket, head) {
  const u = new URL(req.url, 'http://hub');
  const m = /^\/hub\/live\/ws\/([A-Za-z0-9]{8,64})$/.exec(u.pathname);
  const t = tickets.get(u.searchParams.get('ticket') || '');
  if (!m || !t || t.id !== m[1] || t.exp < Date.now() || !req.headers['sec-websocket-key']) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
  }
  tickets.delete(u.searchParams.get('ticket'));
  const cdp = Number(cfg().cdpPort) || CDP_PORT;
  const up = net.connect(cdp, '127.0.0.1', () => {
    // no Origin: Chrome only takes DevTools sockets that don't come from a web page
    up.write('GET /devtools/page/' + m[1] + ' HTTP/1.1\r\nHost: 127.0.0.1:' + cdp + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + req.headers['sec-websocket-key'] + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    const filter = liveFilter(up, socket);
    if (head && head.length) filter(head);
    socket.on('data', filter);
    up.pipe(socket);
  });
  relays.add(socket); relays.add(up);
  const close = () => { relays.delete(socket); relays.delete(up); try { up.destroy(); } catch (e) {} try { socket.destroy(); } catch (e) {} };
  up.on('error', close); socket.on('error', close); up.on('close', close); socket.on('close', close);
}

let server = null;
function startServer(allHandlers) {
  handlers = allHandlers;
  ensureToken();
  const port = Number(cfg().port) || DEFAULT_PORT;
  server = http.createServer((req, res) => { onRequest(req, res); });
  server.on('upgrade', onUpgrade);
  server.on('error', (e) => log('gateway error: ' + e.message));
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => { log('gateway on 127.0.0.1:' + server.address().port); resolve(server); }));
}
function stopServer() { if (server) { server.close(); server.closeAllConnections(); } for (const res of sse) { try { res.end(); } catch (e) {} } sse.clear(); for (const x of relays) x.destroy(); relays.clear(); server = null; }
// the server's window gets an event: the client's window gets it too
function broadcast(ch, payload) {
  if (!EVENTS.includes(ch) || !sse.size) return;
  const line = 'data: ' + JSON.stringify({ ch, payload }) + '\n\n';
  for (const res of sse) { try { res.write(line); } catch (e) {} }
}

/* ── client ── */
const baseUrl = () => String(cfg().url || '').replace(/\/+$/, '');
async function call(pathname, opts = {}) {
  const c = cfg();
  if (!baseUrl() || !c.hubToken) throw new Error('The mini PC isn’t set up: Settings → Mini PC server');
  let r;
  try {
    r = await fetch(baseUrl() + pathname, { method: opts.body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + c.hubToken, 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(opts.timeout || 60 * 1000) });
  } catch (e) { throw new Error('The mini PC isn’t reachable (is Tailscale on?)'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'mini PC: HTTP ' + r.status);
  return j;
}
// an IPC call answered by the mini PC; long ones (mail, look-ahead, installs) get longer
const SLOW = ['mail:check', 'lookahead:tick', 'ai:gemini-install', 'ai:codex-install', 'ai:codex-login', 'howtos:compact', 'ai:usage', 'gcal:sync-now'];
async function forward(ch, args) {
  const j = await call('/hub/ipc/' + ch, { body: { args }, timeout: SLOW.includes(ch) ? 6 * 60 * 1000 : 60 * 1000 });
  let out = j.result;
  if (ch === 'live:pages' && out && Array.isArray(out.pages)) {
    const wsBase = baseUrl().replace(/^http/i, 'ws');
    out = Object.assign({}, out, { pages: out.pages.map((p) => Object.assign({}, p, { ws: wsBase + p.ws })) });
  }
  return out;
}
// the server's live run text, shown here too; reconnects by itself
let events = null;
function followEvents() {
  if (events) return;
  events = true;
  const loop = async () => {
    for (;;) {
      try {
        const c = cfg();
        const r = await fetch(baseUrl() + '/hub/events', { headers: { Authorization: 'Bearer ' + c.hubToken } });
        if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
        let buf = '';
        for await (const chunk of r.body) {
          buf += Buffer.from(chunk).toString('utf8');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
            if (!data) continue;
            try { const e = JSON.parse(data); if (EVENTS.includes(e.ch)) ctx.sendToRenderer(e.ch, e.payload); } catch (e) {}
          }
        }
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 15 * 1000));
    }
  };
  loop();
}
// what this computer hands the mini PC: all its settings but the hub's own, and what the agent learned
function settingsBundle() {
  const c = Object.assign({}, ctx.readConfig());
  for (const k of KEEP_HERE) delete c[k];
  const files = [];
  for (const name of LEARNED_FILES) { try { files.push({ name, text: fs.readFileSync(path.join(ctx.userData(), name), 'utf8') }); } catch (e) {} }
  try {
    for (const f of fs.readdirSync(path.join(ctx.userData(), 'site-notes'))) {
      if (/^[\w.-]+\.md$/.test(f)) files.push({ name: 'site-notes/' + f, text: fs.readFileSync(path.join(ctx.userData(), 'site-notes', f), 'utf8') });
    }
  } catch (e) {}
  return { config: c, files, from: os.hostname() };
}

// a calendar he just connected here goes to the mini PC (which does the calendar work)
async function sendCalAccounts() {
  const c = ctx.readConfig();
  await call('/hub/import', { body: { config: { calAccounts: c.calAccounts || [] }, from: os.hostname() } });
}

// Settings → Mini PC server (always answered here, never forwarded)
const localHandlers = {
  'hub:get': () => { const c = cfg(); return { role: role(), url: c.url || '', hasToken: !!c.hubToken }; },
  'hub:test': async (_e, url, token) => {
    const u = String(url || baseUrl()).trim().replace(/\/+$/, ''), t = String(token || cfg().hubToken || '').trim();
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u)) return { ok: false, error: 'use the mini PC’s https://….ts.net address' };
    try {
      const r = await fetch(u + '/hub/ping', { headers: { Authorization: 'Bearer ' + t }, signal: AbortSignal.timeout(10000) });
      const j = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, host: j.host, version: j.version } : { ok: false, error: j.error || 'HTTP ' + r.status };
    } catch (e) { return { ok: false, error: 'not reachable (is Tailscale on, on both?)' }; }
  },
  // turn client mode on (url + token) or off (role null); takes effect when Tasks restarts
  'hub:save': (_e, change) => {
    const c = ctx.readConfig();
    const h = Object.assign({}, c.hub);
    if (change && change.role === 'client') {
      const u = String(change.url || '').trim().replace(/\/+$/, '');
      if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u)) return { ok: false, error: 'use the mini PC’s https://….ts.net address' };
      h.role = 'client'; h.url = u;
      if (change.token) h.hubToken = String(change.token).trim();
      if (!h.hubToken) return { ok: false, error: 'paste the hub token' };
    } else { delete h.role; }
    c.hub = h; ctx.writeConfig(c);
    return { ok: true, restart: true };
  },
  'hub:restart': () => { ctx.relaunch(); return true; },
  'hub:send-settings': async () => {
    try { const j = await call('/hub/import', { body: settingsBundle(), timeout: 2 * 60 * 1000 }); return { ok: true, files: j.files }; }
    catch (e) { return { ok: false, error: e.message }; }
  },
};

module.exports = { init, role, isClient, startServer, stopServer, broadcast, forward, followEvents, sendCalAccounts, localHandlers, REMOTE, EVENTS, LIVE_METHODS,
  liveFilter, importSettings, settingsBundle, sameSecret, DEFAULT_PORT };
