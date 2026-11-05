/* Stripe Link's agent wallet, spoken to directly (no packages): the same calls Stripe's own link-cli makes
   (github.com/stripe/link-cli, MIT). The CLI itself takes close to a minute to start on Windows, too slow for a
   checkout, so the app talks to Link's API itself.
   - login: OAuth device flow on login.link.com. He opens the link, signs in to Link and checks the phrase.
   - spend requests: one per order. Link pushes it to his phone; once he approves it there, it carries a
     one-time virtual card (number, expiry, CVC), good at any checkout.
   Used by agent/link-wallet.js (the app: login, tokens) and agent/link-pay.js (a run's "wallet" tool), which
   is copied next to it, so this file needs nothing but Node's own fetch. */
const AUTH_BASE = 'https://login.link.com';
const API_BASE = 'https://api.link.com';
const CLIENT_ID = 'lwlpk_U7Qy7ThG69STZk'; // link-cli's public client id (a device-flow client: there is no secret)
const SCOPE = 'userinfo:read payment_methods.agentic'; // no financial data: only what paying needs

class LinkError extends Error {
  constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}
const errText = (d, raw) => (d && (d.error_description || (typeof d.error === 'string' ? d.error : d.error && d.error.message))) || String(raw || '').slice(0, 200) || 'unknown error';

async function postForm(path, params, fetchImpl = fetch) {
  const r = await fetchImpl(AUTH_BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(20000) });
  const raw = await r.text();
  let data = null; try { data = JSON.parse(raw); } catch (e) {}
  return { status: r.status, data, raw };
}

// → { deviceCode, userCode, url, interval, expiresIn }: show userCode and open url
async function startLogin(clientName, hostName, fetchImpl) {
  const { status, data, raw } = await postForm('/device/code', { client_id: CLIENT_ID, scope: SCOPE,
    connection_label: clientName + ' on ' + hostName, client_hint: clientName }, fetchImpl);
  if (status < 200 || status >= 300 || !data) throw new LinkError('Link login could not start: ' + errText(data, raw), status);
  return { deviceCode: data.device_code, userCode: data.user_code, url: data.verification_uri_complete || data.verification_uri,
    interval: Math.max(2, Number(data.interval) || 5), expiresIn: Number(data.expires_in) || 600 };
}
const tokensFrom = (d) => ({ access_token: d.access_token, refresh_token: d.refresh_token,
  expires_at: d.expires_in ? Date.now() + Number(d.expires_in) * 1000 : null });
// → tokens once he approved, null while still waiting; throws when denied or expired
async function pollLogin(deviceCode, fetchImpl) {
  const { status, data, raw } = await postForm('/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode, client_id: CLIENT_ID }, fetchImpl);
  if (status >= 200 && status < 300 && data && data.access_token) return tokensFrom(data);
  const code = data && typeof data.error === 'string' ? data.error : '';
  if (status === 400 && (code === 'authorization_pending' || code === 'slow_down')) return null;
  if (code === 'expired_token') throw new LinkError('The Link sign-in expired. Start again.', status, code);
  if (code === 'access_denied' || code === 'authorization_failed') throw new LinkError('Link said no to the connection.', status, code);
  throw new LinkError('Link sign-in failed: ' + errText(data, raw), status, code);
}
async function refresh(refreshToken, fetchImpl) {
  const { status, data, raw } = await postForm('/device/token', { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }, fetchImpl);
  if (status < 200 || status >= 300 || !data || !data.access_token) throw new LinkError('Link sign-in has run out: reconnect Link in Settings (' + errText(data, raw) + ')', status);
  const t = tokensFrom(data);
  if (!t.refresh_token) t.refresh_token = refreshToken; // kept when the server doesn't rotate it
  return t;
}
async function revoke(token, fetchImpl) {
  await postForm('/device/revoke', { client_id: CLIENT_ID, token }, fetchImpl).catch(() => {});
}

// an API call with his access token → the JSON answer (null for a 404)
async function api(token, method, path, body, fetchImpl = fetch) {
  const r = await fetchImpl(API_BASE + path, { method, signal: AbortSignal.timeout(30000),
    headers: Object.assign({ Authorization: 'Bearer ' + token, Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined });
  const raw = await r.text();
  let data = null; try { data = JSON.parse(raw); } catch (e) {}
  if (r.status === 404) return null;
  if (!r.ok) throw new LinkError('Link: ' + errText(data, raw), r.status, data && data.error && data.error.code);
  return data;
}
const userInfo = (token, f) => api(token, 'GET', '/userinfo', null, f);
const createSpend = (token, body, f) => api(token, 'POST', '/spend_requests', body, f);
const getSpend = (token, id, withCard, f) => api(token, 'GET', '/spend_requests/' + encodeURIComponent(id) + (withCard ? '?include=card' : ''), null, f);
const cancelSpend = (token, id, f) => api(token, 'POST', '/spend_requests/' + encodeURIComponent(id) + '/cancel', null, f);

// still waiting on him (the CLI's own polling rule)
const waiting = (sr) => !!sr && (sr.status === 'created' || sr.status === 'pending_approval'
  || (sr.status === 'requires_action' && ((((sr.status_details || {}).requires_action || {}).next_action || {}).resolution === 'auto_resume')));
const nextAction = (sr) => { const d = (sr && sr.status_details) || {}; return ((d.requires_action || d.failed || {}).next_action) || null; };

module.exports = { LinkError, startLogin, pollLogin, refresh, revoke, api, userInfo, createSpend, getSpend, cancelSpend, waiting, nextAction, SCOPE };
