/* Email the Agent wrote, sent from his own Gmail or Outlook — only when he presses Send.
   The Agent never sends anything itself: it ends its run "needs-you" with the email in `email`
   ({to, cc, subject, body}), the app shows it as a card he can edit (renderer/js/agent-email.js), and his
   Send calls mail:send (main/gmail-dates.js), which sends through the account he connected in
   Settings → Calendars (Gmail API users.messages.send, or Microsoft Graph /me/sendMail).
   No Electron here, so it can be tested on its own. */

const MAX_TO = 10;
const ADDR = /^[^\s@<>()",;:\\[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

// "Ann <ann@x.com>, bob@y.org" or an array of them → ['ann@x.com', 'bob@y.org'] (bare addresses only)
function addresses(v) {
  const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,;\n]/);
  const out = [];
  for (const x of list) {
    const s = String(x == null ? '' : x).trim();
    if (!s) continue;
    const m = /<([^<>]+)>\s*$/.exec(s);
    const a = (m ? m[1] : s).trim().toLowerCase();
    if (ADDR.test(a) && a.length <= 254 && !out.includes(a)) out.push(a);
  }
  return out;
}
// the email it wrote, checked: → {to, cc, subject, body} or undefined. At least one good address, at most ten
// in all; a subject on one line (no header can be slipped in through it).
function cleanEmail(e) {
  if (!e || typeof e !== 'object') return undefined;
  const to = addresses(e.to), cc = addresses(e.cc).filter((a) => !to.includes(a));
  if (!to.length || to.length + cc.length > MAX_TO) return undefined;
  const subject = String(e.subject == null ? '' : e.subject).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const body = String(e.body == null ? '' : e.body).replace(/\r\n/g, '\n').trim().slice(0, 20000);
  if (!body) return undefined;
  const out = { to, subject, body };
  if (cc.length) out.cc = cc;
  return out;
}

// RFC 2822 message for the Gmail API: UTF-8 subject (RFC 2047) and body (base64), so any language survives
function mime({ from, to, cc, subject, body }) {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const lines = [];
  if (from) lines.push('From: ' + from);
  lines.push('To: ' + to.join(', '));
  if (cc && cc.length) lines.push('Cc: ' + cc.join(', '));
  lines.push('Subject: =?UTF-8?B?' + b64(subject || '') + '?=', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', b64(body.replace(/\n/g, '\r\n')).replace(/.{76}/g, '$&\r\n'));
  return lines.join('\r\n');
}

// an account he connected that may send: Google with gmail.send ticked, Microsoft with Mail.Send
const canSend = (a) => !!(a && !a.broken && a.tokens && a.tokens.refresh_token
  && ((a.provider === 'google' && /gmail\.send/.test(a.scope || '')) || (a.provider === 'microsoft' && /mail\.send/i.test(a.scope || ''))));

async function check(res, what) {
  if (res.ok) return res.status === 202 || res.status === 204 ? null : res.json().catch(() => null);
  const data = await res.json().catch(() => null);
  throw new Error((data && data.error && (data.error.message || data.error)) || what + ' HTTP ' + res.status);
}
// → {id} (Gmail's message id; Graph gives none). Throws with the provider's reason.
async function send(acct, token, email, { fetch: f = fetch } = {}) {
  const e = cleanEmail(email);
  if (!e) throw new Error('the email needs a body and one to ten good addresses');
  if (acct.provider === 'google') {
    const raw = Buffer.from(mime(Object.assign({ from: acct.email || '' }, e)), 'utf8').toString('base64url');
    const data = await check(await f('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }), signal: AbortSignal.timeout(30000) }), 'Gmail');
    return { id: (data && data.id) || null };
  }
  if (acct.provider === 'microsoft') {
    const rcpt = (list) => (list || []).map((address) => ({ emailAddress: { address } }));
    await check(await f('https://graph.microsoft.com/v1.0/me/sendMail', { method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ message: { subject: e.subject, body: { contentType: 'Text', content: e.body }, toRecipients: rcpt(e.to), ccRecipients: rcpt(e.cc) }, saveToSentItems: true }) }), 'Outlook');
    return { id: null };
  }
  throw new Error('this account can’t send email');
}

module.exports = { addresses, cleanEmail, mime, canSend, send, MAX_TO };
