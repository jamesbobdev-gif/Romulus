// The "wallet" MCP server for Claude's runs: pays at a store's checkout with a one-time Stripe Link card.
// agent/link-wallet.js copies this file (and link-api.js) next to the browser launcher and starts it with
// the run's environment; Claude Code talks to it over stdin/stdout (newline-delimited JSON-RPC).
//
// How a payment goes (the shopping skill tells the Agent the same):
//   1. The Agent stops on the checkout's review with the items and total, and he replies yes (the run gets
//      TASKS_BROWSER_APPROVED=1; without it this tool refuses).
//   2. pay_with_link_card asks Link for a one-time card for that amount at that store. Link pushes it to his
//      phone; nothing is paid until he approves it there (a second yes, with the amount and store in front of him).
//   3. Once approved, THIS process types the card into the checkout's card fields through the agent browser's
//      debugging port. The number, expiry and CVC never reach the AI: the tool answers with the brand and last
//      four only, the browser launcher masks card numbers in page snapshots and turns screenshots off
//      (TASKS_CARD_FLAG), and the card is never written to disk or a log.
//   4. The Agent places the order with the store's own button (the launcher's yes rules apply).
const fs = require('fs');
const path = require('path');
const link = require('./link-api');

const env = process.env;
const TOKEN = env.LINK_TOKEN || '';
const TEST = env.LINK_TEST === '1';
const CAP = Math.min(50000, Math.max(100, Number(env.LINK_CAP_CENTS) || 20000)); // his per-order limit; Link's own is $500
const CDP_PORT = env.TASKS_CDP_PORT || '9334';
const APPROVED = env.TASKS_BROWSER_APPROVED === '1';
let APPROVED_HOSTS = []; try { APPROVED_HOSTS = JSON.parse(env.TASKS_BROWSER_APPROVED_HOSTS || '[]'); } catch (e) {}
if (!Array.isArray(APPROVED_HOSTS)) APPROVED_HOSTS = [];
const CARD_FLAG = env.TASKS_CARD_FLAG || '';
const TAINT_FILE = env.TASKS_BROWSER_TAINT || ''; // his mail was opened in this run (agent/browser-proxy.js): no paying then
const ACTIONS_FILE = env.TASKS_BROWSER_ACTIONS || '';
const TASK_TITLE = env.TASKS_BROWSER_TASK || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (u) => { try { return new URL(String(u)).hostname.toLowerCase(); } catch (e) { return ''; } };
const hostIn = (h, list) => list.some((a) => h === a || h.endsWith('.' + a));
const dollars = (c) => '$' + (c / 100).toFixed(2);
function logAction(what, extra) {
  if (!ACTIONS_FILE) return;
  try { fs.appendFileSync(ACTIONS_FILE, JSON.stringify(Object.assign({ at: Date.now(), task: TASK_TITLE, what }, extra || {})) + '\n'); } catch (e) {}
}

