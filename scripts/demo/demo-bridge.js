/* The demo's stand-in for the desktop bridge (preload.js): made-up tasks, a made-up bank, and an Agent run that
   plays itself out. scripts/demo/build.js copies the renderer and loads this ahead of the app's own scripts, so
   the page thinks it's inside the app. Nothing here touches the real app: no file, no key, no network.
   Everything in it is invented demo data. */
(function () {
  'use strict';
  const DAY = 86400000;
  const now = Date.now();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const ymd = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const inDays = function (n) { const d = new Date(today); d.setDate(d.getDate() + n); return ymd(d); };
  let seed = 7;
  const rnd = function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const between = function (a, b) { return Math.round((a + rnd() * (b - a)) * 100) / 100; };
  const pick = function (l) { return l[Math.floor(rnd() * l.length)]; };
  let n = 0;
  // not 'demo-': that prefix is the welcome card's example to-dos (demo.js), which get a "Remove the examples" bar
  const id = function () { return 'sample-' + (++n); };

  /* ── the lists ── */
  const task = function (title, extra) {
    return Object.assign({ id: id(), title: title, done: false, due: null, dueTime: null, tag: null, ws: 'personal', subs: [], googleEventId: null, created: now - 3 * DAY, updatedAt: now - 3 * DAY }, extra || {});
  };
  const said = function (who, text, ago) { return { who: who, text: text, at: now - ago }; };
  const FLIGHT = 'Cheapest nonstop is $212 on Frontier (carry-on extra), or $248 on United with a carry-on included. Book the United one?';
  const VACUUM = 'Short version: the Roborock Q5 Pro ($279) is the best of the three. Strongest suction, the only one with a mop, and the app works without an account. The Eufy 11S ($149) is the quiet budget pick; skip the iLife, its reviews mention it getting stuck.';
  const tasks = [
    task('Pick up the dry cleaning', { due: inDays(0), dueTime: '17:30' }),
    task('Call the dentist about Thursday', { due: inDays(1), tag: 'health' }),
    // a repeating to-do and its streak (recur.js): ticked off on time 6 days running
    task('Water the plants', { due: inDays(0), recur: { every: 'day', dom: today.getDate(), series: 'sample-plants', streak: 6, best: 9 } }),
    task('Birthday card for Mom', { due: inDays(5), tag: 'family', subs: [{ id: id(), title: 'Buy a card', done: true, due: null }, { id: id(), title: 'Post it by Friday', done: false, due: null }] }),
    task('Renew the car registration', { due: inDays(8) }),
    task('Book the campsite for Thanksgiving weekend', { tag: 'trip' }),
    task('Return the library books', { done: true, doneAt: now - DAY, due: inDays(-1) }),
    task('Find the cheapest round-trip flight to Denver, Nov 14–17', { ws: 'agent', status: 'needs-you', created: now - 2 * DAY, note: FLIGHT, history: [said('claude', FLIGHT, 2 * 3600000)] }),
    task('Compare three robot vacuums under $300', { ws: 'agent', status: 'done', created: now - 4 * DAY, note: VACUUM, history: [said('claude', VACUUM, 26 * 3600000)] }),
    task('Summarize this week’s tech news in 5 bullets', { ws: 'agent', status: 'queued', created: now - 3600000, history: [] }),
    task('Problem set 4', { ws: 'school', kind: 'regular', tag: 'MATH 221', due: inDays(2) }),
    task('Reading response: chapters 5–6', { ws: 'school', kind: 'regular', tag: 'ENGL 110', due: inDays(4) }),
    task('Send the Q4 numbers to Priya', { ws: 'work', due: inDays(1), dueTime: '11:00' })
  ];
  const doc = { v: 1, tasks: tasks, tombstones: [], ideas: null, hours: null };

  /* ── the bank: five months of made-up transactions ── */
  const txs = { chk: [], sav: [], card: [], brk: [] };
  const add = function (acct, daysAgo, amount, description, extra) {
    if (daysAgo < 0) return;
    const d = new Date(today); d.setDate(d.getDate() - daysAgo); d.setHours(9 + Math.floor(rnd() * 9), Math.floor(rnd() * 60));
    txs[acct].push(Object.assign({ id: acct + '-' + txs[acct].length, posted: Math.floor(d.getTime() / 1000), amount: amount, description: description, pending: false }, extra || {}));
  };
  const monthly = function (acct, day, amount, description, months) {
    for (let m = 0; m < (months || 6); m++) {
      const d = new Date(today.getFullYear(), today.getMonth() - m, day);
      const ago = Math.round((today - d) / DAY);
      if (ago < 0) continue;
      add(acct, ago, typeof amount === 'function' ? amount(m) : amount, description);
    }
  };
  const SPAN = 170;
  monthly('chk', 1, 2150, 'ACME CORP PAYROLL DIRECT DEP');
  monthly('chk', 15, 2150, 'ACME CORP PAYROLL DIRECT DEP');
  monthly('chk', 1, -1450, 'OAKWOOD APARTMENTS RENT');
  monthly('chk', 2, -500, 'ONLINE TRANSFER TO SAVINGS');
  monthly('chk', 5, -112.4, 'GEICO INSURANCE');
  monthly('chk', 12, -85, 'VERIZON WIRELESS');
  monthly('chk', 18, -70, 'XFINITY INTERNET');
  monthly('chk', 20, -24.99, 'PLANET FITNESS');
  monthly('chk', 25, -400, 'CREDIT CARD PAYMENT CHASE');
  for (let d = 2; d < SPAN; d += 6 + Math.floor(rnd() * 3)) add('chk', d, -between(58, 112), pick(['WALMART SUPERCENTER', 'TRADER JOE’S', 'WALMART SUPERCENTER']));
  for (let d = 4; d < SPAN; d += 9 + Math.floor(rnd() * 4)) add('chk', d, -between(36, 54), 'SHELL OIL');
  const ODD = ['TARGET', 'HOME DEPOT', 'CVS PHARMACY', 'USPS', 'BEST BUY', 'IKEA', 'REI', 'PETCO'];
  for (let d = 7, i = 0; d < SPAN; d += 20 + Math.floor(rnd() * 12), i++) add('chk', d, -between(20, 140), ODD[i % ODD.length]);
  monthly('sav', 2, 500, 'ONLINE TRANSFER FROM CHECKING');
  monthly('sav', 28, function () { return between(37, 43); }, 'INTEREST PAID');
  monthly('card', 8, function (m) { return m < 2 ? -17.99 : -15.49; }, 'NETFLIX.COM');
  monthly('card', 3, -11.99, 'SPOTIFY USA');
  monthly('card', 27, function (m) { return -[23.6, 19.1, 27.4, 17.8, 25.9, 21.2][m]; }, 'INTEREST CHARGE PURCHASE'); // varies, so it isn't taken for a subscription
  monthly('card', 25, 400, 'PAYMENT THANK YOU');
  for (let d = 1; d < SPAN; d += 5 + Math.floor(rnd() * 4)) add('card', d, -between(12, 64), 'AMAZON MKTPLACE PMTS', { bank: 'AMZN Mktp US*' + Math.floor(100000 + rnd() * 899999) });
  for (let d = 3; d < SPAN; d += 4 + Math.floor(rnd() * 4)) add('card', d, -between(14, 46), pick(['CHIPOTLE', 'SWEETGREEN', 'DOORDASH', 'PANERA BREAD', 'THAI BASIL']));
  for (let d = 1; d < SPAN; d += 3 + Math.floor(rnd() * 3)) add('card', d, -between(4.5, 7.25), 'STARBUCKS');
  monthly('brk', 10, -500, 'BUY VTI VANGUARD TOTAL STOCK');
  monthly('brk', 22, function () { return between(44, 58); }, 'DIVIDEND VTI', 6);
  txs.brk = txs.brk.filter(function (t) { return t.description !== 'DIVIDEND VTI' || rnd() < 0.4; });
  Object.keys(txs).forEach(function (k) { txs[k].sort(function (a, b) { return b.posted - a.posted; }); });
  const holdings = [
    { symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', shares: 45, value: 13455, cost: 11520, type: 'ETF' },
    { symbol: 'AAPL', name: 'Apple Inc.', shares: 25, value: 6712.5, cost: 4380, type: 'Stock', sector: 'Technology', industry: 'Consumer Electronics' },
    { symbol: 'NVDA', name: 'NVIDIA Corporation', shares: 20, value: 3684, cost: 1890, type: 'Stock', sector: 'Technology', industry: 'Semiconductors' },
    { symbol: 'MSFT', name: 'Microsoft Corporation', shares: 12, value: 5078.4, cost: 3960, type: 'Stock', sector: 'Technology', industry: 'Software' }
  ];
  const accounts = [
    { id: 'chk', name: 'Total Checking', org: 'Chase', currency: 'USD', balance: 3412.57, available: 3412.57, balanceDate: Math.floor(now / 1000), transactions: txs.chk, holdings: [] },
    { id: 'sav', name: 'Online Savings', org: 'Ally', currency: 'USD', balance: 12840.22, available: null, balanceDate: Math.floor(now / 1000), transactions: txs.sav, holdings: [] },
    { id: 'card', name: 'Sapphire Preferred', org: 'Chase', currency: 'USD', balance: -1238.4, available: 8761.6, balanceDate: Math.floor(now / 1000), transactions: txs.card, holdings: [] },
    { id: 'brk', name: 'Brokerage', org: 'Fidelity', currency: 'USD', balance: 28929.9, available: null, balanceDate: Math.floor(now / 1000), transactions: txs.brk, holdings: holdings.map(function (h) { return { symbol: h.symbol, name: h.name, shares: h.shares, value: h.value, cost: h.cost }; }) }
  ];
  // a year of prices for each holding: a random walk that ends at today's value
  const walk = function (end, days, drift) {
    const out = []; let v = end;
    for (let i = 0; i <= days; i++) out.push(v);
    for (let i = days - 1; i >= 0; i--) { v = v / (1 + drift / days + (rnd() - 0.5) * 0.03); out[i] = v; }
    return out.map(function (x, i) { return [today.getTime() - (days - i) * DAY, Math.round(x * 100) / 100]; });
  };
  // a row's days are the share price; the summary's days are what the whole lot was worth
  const rows = holdings.map(function (h) {
    const price = Math.round(h.value / h.shares * 100) / 100;
    const days = walk(price, 365, h.symbol === 'NVDA' ? 0.6 : 0.18);
    const changePct = between(-1.8, 2.4);
    return Object.assign({}, h, { price: price, live: true, changePct: changePct, change: Math.round(h.value * changePct / 100 * 100) / 100, gain: Math.round((h.value - h.cost) * 100) / 100, days: days });
  });
  const total = rows.reduce(function (s, r) { return s + r.value; }, 0), change = rows.reduce(function (s, r) { return s + r.change; }, 0);
  const stocks = { held: rows.length, rows: rows, total: Math.round(total * 100) / 100, change: Math.round(change * 100) / 100, changePct: Math.round(change / (total - change) * 10000) / 100,
    gain: rows.reduce(function (s, r) { return s + r.gain; }, 0), at: now, days: rows[0].days.map(function (p, i) { return [p[0], Math.round(rows.reduce(function (s, r) { return s + r.days[i][1] * r.shares; }, 0) * 100) / 100]; }) };
  const kinds = {};

  /* ── the Agent run that plays itself out: a grocery order, then its placing after the yes ── */
  const listeners = {};
  const on = function (name) { return function (cb) { (listeners[name] = listeners[name] || []).push(cb); }; };
  const emit = function (name, p) { (listeners[name] || []).forEach(function (cb) { try { cb(p); } catch (e) { console.error(e); } }); };
  const staged = {};
  const cart = [
    { name: 'Great Value Whole Milk, 1 gal', qty: 1, price: '$3.48', url: 'https://www.walmart.com/ip/10450114' },
    { name: 'Large White Eggs, 18 ct', qty: 1, price: '$4.12', url: 'https://www.walmart.com/ip/172844767' },
    { name: 'Bananas, about 3 lb', qty: 1, price: '$1.62', unit: '$0.54/lb', url: 'https://www.walmart.com/ip/44390948' },
    { name: 'Chicken Thighs, bone-in, 2.3 lb', qty: 1, price: '$7.59', url: 'https://www.walmart.com/ip/27935840' },
    { name: 'Jasmine Rice, 5 lb', qty: 1, price: '$6.98', url: 'https://www.walmart.com/ip/10315695' },
    { name: 'Baby Spinach, 10 oz', qty: 1, price: '$3.24', url: 'https://www.walmart.com/ip/44391185' },
    { name: 'Café Bustelo Ground Coffee, 10 oz', qty: 1, price: '$5.48', url: 'https://www.walmart.com/ip/10291331' }
  ];
  const stage = function (t) {
    if (!/grocer/i.test(t.title)) return;
    const step = staged[t.id] || 0;
    if (step === 0 && !t.reply) {
      staged[t.id] = 1;
      setTimeout(function () { emit('agent:working', [t.id]); }, 900);
      setTimeout(function () {
        emit('agent:results', [{ id: t.id, status: 'needs-you', cart: cart,
          note: 'All 7 are in stock at the Walmart Supercenter on Ridge Rd, for pickup tomorrow between 10 and 11am. The cart comes to $32.51, no substitutions. Reply **yes** and I’ll place the order.' }]);
      }, 4200);
    } else if (step === 1 && /yes/i.test(t.reply || '')) {
      staged[t.id] = 2;
      setTimeout(function () { emit('agent:working', [t.id]); }, 700);
      setTimeout(function () {
        emit('agent:results', [{ id: t.id, status: 'done', list: { bought: cart.map(function (c) { return c.name; }) },
          note: 'Order placed: Walmart order 200014-3391, pickup tomorrow 10–11am, $32.51 on the card ending 4471. The confirmation email is in your inbox.' }]);
      }, 3600);
    }
  };

  window.desktop = {
    load: async function () { return JSON.stringify(doc); },
    loadRestored: async function () { return null; },
    hostName: async function () { return 'demo'; },
    save: async function (raw) {
      try { JSON.parse(raw).tasks.forEach(function (t) { if (t.ws === 'agent' && !t.done && t.status === 'queued') stage(t); }); } catch (e) {}
      return true;
    },
    aiStatus: async function () {
      return { ready: true, order: [{ id: 'claude', on: true }], names: { claude: 'Claude' }, used: {},
        claude: { installed: true, ready: true, email: 'you@example.com', plan: 'Pro' }, gemini: { hasKey: false }, openai: { via: 'key', hasKey: false, codex: {} }, openrouter: { hasKey: false } };
    },
    onAgentWorking: on('agent:working'),
    onAgentResults: on('agent:results'),
    onAgentWaiting: on('agent:waiting'),
    financeStatus: async function () { return { setUp: true, unlocked: true, fetchedAt: now - 23 * 60000, waitSeconds: 0, minPassphrase: 8 }; },
    financeData: async function () { return { locked: false, fetchedAt: now - 23 * 60000, accounts: accounts, errors: [], kinds: kinds, hello: false, receipts: [], mail: { last: 0, error: null, off: true, busy: false } }; },
    financeStocks: async function () { return stocks; },
    financeRefresh: async function () { return { ok: true }; },
    financeLock: async function () { return { ok: true }; },
    financeUnlock: async function () { return { ok: true }; },
    financeSetKind: async function (payee, kind) { if (kind == null) delete kinds[payee]; else kinds[payee] = kind; return { ok: true, kinds: kinds }; },
    financeBills: async function () { return { bills: [], odd: [], reminded: {} }; },
    onFinanceLocked: function () {},
    onFinanceUpdated: function () {}
  };
  // no welcome card, a light theme, and no scrollbar in the frames; no sync nudge bar, and no start on the Romulus
  // server (hosted-sync.js hostedAutoStart): the page would wait on the network before showing the lists
  try { localStorage.setItem('tasks.welcomed.v1', String(now)); localStorage.setItem('tasks.themeMode.v1', 'light'); localStorage.setItem('tasks.syncNudge.later', String(now)); localStorage.setItem('tasks.syncHostedOff', '1'); localStorage.setItem('tabsOff', '["family"]'); } catch (e) {}
  const css = document.createElement('style'); css.textContent = '::-webkit-scrollbar{display:none}'; document.head.appendChild(css);

  /* ── a caption at the bottom of the page, for the recording ── */
  window.demoCaption = function (text) {
    let c = document.getElementById('demoCaption');
    if (!c) {
      c = document.createElement('div'); c.id = 'demoCaption';
      c.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);max-width:88%;padding:11px 18px;border-radius:999px;background:rgba(28,28,26,.9);color:#fff;font:500 15px/1.35 "Schibsted Grotesk",system-ui,sans-serif;letter-spacing:.01em;box-shadow:0 6px 24px rgba(0,0,0,.18);z-index:9999;text-align:center;pointer-events:none;white-space:nowrap';
      document.body.appendChild(c);
    }
    c.textContent = text || ''; c.hidden = !text;
  };
})();
