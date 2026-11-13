/* His mail, for any AI's inbox run: a small MCP server (JSON-RPC over stdin/stdout) on the app's own sign-ins
   (Settings → Calendars): Gmail through the Gmail API, Outlook through Microsoft Graph. Claude, Gemini, ChatGPT,
   OpenRouter and the free tiers all get the same tools, and the run that has them has no web (agent/runner.js).
   - Reading: search, a thread, a message, the labels/folders.
   - Changes it makes on its own: drafts, labels (Outlook: categories), archive, read/unread, a new label.
   - Final steps, only in a run his yes unlocked (MAIL_FINAL=1, agent/runner.js saidYes): send, reply, forward,
     send a draft, move to trash. Without it they refuse and say how to ask him. Nothing here deletes for good.
   An account that hasn't given the app the right to change mail (connected before it was asked for) says to
   connect it again. The accounts and their access tokens are read from MAIL_ACCOUNTS_FILE
   ([{provider, email, token, write, send}]), which the runner writes and empties after the run, so tokens never
   sit in an AI's own settings. Plain node, no packages: the runner copies it out of the app.
   A yes buys one final step, and only to the addresses and subjects named in the note he said yes to (MAIL_ASK_FILE):
   an email the run reads can't widen it. Usage: node mail-mcp.js   (env MAIL_ACCOUNTS_FILE, MAIL_FINAL, MAIL_ASK_FILE) */
const fs = require('fs');

const BODY_MAX = 12000; // one message's text; a thread gets this much per message
const MAX_TO = 10;
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const GRAPH = 'https://graph.microsoft.com/v1.0/me/';

function accounts() {
  try { const a = JSON.parse(fs.readFileSync(process.env.MAIL_ACCOUNTS_FILE, 'utf8')); return Array.isArray(a) ? a.filter((x) => x && x.token) : []; } catch (e) { return []; }
}
const finalOk = () => process.env.MAIL_FINAL === '1';
const NOT_CONNECTED = 'No mailbox is connected: he can tick email on his Google or Microsoft account in Settings → Calendars';
const NEEDS_YES = 'This one sends or trashes mail, so it waits for his yes. Don\'t call it again in this run: list exactly what ' +
  'you would do in your note (each email: to, with the full email address, subject, first line; or the subject of each email ' +
  'that goes to the trash), ask him to reply yes, and set the task to needs-you. His yes lets the next run do exactly that, ' +
  'and only that: one send or trash, to the addresses and subjects the note named.';
/* His yes was to one ask (MAIL_ASK_FILE: the note he answered, written by the runner). It buys one final step, to what
   that note named: an address not in it can't be sent to, an email whose subject isn't in it can't be trashed, and a
   second send or trash waits for a fresh yes. So an email the run reads can't widen what he agreed to. */
let finalDone = false;
function asked() { // the note, lowercased, one line
  let t = ''; try { t = fs.readFileSync(process.env.MAIL_ASK_FILE || '', 'utf8'); } catch (e) {}
  return String(t).toLowerCase().replace(/\s+/g, ' ');
}
const SPENT = 'His yes covered one step, and this run has taken it. Anything more waits for a fresh yes: say in your note what else you would do and set the task to needs-you.';
const notAsked = (what) => 'His yes did not cover ' + what + ': the note he said yes to doesn\'t name it. Only what that note listed can go ' +
  '(each address in full, each subject). For anything else, ask him again: say it in your note and set the task to needs-you.';