/* ---------- which field is which ---------- */
// a field's attributes (autocomplete, name, id, its label, aria-label, placeholder, data-* names) → what goes in it, or null
const NOT_PAYMENT = /gift|promo|coupon|voucher|loyalty|reward|member|discount|search|e-?mail|phone|\bsms\b|one.?time|otp/;
function fieldKind(a) {
  const ac = String(a.autocomplete || '').toLowerCase();
  if (/\bcc-number\b/.test(ac)) return 'number';
  if (/\bcc-csc\b/.test(ac)) return 'cvc';
  if (/\bcc-exp-month\b/.test(ac)) return 'expMonth';
  if (/\bcc-exp-year\b/.test(ac)) return 'expYear';
  if (/\bcc-exp\b/.test(ac)) return 'exp';
  if (/\bcc-name\b/.test(ac)) return 'name';
  if (/\bpostal-code\b/.test(ac) && /billing/.test(ac)) return 'postal';
  const t = [a.name, a.id, a.label, a.aria, a.placeholder, a.data].map((x) => String(x || '')).join(' | ').toLowerCase();
  if (!t.trim() || NOT_PAYMENT.test(t)) return null;
  if (/\bcvc\b|\bcvv2?\b|\bcsc\b|\bcid\b|security.?code|securitycode|card.?code|card.?verification|encryptedsecuritycode/.test(t)) return 'cvc';
  if (/name.?on.?(the.?)?card|card.?holder|cardholder|holder.?name|cc-?name/.test(t)) return 'name';
  if (/(exp|expir\w*|valid)[\w\s.-]{0,12}(month|\bmm\b)|(month|\bmm\b)[\w\s.-]{0,12}exp|cc-?month|card.?month|expirymonth|encryptedexpirymonth/.test(t)) return 'expMonth';
  if (/(exp|expir\w*|valid)[\w\s.-]{0,12}(year|\byy(yy)?\b)|(year|\byy(yy)?\b)[\w\s.-]{0,12}exp|cc-?year|card.?year|expiryyear|encryptedexpiryyear/.test(t)) return 'expYear';
  if (/exp-?date|expir|\bexp\b|valid.?(thru|through|until)|mm\s*\/\s*yy|encryptedexpirydate/.test(t)) return 'exp';
  if (/card.?number|cardnumber|cc-?number|ccnum|card.?no\b|card.?#|encryptedcardnumber|credit.?card|debit.?card|\bpan\b/.test(t)) return 'number';
  if (/postal|\bzip\b|zip.?code|postcode/.test(t)) return 'postal';
  return null;
}
// the text to type for an expiry field, from what it shows it wants
function expiryText(kind, a, month, year) {
  const mm = String(month).padStart(2, '0'), yyyy = String(year), yy = yyyy.slice(-2);
  const ph = String(a.placeholder || '').toLowerCase(), max = Number(a.maxLength) || 0;
  if (kind === 'expMonth') return mm;
  if (kind === 'expYear') return (max === 2 || (/\byy\b/.test(ph) && !/yyyy/.test(ph))) ? yy : yyyy;
  if (/yyyy/.test(ph) || max >= 7) return mm + '/' + yyyy;
  if (max === 4) return mm + yy;
  return mm + '/' + yy;
}

/* ---------- the agent browser, over its debugging port ---------- */
async function cdpConnect(port) {
  if (typeof WebSocket === 'undefined') throw new Error('this computer\'s Node is too old for paying (Node 22 or newer is needed)');
  const v = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('could not reach the agent browser')); });
  let n = 0;
  const pend = {}, listeners = [];
  ws.onmessage = (ev) => {
    let m = null; try { m = JSON.parse(String(ev.data)); } catch (e) { return; }
    if (m.id && pend[m.id]) { const p = pend[m.id]; delete pend[m.id]; if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result || {}); }
    else listeners.forEach((f) => f(m));
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++n; pend[id] = { res, rej };
    ws.send(JSON.stringify(Object.assign({ id, method, params }, sessionId ? { sessionId } : {})));
    setTimeout(() => { if (pend[id]) { delete pend[id]; rej(new Error('the browser did not answer ' + method)); } }, 15000);
  });
  return { send, on: (f) => listeners.push(f), close: () => { try { ws.close(); } catch (e) {} } };
}
// the open tab showing the checkout: the exact address, else the one tab on that site
async function findPage(c, pageUrl) {
  const { targetInfos } = await c.send('Target.getTargets');
  const pages = (targetInfos || []).filter((t) => t.type === 'page');
  const exact = pages.filter((t) => t.url === pageUrl);
  if (exact.length) return exact[exact.length - 1];
  const h = hostOf(pageUrl);
  const same = pages.filter((t) => hostOf(t.url) === h);
  return same.length === 1 ? same[0] : null;
}

// runs in each frame, in a world of its own the page can't see: finds the payment fields
// (fieldKind's own source goes in as text: no eval inside the page, which a store's CSP could forbid)
const scanBody = function (fieldKind) {
  const text = (el) => (el ? String(el.innerText || el.textContent || '').trim().slice(0, 80) : '');
  const label = (el) => {
    if (el.labels && el.labels.length) return text(el.labels[0]);
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map((id) => text(document.getElementById(id))).join(' ');
    const wrap = el.closest('label'); return wrap ? text(wrap) : '';
  };
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const els = [...document.querySelectorAll('input, select')].filter((el) => !el.disabled && !el.readOnly && shown(el)
    && !/^(hidden|checkbox|radio|submit|button|image|file|reset|password)$/i.test(el.type || ''));
  globalThis.__romulusPay = [];
  const out = [];
  for (const el of els) {
    const data = [...el.attributes].filter((x) => /^data-/.test(x.name)).map((x) => x.value).join(' ').slice(0, 200);
    const a = { autocomplete: el.getAttribute('autocomplete'), name: el.name, id: el.id, label: label(el), aria: el.getAttribute('aria-label'),
      placeholder: el.getAttribute('placeholder'), data, maxLength: el.maxLength > 0 ? el.maxLength : 0 };
    const kind = fieldKind(a);
    if (!kind) continue;
    const billing = /billing/i.test([a.autocomplete, a.name, a.id, a.label, a.aria].join(' '));
    out.push({ i: globalThis.__romulusPay.length, kind, tag: el.tagName.toLowerCase(), placeholder: a.placeholder || '', maxLength: a.maxLength, billing });
    globalThis.__romulusPay.push(el);
  }
  return out;
};
const SCAN = '(() => { const NOT_PAYMENT = ' + NOT_PAYMENT.toString() + '; const fieldKind = ' + fieldKind.toString()
  + '; return (' + scanBody.toString() + ')(fieldKind); })()';

