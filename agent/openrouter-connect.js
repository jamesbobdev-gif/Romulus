/* "Connect with OpenRouter": its PKCE sign-in makes an API key for this app with no copy-and-paste. The app
   listens on a random local port, opens openrouter.ai/auth in the browser, gets a one-time code back on
   that port and swaps it for a key (the code alone is useless without the verifier kept here).
   No Electron here, so it can be tested on its own. */
const crypto = require('crypto');
const http = require('http');

const AUTH_URL = 'https://openrouter.ai/auth';
const KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// a fresh verifier and its S256 challenge
function pkce(random = crypto.randomBytes) {
  const verifier = b64url(random(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}
function authUrl(callbackUrl, challenge) {
  return AUTH_URL + '?' + new URLSearchParams({ callback_url: callbackUrl, code_challenge: challenge, code_challenge_method: 'S256' });
}
// the one-time code → the key
async function exchange(code, verifier, f = fetch) {
  const r = await f(KEYS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.key) throw new Error((j && j.error && (j.error.message || j.error)) || 'HTTP ' + r.status);
  return String(j.key);
}

const PAGE = (title, text) => '<!doctype html><meta charset="utf-8"><title>' + title + '</title><body style="font:16px system-ui;margin:48px auto;max-width:420px;color:#222">' +
  '<h2 style="margin:0 0 8px">' + title + '</h2><p>' + text + '</p></body>';

/* Run the whole flow once. openExternal opens the browser. → {ok, key} or {ok: false, error}. */
let running = null;
function connect({ openExternal, timeoutMs = 5 * 60 * 1000, fetch: f = fetch } = {}) {
  running = running || new Promise((resolve) => {
    const { verifier, challenge } = pkce();
    let done = false, server, killer;
    const finish = (r) => { if (done) return; done = true; clearTimeout(killer); try { server.close(); } catch (e) {} resolve(r); };
    server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get('code');
      if (!code) { res.writeHead(400, { 'Content-Type': 'text/html' }); res.end(PAGE('No code', 'OpenRouter sent no code. Go back to Tasks and try again.')); return; }
      try {
        const key = await exchange(code, verifier, f);
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE('Connected', 'OpenRouter is connected to Tasks. You can close this tab.'));
        finish({ ok: true, key });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' }); res.end(PAGE('Didn’t work', 'Tasks couldn’t turn the code into a key: ' + e.message));
        finish({ ok: false, error: e.message });
      }
    });
    server.on('error', (e) => finish({ ok: false, error: e.message }));
    server.listen(0, '127.0.0.1', () => {
      const cb = 'http://127.0.0.1:' + server.address().port + '/callback';
      killer = setTimeout(() => finish({ ok: false, error: 'no answer from the browser in 5 minutes' }), timeoutMs);
      Promise.resolve().then(() => openExternal(authUrl(cb, challenge))).catch((e) => finish({ ok: false, error: e.message }));
    });
  }).finally(() => { running = null; });
  return running;
}

module.exports = { pkce, authUrl, exchange, connect, AUTH_URL, KEYS_URL };