// the addresses a send goes to must all be in the note he said yes to
function askedFor(addrs) {
  const a = asked(), miss = addrs.filter((x) => !a.includes(String(x).toLowerCase()));
  if (miss.length) throw new Error(notAsked(miss.join(', ')));
}
// an email to trash must be named by its subject in that note
function askedSubject(subject) {
  const s = String(subject || '').toLowerCase().replace(/^((re|fwd?|aw|wg)\s*:\s*)+/, '').replace(/\s+/g, ' ').trim();
  if (!s || !asked().includes(s)) throw new Error(notAsked('"' + (String(subject || '').trim() || 'an email with no subject') + '"'));
}
const spent = (r) => { finalDone = true; return r; }; // the one final step is taken
// which mailbox: the one named (its address), else the first connected
function pick(a) {
  const all = accounts();
  if (!all.length) throw new Error(NOT_CONNECTED);
  if (!a || !a.account) return all[0];
  const want = String(a.account).toLowerCase();
  const m = all.find((x) => String(x.email || '').toLowerCase() === want);
  if (!m) throw new Error('no connected mailbox is ' + a.account + '; connected: ' + all.map((x) => x.email || x.provider).join(', '));
  return m;
}
function needWrite(acct) {
  if (!acct.write) throw new Error((acct.email || 'This mailbox') + ' only lets the app read: he can connect it again in Settings → Calendars to let the Agent change mail');
}
function needSend(acct) {
  if (!finalOk()) throw new Error(NEEDS_YES);
  if (finalDone) throw new Error(SPENT);
  if (!acct.send) throw new Error((acct.email || 'This mailbox') + ' doesn\'t let the app send: he can connect it again in Settings → Calendars');
}