// every frame of the tab, cross-site card frames (Stripe, Braintree, Adyen…) included → [{sessionId, contextId, top}]
async function frameWorlds(c, pageSession) {
  const sessions = [{ id: pageSession, top: true }];
  const attached = [];
  c.on((m) => { if (m.method === 'Target.attachedToTarget' && m.params && m.params.targetInfo && m.params.targetInfo.type === 'iframe') attached.push(m.params.sessionId); });
  const auto = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };
  await c.send('Target.setAutoAttach', auto, pageSession).catch(() => {});
  await sleep(600);
  for (let k = 0; k < attached.length && k < 40; k++) await c.send('Target.setAutoAttach', auto, attached[k]).catch(() => {}); // frames inside frames
  await sleep(300);
  attached.forEach((s) => sessions.push({ id: s, top: false }));
  const worlds = [], seen = new Set();
  for (const s of sessions) {
    const tree = await c.send('Page.getFrameTree', {}, s.id).catch(() => null);
    if (!tree) continue;
    const walk = async (node, isRoot) => {
      const f = node.frame;
      if (!seen.has(f.id)) {
        const w = await c.send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'romulus-pay' }, s.id).catch(() => null);
        if (w && w.executionContextId) { seen.add(f.id); worlds.push({ sessionId: s.id, contextId: w.executionContextId, top: s.top && isRoot }); }
      }
      for (const ch of node.childFrames || []) await walk(ch, false);
    };
    await walk(tree.frameTree, true);
  }
  return worlds;
}
const evalIn = (c, w, expression) => c.send('Runtime.evaluate', { expression, contextId: w.contextId, returnByValue: true, awaitPromise: true }, w.sessionId)
  .then((r) => (r.result ? r.result.value : undefined));

async function scanPage(c, pageUrl) {
  const page = await findPage(c, pageUrl);
  if (!page) return { error: 'That checkout isn\'t open in the agent browser (' + String(pageUrl).slice(0, 100) + '). Open it, then call this again with the address the tab shows.' };
  const { sessionId } = await c.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {}); // headless: focus still moves into fields
  const worlds = await frameWorlds(c, sessionId);
  const fields = [];
  for (const w of worlds) {
    const found = await evalIn(c, w, SCAN).catch(() => null);
    (found || []).forEach((f) => fields.push(Object.assign({ w }, f)));
  }
  // a ZIP box counts only next to the card (inside the card frame, or marked billing): never the shipping address
  const cardWorlds = new Set(fields.filter((f) => f.kind === 'number').map((f) => f.w));
  const usable = fields.filter((f) => f.kind !== 'postal' || f.billing || (cardWorlds.has(f.w) && !f.w.top));
  return { url: page.url, sessionId, fields: usable };
}

