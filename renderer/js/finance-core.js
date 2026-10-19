/* The Finance tab's bank and stock code that the computer and the phone share: reading SimpleFIN
   (bridge.simplefin.org) and Yahoo Finance's public price charts, with no storage, keys or UI in it.
   The computer runs it in its main process (main/finance.js, main/finance-stocks.js); the phone runs it
   in its page (mobile/finance-phone.js). `doFetch` is fetch on the computer and a native request on the
   phone (the page itself can't reach these sites). Only symbols ever go to Yahoo.
   One of the page scripts in renderer/js (as window.FinCore, so its names don't clash with the others').
   Also loaded with require() by the main process and the tests. */
(function () {
  'use strict';
  const FETCH_DAYS = 90;
  const KEEP_DAYS = 400; // history builds up past SimpleFIN's window, a year and a bit
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').slice(0, n || 200);
  const b64 = (s) => (typeof Buffer !== 'undefined' ? Buffer.from(s, 'utf8').toString('base64') : btoa(unescape(encodeURIComponent(s))));
  const timeout = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

  /* ── SimpleFIN ── */
  // only simplefin.org, only HTTPS: a pasted token or a scanned code can't point this at anything else
  function checkSimplefinUrl(u) {
    let x;
    try { x = new URL(u); } catch (e) { return null; }
    const host = x.hostname.toLowerCase();
    if (x.protocol !== 'https:' || !(host === 'simplefin.org' || host.endsWith('.simplefin.org'))) return null;
    return x;
  }
  // the bank's own wording too, when the payee name hides it ("AMAZON MKTPLACE PMTS" under "Amazon")
  function bankText(t) {
    const out = {};
    const shown = String(t.payee || t.description || '').trim().toLowerCase();
    const raw = txt(t.description, 300).trim(), memo = txt(t.memo, 300).trim();
    if (raw && raw.toLowerCase() !== shown) out.bank = raw;
    if (memo && memo.toLowerCase() !== shown && memo.toLowerCase() !== raw.toLowerCase()) out.memo = memo;
    return out;
  }
  // what SimpleFIN sent, cut down to the fields the tab shows (nothing else from it is kept)
  function cleanAccounts(body) {
    const conns = {};
    for (const c of Array.isArray(body.connections) ? body.connections : []) if (c && c.conn_id) conns[c.conn_id] = c.org_name || c.name;
    return (Array.isArray(body.accounts) ? body.accounts : []).filter((a) => a && a.id).map((a) => ({
      id: txt(a.id, 120), name: txt(a.name, 120),
      org: txt(conns[a.conn_id] || (a.org && (a.org.name || a.org.domain)) || '', 120),
      currency: /^[A-Z]{3}$/.test(a.currency) ? a.currency : 'USD',
      balance: num(a.balance), available: a['available-balance'] == null ? null : num(a['available-balance']),
      balanceDate: num(a['balance-date']),
      transactions: (Array.isArray(a.transactions) ? a.transactions : []).filter((t) => t && t.id).map((t) => Object.assign({
        id: txt(t.id, 160), posted: num(t.posted) || num(t.transacted_at), amount: num(t.amount),
        description: txt(t.payee || t.description, 200), pending: !!t.pending || !num(t.posted),
      }, bankText(t))),
      holdings: cleanHoldings(a.holdings), // a brokerage account's stocks
    }));
  }
  const errorsOf = (body) => (Array.isArray(body.errlist) ? body.errlist.map((e) => e && e.msg) : Array.isArray(body.errors) ? body.errors : [])
    .filter(Boolean).map((m) => txt(m, 300)).slice(0, 10);
  // new download + what was kept before: transactions add up past SimpleFIN's window; pending ones are replaced
  function mergeAccounts(old, fresh, now) {
    const cutoff = now / 1000 - KEEP_DAYS * 86400;
    const before = {};
    for (const a of old || []) before[a.id] = a;
    return fresh.map((a) => {
      const seen = new Set(a.transactions.map((t) => t.id));
      const kept = ((before[a.id] || {}).transactions || []).filter((t) => !seen.has(t.id) && !t.pending && t.posted >= cutoff);
      const all = a.transactions.concat(kept).sort((x, y) => (y.posted || Infinity) - (x.posted || Infinity));
      return Object.assign({}, a, { transactions: all });
    });
  }
  // the last 90 days of every account (credentials go in a header, never in the address)
  async function downloadAccounts(accessUrl, doFetch) {
    const x = checkSimplefinUrl(accessUrl);
    if (!x) throw new Error('The saved SimpleFIN link isn’t valid. Forget it and connect again.');
    const auth = 'Basic ' + b64(decodeURIComponent(x.username) + ':' + decodeURIComponent(x.password));
    x.username = ''; x.password = '';
    const base = x.toString().replace(/\/+$/, '');
    const start = Math.floor(Date.now() / 1000) - FETCH_DAYS * 86400;
    let r;
    try { r = await doFetch(base + '/accounts?version=2&pending=1&start-date=' + start, { headers: { Authorization: auth }, redirect: 'error', signal: timeout(90000) }); }
    catch (e) { throw new Error('Couldn’t reach SimpleFIN. Are you online?'); }
    if (r.status === 403) throw new Error('SimpleFIN turned this connection off (or it was disabled on bridge.simplefin.org). Forget it and connect again with a new token.');
    if (r.status === 402) throw new Error('SimpleFIN says the subscription needs paying.');
    if (!r.ok) throw new Error('SimpleFIN had a problem (HTTP ' + r.status + '). Try again later.');
    const body = await r.json().catch(() => null);
    if (!body || typeof body !== 'object') throw new Error('SimpleFIN sent something unreadable.');
    return { accounts: cleanAccounts(body), errors: errorsOf(body) };
  }

  /* ── stocks: what he owns (SimpleFIN holdings) at Yahoo Finance's prices ── */
  const MAX_SYMBOLS = 50;
  const SYMBOL = /^[A-Z][A-Z0-9.\-]{0,9}$/;
  const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
  // SimpleFIN's holdings on an account, cut down to what the tab shows
  function cleanHoldings(list) {
    return (Array.isArray(list) ? list : []).filter((h) => h && (h.symbol || h.description)).slice(0, 200).map((h) => ({
      symbol: SYMBOL.test(String(h.symbol || '').trim().toUpperCase()) ? String(h.symbol).trim().toUpperCase() : '',
      name: txt(h.description, 120).trim(), shares: num(h.shares), value: num(h.market_value),
      cost: h.cost_basis == null || h.cost_basis === '' ? null : num(h.cost_basis),
    }));
  }
  // every account's holdings, the same symbol added up (it can be in two accounts)
  function holdingsOf(accounts) {
    const by = {};
    (accounts || []).forEach((a) => (a.holdings || []).forEach((h) => {
      const k = h.symbol || 'name:' + h.name;
      const o = by[k] || (by[k] = { symbol: h.symbol, name: h.name, shares: 0, value: 0, cost: 0, costKnown: true });
      o.shares += h.shares; o.value += h.value;
      if (h.cost == null) o.costKnown = false; else o.cost += h.cost;
    }));
    return Object.values(by);
  }
  // one symbol's chart → {c price, d change, dp change %, pc previous close, t seconds, series: [[ms, close]]}
  function readChart(body) {
    const x = body && body.chart && Array.isArray(body.chart.result) && body.chart.result[0];
    if (!x || !x.meta || !(num(x.meta.regularMarketPrice) > 0)) return null;
    const c = num(x.meta.regularMarketPrice), pc = num(x.meta.chartPreviousClose) || num(x.meta.previousClose);
    const closes = (x.indicators && x.indicators.quote && x.indicators.quote[0] && x.indicators.quote[0].close) || [];
    const series = (x.timestamp || []).map((t, i) => [t * 1000, closes[i]]).filter((p) => typeof p[1] === 'number' && p[1] > 0);
    return { c, d: pc ? c - pc : 0, dp: pc ? (c - pc) / pc * 100 : 0, pc, t: num(x.meta.regularMarketTime), series };
  }
  /* symbols → {quotes: {SYM: chart}, warning}. range '1d' (every 5 min, the price now) or '1y' / '6mo' (a close a day).
     Unknown symbols are left out; if none came, it throws. Yahoo writes class shares with a dash: BRK.B → BRK-B */
  async function fetchQuotes(symbols, doFetch, range) {
    const out = {};
    const query = range === '1y' ? '?range=1y&interval=1d' : range === '6mo' ? '?range=6mo&interval=1d' : '?range=1d&interval=5m';
    const list = Array.from(new Set(symbols.filter((s) => SYMBOL.test(s)))).slice(0, MAX_SYMBOLS);
    let failed = null;
    for (let i = 0; i < list.length; i += 5) {
      await Promise.all(list.slice(i, i + 5).map(async (s) => {
        let r;
        try {
          r = await doFetch(YAHOO + encodeURIComponent(s.replace(/\./g, '-')) + query,
            { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, redirect: 'error', signal: timeout(15000) });
        } catch (e) { failed = failed || 'Couldn’t reach Yahoo Finance. Are you online?'; return; }
        if (r.status === 429) { failed = failed || 'Yahoo Finance says too many requests. Prices update again in a minute.'; return; }
        if (r.status === 404) return; // not a symbol Yahoo knows
        if (!r.ok) { failed = failed || 'Yahoo Finance had a problem (HTTP ' + r.status + ').'; return; }
        const q = readChart(await r.json().catch(() => null));
        if (q) out[s] = q;
      }));
    }
    if (failed && !Object.keys(out).length) throw new Error(failed);
    return { quotes: out, warning: failed };
  }
  // what it's all worth now: each holding at its live price (else SimpleFIN's value), today's change, gain on cost
  function portfolio(holdings, quotes) {
    const rows = holdings.map((h) => {
      const q = h.symbol && quotes[h.symbol];
      const price = q ? q.c : h.shares ? h.value / h.shares : 0;
      const value = q && h.shares ? h.shares * q.c : h.value;
      const cost = h.costKnown && h.cost ? h.cost : null;
      return { symbol: h.symbol, name: h.name, shares: h.shares, price, live: !!q, change: q ? h.shares * q.d : 0, changePct: q ? q.dp : 0,
        value, cost, gain: cost == null ? null : value - cost };
    }).sort((a, b) => b.value - a.value);
    const sum = (f) => rows.reduce((s, r) => s + (f(r) || 0), 0);
    const total = sum((r) => r.value), change = sum((r) => r.change);
    const withCost = rows.filter((r) => r.cost != null);
    return { rows, total, change, changePct: total - change ? change / (total - change) * 100 : 0,
      cost: withCost.length ? withCost.reduce((s, r) => s + r.cost, 0) : null,
      gain: withCost.length ? withCost.reduce((s, r) => s + r.gain, 0) : null,
      at: Math.max(0, ...Object.values(quotes).map((q) => q.t)) * 1000 };
  }
  /* the whole portfolio as one line: at each time any stock has a price, every holding at its latest price by
     then (before its first one: its first one); one without prices counts at the brokerage's value throughout */
  function portfolioLine(holdings, quotes) {
    const times = new Set();
    holdings.forEach((h) => { const q = h.symbol && quotes[h.symbol]; if (q) q.series.forEach((p) => times.add(p[0])); });
    const ts = Array.from(times).sort((a, b) => a - b);
    if (!ts.length) return [];
    const has = (h) => h.symbol && quotes[h.symbol] && quotes[h.symbol].series.length;
    const fixed = holdings.filter((h) => !has(h)).reduce((s, h) => s + h.value, 0);
    const live = holdings.filter(has).map((h) => ({ shares: h.shares, series: quotes[h.symbol].series, i: 0 }));
    return ts.map((t) => {
      let v = fixed;
      live.forEach((l) => {
        while (l.i + 1 < l.series.length && l.series[l.i + 1][0] <= t) l.i++;
        v += l.shares * l.series[l.i][1];
      });
      return [t, Math.round(v * 100) / 100];
    });
  }
  /* the Stocks card's numbers from the latest prices: today's (every 5 min) and a year of closes, with
     today's live total ending the daily line */
  function stocksView(held, today, daily, error, warning) {
    const quotes = error ? {} : today || {};
    const p = portfolio(held, quotes);
    const days = daily ? portfolioLine(held, daily) : [];
    if (days.length && p.at && Object.keys(quotes).length) {
      const d = new Date(p.at); d.setHours(0, 0, 0, 0);
      while (days.length && days[days.length - 1][0] >= d.getTime()) days.pop();
      days.push([p.at, Math.round(p.total * 100) / 100]);
    }
    return Object.assign({ held: held.length }, p, { today: portfolioLine(held, quotes), days, warning: error ? null : warning || null, error: error || null });
  }

  const FinCore = { FETCH_DAYS, KEEP_DAYS, num, txt, checkSimplefinUrl, bankText, cleanAccounts, errorsOf, mergeAccounts, downloadAccounts,
    SYMBOL, cleanHoldings, holdingsOf, readChart, fetchQuotes, portfolio, portfolioLine, stocksView };
  if (typeof module !== 'undefined' && module.exports) module.exports = FinCore;
  else window.FinCore = FinCore;
})();