async function req(base, acct, sub, { method = 'GET', body } = {}) {
  const r = await fetch(base + sub, { method, signal: AbortSignal.timeout(30000),
    headers: Object.assign({ Authorization: 'Bearer ' + acct.token }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  if (r.status === 202 || r.status === 204) return null;
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && j.error && (j.error.message || j.error)) || (base === GMAIL ? 'Gmail' : 'Outlook') + ' HTTP ' + r.status);
  return j;
}
const gmail = (acct, sub, o) => req(GMAIL, acct, sub, o);
const graph = (acct, sub, o) => req(GRAPH, acct, sub, o);

/* ---------- addresses and messages ---------- */
const ADDR = /^[^\s@<>()",;:\\[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
function addresses(v) {
  const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,;\n]/), out = [];
  for (const x of list) {
    const s = String(x == null ? '' : x).trim(); if (!s) continue;
    const m = /<([^<>]+)>\s*$/.exec(s), a = (m ? m[1] : s).trim().toLowerCase();
    if (ADDR.test(a) && a.length <= 254 && !out.includes(a)) out.push(a);
  }
  return out;
}
const oneLine = (s) => String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
function recipients(a, { needTo = true } = {}) {
  const to = addresses(a.to), cc = addresses(a.cc).filter((x) => !to.includes(x)), bcc = addresses(a.bcc).filter((x) => !to.includes(x) && !cc.includes(x));
  if (needTo && !to.length) throw new Error('`to` needs at least one good email address');
  if (to.length + cc.length + bcc.length > MAX_TO) throw new Error('at most ' + MAX_TO + ' addresses in all');
  return { to, cc, bcc };
}
// RFC 2822 for the Gmail API: UTF-8 subject (RFC 2047) and body (base64); reply headers keep it in its thread
function mime({ from, to, cc, bcc, subject, body, inReplyTo, references }) {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const lines = [];
  if (from) lines.push('From: ' + from);
  if (to.length) lines.push('To: ' + to.join(', '));
  if (cc && cc.length) lines.push('Cc: ' + cc.join(', '));
  if (bcc && bcc.length) lines.push('Bcc: ' + bcc.join(', '));
  if (inReplyTo) lines.push('In-Reply-To: ' + oneLine(inReplyTo));
  if (references) lines.push('References: ' + oneLine(references));
  lines.push('Subject: =?UTF-8?B?' + b64(oneLine(subject)) + '?=', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', b64(String(body || '').replace(/\r?\n/g, '\r\n')).replace(/.{76}/g, '$&\r\n'));
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}
const bodyOf = (a) => { const b = String(a.body == null ? '' : a.body).replace(/\r\n/g, '\n').trim().slice(0, 20000); if (!b) throw new Error('`body` is empty'); return b; };

const b64 = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const tidy = (t) => String(t || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
const fromHtml = (h) => String(h || '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
function bodyText(m) {
  let plain = '', html = '';
  (function walk(p) {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body && p.body.data && !plain) plain = b64(p.body.data);
    else if (p.mimeType === 'text/html' && p.body && p.body.data && !html) html = b64(p.body.data);
    (p.parts || []).forEach(walk);
  })(m.payload);
  return tidy(plain || fromHtml(html) || m.snippet || '');
}
const header = (m, name) => (((m.payload || {}).headers || []).find((h) => h.name.toLowerCase() === name) || {}).value || '';
const cut = (t, max) => t.length > max ? t.slice(0, max) + ' …(cut)' : t;
function showMessage(m, max) {
  const files = [];
  (function walk(p) { if (!p) return; if (p.filename) files.push(p.filename); (p.parts || []).forEach(walk); })(m.payload);
  return { id: m.id, threadId: m.threadId, date: header(m, 'date'), from: header(m, 'from'), to: header(m, 'to'), cc: header(m, 'cc') || undefined,
    subject: header(m, 'subject'), labels: m.labelIds, attachments: files.length ? files : undefined, text: cut(bodyText(m), max) };
}
const who = (r) => r && r.emailAddress ? (r.emailAddress.name ? r.emailAddress.name + ' <' + r.emailAddress.address + '>' : r.emailAddress.address) : '';
function showOutlook(m, max) {
  const text = m.body ? (m.body.contentType === 'html' ? fromHtml(m.body.content) : m.body.content) : m.bodyPreview;
  return { id: m.id, threadId: m.conversationId, date: m.receivedDateTime, from: who(m.from), to: (m.toRecipients || []).map(who).join(', '),
    cc: (m.ccRecipients || []).map(who).join(', ') || undefined, subject: m.subject, read: m.isRead, categories: m.categories && m.categories.length ? m.categories : undefined,
    attachments: m.hasAttachments || undefined, draft: m.isDraft || undefined, text: cut(tidy(text), max) };
}
const idOk = (s) => /^[A-Za-z0-9_=+\/-]{1,400}$/.test(String(s || ''));
const needId = (v, what) => { if (!idOk(v)) throw new Error('`' + what + '` isn’t a message id from search_threads or get_thread'); return encodeURIComponent(v); };
const target = (a) => a.threadId ? { kind: 'thread', id: needId(a.threadId, 'threadId') } : { kind: 'message', id: needId(a.messageId, 'messageId') };

/* ---------- Gmail ---------- */
async function gmailLabelIds(acct, names) {
  const want = (Array.isArray(names) ? names : names ? [names] : []).map(String);
  if (!want.length) return [];
  const all = (await gmail(acct, 'labels')).labels || [];
  return want.map((n) => {
    const l = all.find((x) => x.id === n || x.name.toLowerCase() === n.toLowerCase());
    if (!l) throw new Error('no label "' + n + '": list_labels shows them, create_label adds one');
    return l.id;
  });
}
async function gmailModify(acct, t, add, remove) {
  return gmail(acct, (t.kind === 'thread' ? 'threads/' : 'messages/') + t.id + '/modify', { method: 'POST', body: { addLabelIds: add, removeLabelIds: remove } });
}
// a reply to message m: its thread, its headers, and who it goes to
async function gmailReplyParts(acct, messageId, all) {
  const m = await gmail(acct, 'messages/' + needId(messageId, 'messageId') + '?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References');
  const me = String(acct.email || '').toLowerCase();
  const to = addresses(header(m, 'reply-to') || header(m, 'from'));
  const cc = all ? addresses(header(m, 'to') + ',' + header(m, 'cc')).filter((x) => x !== me && !to.includes(x)) : [];
  const subj = header(m, 'subject'), mid = header(m, 'message-id');
  return { threadId: m.threadId, to, cc, subject: /^re:/i.test(subj) ? subj : 'Re: ' + subj, inReplyTo: mid, references: (header(m, 'references') + ' ' + mid).trim() };
}

const gmailTools = {
  async search_threads(acct, a) {
    const n = Math.max(1, Math.min(25, Number(a.maxResults) || 10));
    const list = await gmail(acct, 'threads?maxResults=' + n + '&q=' + encodeURIComponent(String(a.query || '')));
    const threads = await Promise.all((list.threads || []).map(async (t) => {
      const th = await gmail(acct, 'threads/' + t.id + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date').catch(() => null);
      const last = th && th.messages && th.messages[th.messages.length - 1];
      return last ? { threadId: t.id, lastMessageId: last.id, messages: th.messages.length, from: header(last, 'from'), subject: header(last, 'subject'), date: header(last, 'date'),
        labels: last.labelIds, snippet: t.snippet || last.snippet || '' } : { threadId: t.id, snippet: t.snippet || '' };
    }));
    return { threads, more: !!list.nextPageToken };
  },
  async get_thread(acct, a) {
    const th = await gmail(acct, 'threads/' + needId(a.threadId, 'threadId') + '?format=full');
    return { threadId: th.id, messages: (th.messages || []).map((m) => showMessage(m, BODY_MAX)) };
  },
  async get_message(acct, a) { return showMessage(await gmail(acct, 'messages/' + needId(a.messageId, 'messageId') + '?format=full'), BODY_MAX * 2); },
  async list_labels(acct) { return { labels: ((await gmail(acct, 'labels')).labels || []).map((l) => ({ id: l.id, name: l.name, type: l.type })) }; },
  async list_drafts(acct) {
    const list = (await gmail(acct, 'drafts?maxResults=20')).drafts || [];
    const drafts = await Promise.all(list.map(async (d) => {
      const x = await gmail(acct, 'drafts/' + d.id + '?format=metadata').catch(() => null);
      const m = x && x.message;
      return m ? { draftId: d.id, to: header(m, 'to'), subject: header(m, 'subject'), snippet: m.snippet } : { draftId: d.id };
    }));
    return { drafts };
  },
  async create_draft(acct, a) {
    needWrite(acct);
    const body = bodyOf(a);
    const reply = a.replyToMessageId ? await gmailReplyParts(acct, a.replyToMessageId, !!a.replyAll) : null;
    const r = recipients(reply && !a.to ? { to: reply.to, cc: reply.cc } : a);
    const raw = mime(Object.assign({ from: acct.email, subject: a.subject || (reply ? reply.subject : ''), body }, r, reply ? { inReplyTo: reply.inReplyTo, references: reply.references } : {}));
    const d = await gmail(acct, 'drafts', { method: 'POST', body: { message: Object.assign({ raw }, reply ? { threadId: reply.threadId } : {}) } });
    return { draftId: d.id, to: r.to, subject: a.subject || (reply ? reply.subject : '') };
  },
  async change_labels(acct, a) {
    needWrite(acct);
    const t = target(a);
    await gmailModify(acct, t, await gmailLabelIds(acct, a.add), await gmailLabelIds(acct, a.remove));
    return { ok: true };
  },
  async archive(acct, a) { needWrite(acct); await gmailModify(acct, target(a), [], ['INBOX']); return { ok: true }; },
  async mark_read(acct, a) {
    needWrite(acct);
    const read = a.read !== false;
    await gmailModify(acct, target(a), read ? [] : ['UNREAD'], read ? ['UNREAD'] : []);
    return { ok: true, read };
  },
  async create_label(acct, a) {
    needWrite(acct);
    const name = oneLine(a.name).slice(0, 100); if (!name) throw new Error('`name` is empty');
    const l = await gmail(acct, 'labels', { method: 'POST', body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
    return { id: l.id, name: l.name };
  },
  async send_message(acct, a) {
    needSend(acct);
    const r = recipients(a); askedFor(r.to.concat(r.cc, r.bcc));
    const raw = mime(Object.assign({ from: acct.email, subject: a.subject, body: bodyOf(a) }, r));
    const m = await gmail(acct, 'messages/send', { method: 'POST', body: { raw } });
    return spent({ sent: true, id: m.id, to: r.to });
  },
  async reply(acct, a) {
    needSend(acct);
    const p = await gmailReplyParts(acct, a.messageId, !!a.replyAll); askedFor(p.to.concat(p.cc));
    const raw = mime({ from: acct.email, to: p.to, cc: p.cc, subject: p.subject, body: bodyOf(a), inReplyTo: p.inReplyTo, references: p.references });
    const m = await gmail(acct, 'messages/send', { method: 'POST', body: { raw, threadId: p.threadId } });
    return spent({ sent: true, id: m.id, to: p.to, cc: p.cc });
  },
  async forward(acct, a) {
    needSend(acct);
    const r = recipients(a); askedFor(r.to.concat(r.cc, r.bcc));
    const m = await gmail(acct, 'messages/' + needId(a.messageId, 'messageId') + '?format=full');
    const subj = header(m, 'subject');
    const body = (String(a.body || '').trim() ? String(a.body).trim() + '\n\n' : '') + '---------- Forwarded message ---------\nFrom: ' + header(m, 'from') +
      '\nDate: ' + header(m, 'date') + '\nSubject: ' + subj + '\nTo: ' + header(m, 'to') + '\n\n' + bodyText(m);
    const sent = await gmail(acct, 'messages/send', { method: 'POST', body: { raw: mime(Object.assign({ from: acct.email, subject: /^fwd?:/i.test(subj) ? subj : 'Fwd: ' + subj, body }, r)) } });
    return spent({ sent: true, id: sent.id, to: r.to });
  },
  async send_draft(acct, a) {
    needSend(acct);
    const id = String(needId(a.draftId, 'draftId'));
    const d = (await gmail(acct, 'drafts/' + id + '?format=metadata')).message || {}; // who the draft goes to
    askedFor(addresses(header(d, 'to') + ',' + header(d, 'cc') + ',' + header(d, 'bcc')));
    const m = await gmail(acct, 'drafts/send', { method: 'POST', body: { id } });
    return spent({ sent: true, id: m.id });
  },
  async trash(acct, a) {
    needSend(acct);
    const t = target(a);
    const m = t.kind === 'thread' ? ((await gmail(acct, 'threads/' + t.id + '?format=metadata&metadataHeaders=Subject')).messages || [])[0] || {}
      : await gmail(acct, 'messages/' + t.id + '?format=metadata&metadataHeaders=Subject');
    askedSubject(header(m, 'subject'));
    await gmail(acct, (t.kind === 'thread' ? 'threads/' : 'messages/') + t.id + '/trash', { method: 'POST' });
    return spent({ trashed: true });
  },
};

/* ---------- Outlook (Microsoft Graph). A "thread" is its conversation; labels are categories ---------- */
const SEL = '$select=id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,categories,hasAttachments,isDraft,bodyPreview';
const rcpt = (list) => (list || []).map((address) => ({ emailAddress: { address } }));
async function outlookIds(acct, a) { // the messages a change is for: one, or every one in the conversation
  if (!a.threadId) return [needId(a.messageId, 'messageId')];
  const conv = String(a.threadId).replace(/'/g, "''");
  const list = await graph(acct, 'messages?$top=50&$select=id&$filter=' + encodeURIComponent("conversationId eq '" + conv + "'"));
  return (list.value || []).map((m) => encodeURIComponent(m.id));
}
const outlookTools = {
  async search_threads(acct, a) {
    const n = Math.max(1, Math.min(25, Number(a.maxResults) || 10));
    const q = String(a.query || '').trim();
    const list = await graph(acct, 'messages?$top=' + n + '&' + SEL + (q ? '&$search=' + encodeURIComponent('"' + q.replace(/"/g, '') + '"') : '&$orderby=receivedDateTime desc'));
    return { threads: (list.value || []).map((m) => ({ threadId: m.conversationId, lastMessageId: m.id, from: who(m.from), subject: m.subject, date: m.receivedDateTime,
      read: m.isRead, snippet: m.bodyPreview })), more: !!list['@odata.nextLink'] };
  },
  async get_thread(acct, a) {
    if (!idOk(a.threadId)) throw new Error('`threadId` isn’t one from search_threads');
    const conv = String(a.threadId).replace(/'/g, "''");
    const list = await graph(acct, 'messages?$top=50&' + SEL + ',body&$filter=' + encodeURIComponent("conversationId eq '" + conv + "'"));
    const msgs = (list.value || []).sort((x, y) => String(x.receivedDateTime).localeCompare(String(y.receivedDateTime)));
    return { threadId: a.threadId, messages: msgs.map((m) => showOutlook(m, BODY_MAX)) };
  },
  async get_message(acct, a) { return showOutlook(await graph(acct, 'messages/' + needId(a.messageId, 'messageId') + '?' + SEL + ',body'), BODY_MAX * 2); },
  async list_labels(acct) {
    const [f, c] = await Promise.all([graph(acct, 'mailFolders?$top=50'), graph(acct, 'outlook/masterCategories').catch(() => ({ value: [] }))]);
    return { folders: (f.value || []).map((x) => ({ id: x.id, name: x.displayName, unread: x.unreadItemCount })), categories: (c.value || []).map((x) => x.displayName) };
  },
  async list_drafts(acct) {
    const list = await graph(acct, 'mailFolders/drafts/messages?$top=20&' + SEL);
    return { drafts: (list.value || []).map((m) => ({ draftId: m.id, to: (m.toRecipients || []).map(who).join(', '), subject: m.subject, snippet: m.bodyPreview })) };
  },
  async create_draft(acct, a) {
    needWrite(acct);
    const body = bodyOf(a);
    if (a.replyToMessageId) {
      const d = await graph(acct, 'messages/' + needId(a.replyToMessageId, 'replyToMessageId') + (a.replyAll ? '/createReplyAll' : '/createReply'), { method: 'POST', body: { comment: body } });
      return { draftId: d.id, to: (d.toRecipients || []).map(who), subject: d.subject };
    }
    const r = recipients(a);
    const d = await graph(acct, 'messages', { method: 'POST', body: { subject: oneLine(a.subject), body: { contentType: 'Text', content: body },
      toRecipients: rcpt(r.to), ccRecipients: rcpt(r.cc), bccRecipients: rcpt(r.bcc) } });
    return { draftId: d.id, to: r.to, subject: d.subject };
  },
  async change_labels(acct, a) {
    needWrite(acct);
    const add = (Array.isArray(a.add) ? a.add : a.add ? [a.add] : []).map(oneLine), remove = (Array.isArray(a.remove) ? a.remove : a.remove ? [a.remove] : []).map(oneLine);
    for (const id of await outlookIds(acct, a)) {
      const m = await graph(acct, 'messages/' + id + '?$select=categories');
      const cats = [...new Set((m.categories || []).filter((c) => !remove.includes(c)).concat(add))];
      await graph(acct, 'messages/' + id, { method: 'PATCH', body: { categories: cats } });
    }
    return { ok: true };
  },
  async archive(acct, a) {
    needWrite(acct);
    for (const id of await outlookIds(acct, a)) await graph(acct, 'messages/' + id + '/move', { method: 'POST', body: { destinationId: 'archive' } });
    return { ok: true };
  },
  async mark_read(acct, a) {
    needWrite(acct);
    const read = a.read !== false;
    for (const id of await outlookIds(acct, a)) await graph(acct, 'messages/' + id, { method: 'PATCH', body: { isRead: read } });
    return { ok: true, read };
  },
  async create_label(acct, a) {
    needWrite(acct);
    const name = oneLine(a.name).slice(0, 100); if (!name) throw new Error('`name` is empty');
    const c = await graph(acct, 'outlook/masterCategories', { method: 'POST', body: { displayName: name, color: 'preset0' } });
    return { name: c.displayName };
  },
  async send_message(acct, a) {
    needSend(acct);
    const r = recipients(a); askedFor(r.to.concat(r.cc, r.bcc));
    await graph(acct, 'sendMail', { method: 'POST', body: { message: { subject: oneLine(a.subject), body: { contentType: 'Text', content: bodyOf(a) },
      toRecipients: rcpt(r.to), ccRecipients: rcpt(r.cc), bccRecipients: rcpt(r.bcc) }, saveToSentItems: true } });
    return spent({ sent: true, to: r.to });
  },
  async reply(acct, a) {
    needSend(acct);
    const id = needId(a.messageId, 'messageId'), me = String(acct.email || '').toLowerCase();
    const m = await graph(acct, 'messages/' + id + '?$select=from,replyTo,toRecipients,ccRecipients'); // who the reply goes to
    const to = addresses(((m.replyTo || [])[0] && who(m.replyTo[0])) || who(m.from));
    const cc = a.replyAll ? addresses((m.toRecipients || []).concat(m.ccRecipients || []).map(who)).filter((x) => x !== me && !to.includes(x)) : [];
    askedFor(to.concat(cc));
    await graph(acct, 'messages/' + id + (a.replyAll ? '/replyAll' : '/reply'), { method: 'POST', body: { comment: bodyOf(a) } });
    return spent({ sent: true, to, cc });
  },
  async forward(acct, a) {
    needSend(acct);
    const r = recipients(a); askedFor(r.to);
    await graph(acct, 'messages/' + needId(a.messageId, 'messageId') + '/forward', { method: 'POST', body: { comment: String(a.body || ''), toRecipients: rcpt(r.to) } });
    return spent({ sent: true, to: r.to });
  },
  async send_draft(acct, a) {
    needSend(acct);
    const id = needId(a.draftId, 'draftId');
    const d = await graph(acct, 'messages/' + id + '?$select=toRecipients,ccRecipients,bccRecipients'); // who the draft goes to
    askedFor(addresses((d.toRecipients || []).concat(d.ccRecipients || [], d.bccRecipients || []).map(who)));
    await graph(acct, 'messages/' + id + '/send', { method: 'POST' });
    return spent({ sent: true });
  },
  async trash(acct, a) {
    needSend(acct);
    const ids = await outlookIds(acct, a);
    if (ids.length) askedSubject((await graph(acct, 'messages/' + ids[0] + '?$select=subject')).subject);
    for (const id of ids) await graph(acct, 'messages/' + id + '/move', { method: 'POST', body: { destinationId: 'deleteditems' } });
    return spent({ trashed: true });
  },
};

/* ---------- the tools ---------- */
const ACCOUNT = { account: { type: 'string', description: 'Which mailbox (its address), when he has more than one; default the first' } };
const WHICH = { messageId: { type: 'string', description: 'One email' }, threadId: { type: 'string', description: 'Or a whole thread' } };
const ADDRS = { to: { type: 'array', items: { type: 'string' } }, cc: { type: 'array', items: { type: 'string' } }, bcc: { type: 'array', items: { type: 'string' } } };
const obj = (properties, required) => ({ type: 'object', properties: Object.assign({}, properties, ACCOUNT), required: required || [] });
const NEEDS = ' Waits for his yes: in a run without it, this refuses.';
const TOOLS = [
  { name: 'list_accounts', description: 'The mailboxes he connected, and what each lets the app do.', inputSchema: { type: 'object', properties: {} } },
  { name: 'search_threads', description: 'Search his mail. Gmail: Gmail search syntax (from:, subject:, newer_than:7d, is:unread, label:…). Outlook: plain words. Newest first, with sender, subject, date and a snippet.',
    inputSchema: obj({ query: { type: 'string' }, maxResults: { type: 'integer', description: 'default 10, at most 25' } }, ['query']) },
  { name: 'get_thread', description: 'Read a whole thread (from search_threads): every message with its text.', inputSchema: obj({ threadId: { type: 'string' } }, ['threadId']) },
  { name: 'get_message', description: 'Read one email: headers and its text.', inputSchema: obj({ messageId: { type: 'string' } }, ['messageId']) },
  { name: 'list_labels', description: 'His labels (Gmail) or folders and categories (Outlook).', inputSchema: obj({}) },
  { name: 'list_drafts', description: 'His drafts.', inputSchema: obj({}) },
  { name: 'create_draft', description: 'Save a draft, nothing is sent. To reply, give replyToMessageId (and replyAll) instead of `to`.',
    inputSchema: obj(Object.assign({ subject: { type: 'string' }, body: { type: 'string' }, replyToMessageId: { type: 'string' }, replyAll: { type: 'boolean' } }, ADDRS), ['body']) },
  { name: 'change_labels', description: 'Add or remove labels (Gmail, by name) or categories (Outlook) on an email or a thread.',
    inputSchema: obj(Object.assign({ add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } }, WHICH)) },
  { name: 'archive', description: 'Take an email or thread out of the inbox (kept in All Mail / Archive).', inputSchema: obj(WHICH) },
  { name: 'mark_read', description: 'Mark an email or thread read (read: true) or unread (read: false).', inputSchema: obj(Object.assign({ read: { type: 'boolean' } }, WHICH)) },
  { name: 'create_label', description: 'Make a new label (Gmail) or category (Outlook).', inputSchema: obj({ name: { type: 'string' } }, ['name']) },
  { name: 'send_message', description: 'Send a new email.' + NEEDS, inputSchema: obj(Object.assign({ subject: { type: 'string' }, body: { type: 'string' } }, ADDRS), ['to', 'body']) },
  { name: 'reply', description: 'Reply to an email, in its thread (replyAll for everyone on it).' + NEEDS,
    inputSchema: obj({ messageId: { type: 'string' }, body: { type: 'string' }, replyAll: { type: 'boolean' } }, ['messageId', 'body']) },
  { name: 'forward', description: 'Forward an email, with an optional note on top.' + NEEDS,
    inputSchema: obj({ messageId: { type: 'string' }, to: ADDRS.to, body: { type: 'string', description: 'note on top' } }, ['messageId', 'to']) },
  { name: 'send_draft', description: 'Send one of his drafts.' + NEEDS, inputSchema: obj({ draftId: { type: 'string' } }, ['draftId']) },
  { name: 'trash', description: 'Move an email or thread to the trash (it can be taken back out for 30 days).' + NEEDS, inputSchema: obj(WHICH) },
];
const FINAL_TOOLS = ['send_message', 'reply', 'forward', 'send_draft', 'trash'];

async function call(name, a) {
  a = a || {};
  if (name === 'list_accounts') return { accounts: accounts().map((x) => ({ account: x.email, provider: x.provider === 'microsoft' ? 'Outlook' : 'Gmail', canChange: !!x.write, canSend: !!x.send })),
    sendAndTrash: finalOk() ? 'unlocked by his yes for this run' : 'wait for his yes' };
  if (!TOOLS.some((t) => t.name === name)) throw new Error('unknown tool ' + name);
  const acct = pick(a);
  const impl = (acct.provider === 'microsoft' ? outlookTools : gmailTools)[name];
  if (!impl) throw new Error('unknown tool ' + name);
  return impl(acct, a);
}

const send = (m) => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, m)) + '\n');
async function handle(m) {
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18',
    capabilities: { tools: {} }, serverInfo: { name: 'mail', version: '2' } } });
  if (m.method === 'tools/list') return send({ id: m.id, result: { tools: TOOLS } });
  if (m.method === 'tools/call') {
    const p = m.params || {};
    try { send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(await call(p.name, p.arguments), null, 1) }] } }); }
    catch (e) { send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: String(e && e.message || e) }] } }); }
    return;
  }
  if (m.method === 'ping') return send({ id: m.id, result: {} });
  if (m.id != null) send({ id: m.id, error: { code: -32601, message: 'method not found' } });
}

if (require.main === module) {
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      handle(m);
    }
  });
  // stdin closed: node exits by itself once any mail call still going has answered
}

const resetForTests = () => { finalDone = false; };
module.exports = { TOOLS, FINAL_TOOLS, call, handle, showMessage, showOutlook, bodyText, mime, addresses, resetForTests };