async function typeInto(c, pageSession, f, value) {
  const at = 'globalThis.__romulusPay[' + f.i + ']';
  if (f.tag === 'select') {
    const ok = await evalIn(c, f.w, '(() => { const el = ' + at + '; const want = ' + JSON.stringify(value) + ';'
      + ' const n = Number(want); const o = [...el.options].find((o) => o.value === want || o.text.trim() === want || (n && (Number(o.value) === n || Number(o.text) === n || Number(o.value) === n % 100)));'
      + ' if (!o) return false; el.value = o.value; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()');
    return !!ok;
  }
  await evalIn(c, f.w, '(() => { const el = ' + at + '; el.scrollIntoView({ block: "center" }); el.focus(); if (el.select) el.select(); })()');
  await c.send('Input.insertText', { text: value }, pageSession);
  await sleep(150);
  const digits = value.replace(/\D/g, '');
  const got = await evalIn(c, f.w, 'String(' + at + '.value || "").replace(/\\D/g, "")');
  if (digits ? String(got || '').includes(digits.slice(-4)) && String(got).length >= Math.min(digits.length, 3) : String(got || '').length > 0) return true;
  // a field that ignored the typing: set it the way a page's own script would, and tell the page
  return !!(await evalIn(c, f.w, '(() => { const el = ' + at + '; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;'
    + ' set.call(el, ' + JSON.stringify(value) + '); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return el.value.length > 0; })()'));
}

async function fillCard(c, scan, card) {
  const done = [], missed = [];
  const name = (card.billing_address && card.billing_address.name) || card.name || card.cardholder_name || '';
  const zip = (card.billing_address && card.billing_address.postal_code) || '';
  for (const f of scan.fields) {
    let value = null;
    if (f.kind === 'number') value = String(card.number || '').replace(/\D/g, '');
    else if (f.kind === 'cvc') value = String(card.cvc || '');
    else if (f.kind === 'exp' || f.kind === 'expMonth' || f.kind === 'expYear') value = expiryText(f.kind, f, card.exp_month, card.exp_year);
    else if (f.kind === 'name') value = name;
    else if (f.kind === 'postal') value = zip;
    if (!value) continue;
    const ok = await typeInto(c, scan.sessionId, f, value).catch(() => false);
    (ok ? done : missed).push(f.kind);
    value = null;
  }
  await evalIn(c, scan.fields[0].w, 'document.activeElement && document.activeElement.blur && document.activeElement.blur()').catch(() => {});
  return { done: [...new Set(done)], missed: [...new Set(missed.filter((k) => !done.includes(k)))] };
}

/* ---------- the tools ---------- */
// checks before asking Link for anything → a refusal, or null
function payRefusal(a, opts = {}) {
  const approved = opts.approved != null ? opts.approved : APPROVED;
  const hosts = opts.hosts || APPROVED_HOSTS;
  const cap = opts.cap || CAP;
  if (!approved) return 'Not without a yes. Stop on the checkout with the payment step still empty: list the items, the total with tax and shipping, the store and the address in your note, and ask him to reply **yes** to pay with a one-time Link card.';
  if (opts.mailSeen) return 'This run has opened his mail, so it can\'t pay (a page could have asked for it). Stop with needs-you; paying runs next time.';
  if (opts.used && !a.spend_request_id) return 'A Link card was already used in this run; another payment needs a fresh yes from him.';
  const amount = Number(a.amount_cents);
  if (!Number.isInteger(amount) || amount < 50) return 'amount_cents must be the order total in cents, as a whole number (e.g. 2599 for $25.99).';
  if (amount > cap) return 'This total (' + dollars(amount) + ') is over his limit for one Link payment (' + dollars(cap) + ', Settings → Pay with Link). Stop and tell him.';
  const h = hostOf(a.page_url);
  if (!h || !/^https:/i.test(String(a.page_url))) return 'page_url must be the checkout page\'s https:// address, as the tab shows it.';
  if (hosts.length && !hostIn(h, hosts)) return 'His yes was about ' + hosts.join(', ') + ', not ' + h + '. Ask him again for this store.';
  return null;
}
function contextFor(a, h) {
  const items = (Array.isArray(a.items) ? a.items : []).slice(0, 10).map((it) => (it.quantity > 1 ? it.quantity + ' × ' : '') + String(it.name || '').slice(0, 80)).filter(Boolean);
  let s = 'Paying ' + dollars(Number(a.amount_cents)) + ' including tax and shipping to ' + String(a.merchant_name || h).slice(0, 80) + ' (' + h + ') for '
    + (items.length ? items.join(', ') : 'the order on its checkout page') + '. He reviewed this order in Romulus and replied yes; Romulus enters this one-time card at the store\'s checkout.';
  return s.length >= 100 ? s.slice(0, 1000) : s + ' '.repeat(100 - s.length);
}
function spendBody(a, test) {
  const h = hostOf(a.page_url);
  const items = (Array.isArray(a.items) ? a.items : []).slice(0, 20).filter((it) => it && it.name).map((it) => Object.assign({ name: String(it.name).slice(0, 200), quantity: Math.max(1, Math.round(Number(it.quantity) || 1)) },
    Number.isInteger(Number(it.unit_cents)) && Number(it.unit_cents) > 0 ? { unit_amount: Number(it.unit_cents) } : {}));
  return Object.assign({ credential_type: 'card', amount: Number(a.amount_cents), currency: String(a.currency || 'usd').toLowerCase().slice(0, 3),
    merchant_name: String(a.merchant_name || h).slice(0, 100), merchant_url: 'https://' + h, context: contextFor(a, h),
    totals: [{ type: 'total', display_text: 'Total', amount: Number(a.amount_cents) }], request_approval: true },
  items.length ? { line_items: items } : {}, test ? { test: true } : {});
}

let used = false;
async function payWithLink(a) {
  const no = payRefusal(a, { used, mailSeen: !!TAINT_FILE && fs.existsSync(TAINT_FILE) });
  if (no) return { text: no, isError: true };
  if (!TOKEN) return { text: 'Link isn\'t connected on this computer (Settings → Pay with Link). Stop and tell him.', isError: true };
  const c = await cdpConnect(CDP_PORT);
  try {
    // the card form must be there before Link is asked: no approved card with nowhere to put it
    let scan = await scanPage(c, String(a.page_url));
    if (scan.error) return { text: scan.error, isError: true };
    if (!scan.fields.some((f) => f.kind === 'number')) return { text: 'No card number box on this page. Open the payment step\'s form for a new card ("Add a card", "Credit or debit card", "Use a different card"), leave it empty, and call this again.', isError: true };
    let sr = a.spend_request_id ? await link.getSpend(TOKEN, String(a.spend_request_id)) : await link.createSpend(TOKEN, spendBody(a, TEST));
    if (!sr) return { text: 'Link has no request ' + a.spend_request_id + '. Call again without spend_request_id to ask for a new card.', isError: true };
    if (!a.spend_request_id) logAction('asked Link for a card', { amount: dollars(Number(a.amount_cents)), url: String(a.page_url).slice(0, 200), test: TEST || undefined });
    const until = Date.now() + 8 * 60 * 1000;
    while (link.waiting(sr) && Date.now() < until) { await sleep(3000); sr = (await link.getSpend(TOKEN, sr.id)) || sr; }
    if (link.waiting(sr)) return { text: 'Waiting for him to approve ' + dollars(Number(a.amount_cents)) + ' in the Link app (request ' + sr.id + '). Call pay_with_link_card again with spend_request_id "' + sr.id + '" to keep waiting; Link gives him 30 minutes. If he doesn\'t, stop with needs-you: "Approve the payment in the Link app, then reply done."', isError: true };
    if (sr.status !== 'approved') {
      const act = link.nextAction(sr);
      if (act) return { text: 'Link needs something from him first: ' + (act.display_message || act.type) + (act.action_url ? ' (' + act.action_url + ')' : '') + '. Stop with needs-you, give him that message and link, and ask him to reply done after.', isError: true };
      return { text: 'Link didn\'t approve the card (' + sr.status + '). Nothing was paid. Stop with needs-you and say so.', isError: true };
    }
    const withCard = await link.getSpend(TOKEN, sr.id, true);
    const card = withCard && withCard.card;
    if (!card || !card.number) return { text: 'Link approved it but sent no card. Nothing was typed. Stop with needs-you and say so.', isError: true };
    const last4 = String(card.number).replace(/\D/g, '').slice(-4), brand = String(card.brand || 'Card');
    // the browser launcher masks card numbers and stops screenshots from now on: written before anything is typed
    if (CARD_FLAG) try { fs.writeFileSync(CARD_FLAG, JSON.stringify({ at: Date.now(), last4 })); } catch (e) {}
    scan = await scanPage(c, String(a.page_url)); // the page may have redrawn while he was approving
    if (scan.error || !scan.fields.some((f) => f.kind === 'number')) return { text: 'The card form went away while he was approving. Open it again and call this with spend_request_id "' + sr.id + '" (the card is still good).', isError: true };
    const r = await fillCard(c, scan, card);
    used = true;
    logAction('filled a Link card', { amount: dollars(Number(a.amount_cents)), last4, url: String(scan.url).slice(0, 200), test: TEST || undefined });
    const valid = card.valid_until ? ' It is good until ' + new Date(card.valid_until).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + '.' : '';
    return { text: 'Typed a one-time Link card (' + brand + ' •••• ' + last4 + (TEST ? ', TEST card: nothing will really be charged' : '') + ') into: ' + r.done.join(', ') + '.'
      + (r.missed.length ? ' Could not fill: ' + r.missed.join(', ') + '; if the store asks for those, stop with needs-you ("Finish the card on <Store>: tap ◉ Watch") and never type them yourself.' : '')
      + valid + ' Now check the page shows no card error and the total is still ' + dollars(Number(a.amount_cents)) + ', then place the order with the store\'s button (his yes covers it). Never read out, copy or retype the card.' };
  } finally { c.close(); }
}

async function walletStatus() {
  if (!TOKEN) return { text: 'Link isn\'t connected. Paying with a one-time Link card isn\'t available; use the store\'s saved payment or hand checkout to him.' };
  let info = null; try { info = await link.userInfo(TOKEN); } catch (e) { return { text: 'Link is connected but didn\'t answer (' + e.message + '). Hand checkout to him for now.', isError: true }; }
  const lim = (info && info.agent_wallet_spend_limits) || {};
  const day = lim.daily && lim.daily.remaining != null ? ' Left today: ' + dollars(lim.daily.remaining) + '.' : '';
  const ver = info && info.agent_wallet_verification_requirement;
  const needs = ver && ver.status && !/^(not_required|complete)$/.test(ver.status) ? ' Link wants him to finish setting up first (' + ver.status + (ver.action_url ? ': ' + ver.action_url + ')' : ')') + '.' : '';
  return { text: 'Link is connected' + (TEST ? ' in TEST mode (test cards, nothing is charged)' : '') + '. You can pay at any store\'s card form with a one-time Link card after his yes, up to ' + dollars(CAP) + ' an order. He approves each one in the Link app.' + day + needs };
}

const TOOLS = [
  { name: 'link_wallet_status', description: 'Whether he can pay with a one-time Stripe Link card (a virtual card made for one order, approved on his phone), and his limits. Use before offering it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'pay_with_link_card', description: 'After his yes to an order: gets a one-time Link card for exactly this total (he approves it in the Link app; this waits up to 8 minutes) and types it into the card form on the checkout page that is open in the agent browser. You never see or type the card. Open the new-card form first and leave it empty. Then place the order yourself.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['page_url', 'merchant_name', 'amount_cents'], properties: {
      page_url: { type: 'string', description: 'The checkout page\'s address, exactly as the tab shows it' },
      merchant_name: { type: 'string', description: 'The store\'s name' },
      amount_cents: { type: 'integer', description: 'The order total in cents, with tax and shipping, as the checkout shows it' },
      currency: { type: 'string', description: 'Three-letter currency code; usd if left out' },
      items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, quantity: { type: 'integer' }, unit_cents: { type: 'integer' } }, required: ['name'] } },
      spend_request_id: { type: 'string', description: 'Only to keep waiting on a request this tool already made (it tells you the id)' } } } },
];

function main() {
  const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
  let buf = '', chain = Promise.resolve();
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m = null; try { m = JSON.parse(line); } catch (e) { continue; }
      if (m.id == null) continue; // notifications
      chain = chain.then(async () => {
        if (m.method === 'initialize') return reply(m.id, { protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'wallet', version: '1.0.0' } });
        if (m.method === 'ping') return reply(m.id, {});
        if (m.method === 'tools/list') return reply(m.id, { tools: TOOLS });
        if (m.method !== 'tools/call') return fail(m.id, -32601, 'unknown method');
        const name = m.params && m.params.name, args = (m.params && m.params.arguments) || {};
        let r;
        try { r = name === 'pay_with_link_card' ? await payWithLink(args) : name === 'link_wallet_status' ? await walletStatus() : { text: 'No such tool.', isError: true }; }
        catch (e) { r = { text: 'Paying with Link failed: ' + String(e.message || e).slice(0, 300) + '. Nothing was typed unless this says so. Stop with needs-you and tell him.', isError: true }; }
        reply(m.id, { content: [{ type: 'text', text: r.text }], isError: !!r.isError });
      });
    }
  });
}

if (require.main === module) main();
else module.exports = { fieldKind, expiryText, payRefusal, spendBody, contextFor, SCAN, TOOLS, cdpConnect, scanPage, fillCard };
