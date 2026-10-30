/* Finance from CSV files, for wherever the app has no SimpleFIN behind it (the app in a web browser), or for
   anyone who'd rather not use SimpleFIN. He downloads a CSV from his bank's website and drops it in; it's read
   here, in this page, and kept only in this browser, encrypted (AES-GCM, key from his passphrase with PBKDF2)
   the way the computer keeps SimpleFIN's. Nothing from it is synced or sent anywhere.
   window.csvFinance answers the same finance* calls as the desktop bridge and mobile/finance-phone.js, plus
   financeImport for a new file. Uploading the same file again (or one that overlaps) doesn't double anything.
   One of the page scripts in renderer/js (loaded ahead of finance.js). Also loaded by test/finance-csv.test.js. */
(function () {
  'use strict';
  const STORE = 'tasks-finance-csv:1';
  const MIN_PASS = 8;
  const ROUNDS = 310000;
  const IDLE_LOCK_MS = 30 * 60 * 1000;
  const MAX_ROWS = 20000;
  const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n || 200);

  /* ── reading a bank's CSV ── */
  // quoted fields, doubled quotes, commas/newlines inside quotes; ; or tab when the file uses those instead
  function splitCsv(text) {
    text = String(text || '').replace(/^﻿/, '');
    const first = text.split(/\r?\n/, 1)[0] || '';
    const sep = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === sep) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some((x) => x.trim() !== '')) rows.push(row);
        row = [];
        if (rows.length > MAX_ROWS) break;
      } else cell += c;
    }
    row.push(cell);
    if (row.some((x) => x.trim() !== '')) rows.push(row);
    return rows;
  }
  // which column is which, from the header's words (banks name them all sorts of ways)
  const COLS = {
    date: /^(posted|posting|transaction|trans\.?|txn|booking|value)?\s*date$|^date\b|^posted$/i,
    desc: /description|payee|merchant|^name$|details|narrative|^transaction$|counterparty|^memo$/i,
    memo: /^memo$|^notes?$|reference|^extended/i,
    amount: /^amount|^transaction amount|^value$|^net amount/i,
    debit: /debit|withdrawal|money out|^out$|paid out|charges?$/i,
    credit: /credit|deposit|money in|^in$|paid in|payments?$/i,
    balance: /balance/i,
    category: /^category/i,
  };
  function findColumns(header) {
    const at = {};
    header.forEach((h, i) => {
      const w = txt(h, 80);
      for (const k of Object.keys(COLS)) {
        if (at[k] != null) continue;
        if (k === 'memo' && at.desc === i) continue;
        if (COLS[k].test(w) && !(k === 'credit' && /card/i.test(w)) && !(k === 'desc' && /date/i.test(w))) { at[k] = i; break; }
      }
    });
    return at;
  }
  function parseAmount(v) {
    let s = txt(v, 40);
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/\bDR\b/i.test(s)) neg = true;
    s = s.replace(/\b(CR|DR)\b/gi, '').replace(/[^\d.,\-]/g, '');
    if (s.indexOf('-') !== -1) { neg = !neg; s = s.replace(/-/g, ''); }
    // 1.234,56 (Europe) vs 1,234.56
    if (/,\d{2}$/.test(s) && s.indexOf('.') < s.lastIndexOf(',')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    const n = Number(s);
    if (!s || !Number.isFinite(n)) return null;
    return neg ? -n : n;
  }
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  // seconds since 1970 at local noon (so a time zone never moves it a day), or 0
  function parseDate(v) {
    const s = txt(v, 40);
    let y, m, d, x;
    if ((x = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) { y = +x[1]; m = +x[2] - 1; d = +x[3]; }
    else if ((x = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s))) {
      y = +x[3]; if (y < 100) y += 2000;
      m = +x[1] - 1; d = +x[2];
      if (m > 11) { m = +x[2] - 1; d = +x[1]; } // 25/03/2026: day first
    } else if ((x = /^(\d{1,2})[\s-]([a-z]{3})[a-z]*[\s-,]+(\d{2,4})/i.exec(s)) && MONTHS[x[2].toLowerCase()] != null) {
      d = +x[1]; m = MONTHS[x[2].toLowerCase()]; y = +x[3]; if (y < 100) y += 2000;
    } else if ((x = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(s)) && MONTHS[x[1].toLowerCase()] != null) {
      m = MONTHS[x[1].toLowerCase()]; d = +x[2]; y = +x[3];
    } else return 0;
    const t = new Date(y, m, d, 12);
    if (t.getMonth() !== m || y < 1990 || y > 2100) return 0;
    return Math.floor(t.getTime() / 1000);
  }
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

  /* rows → transactions. The header is the first row (of the first 15) that names a date and an amount.
     Charges should come out negative; a file with one Amount column that's mostly positive is a card that
     lists charges as positive, so it's flipped (flipped: true says so, and `flip` turns that around). */
  function readCsv(text, opts) {
    opts = opts || {};
    const rows = splitCsv(text);
    let hi = -1, at = null;
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const c = findColumns(rows[i]);
      if (c.date != null && (c.amount != null || c.debit != null || c.credit != null)) { hi = i; at = c; break; }
    }
    if (hi < 0) return { ok: false, error: 'Couldn’t find the Date and Amount columns in that file. Is it the CSV download from your bank (not a PDF statement)?' };
    const out = [], seen = {}, balances = [];
    let pos = 0, cnt = 0;
    for (const r of rows.slice(hi + 1)) {
      const posted = parseDate(r[at.date]);
      if (!posted) continue;
      let amount;
      if (at.amount != null) amount = parseAmount(r[at.amount]);
      else {
        const dr = parseAmount(r[at.debit]), cr = parseAmount(r[at.credit]);
        if (dr == null && cr == null) amount = null;
        else amount = Math.abs(cr || 0) - Math.abs(dr || 0);
      }
      if (amount == null) continue;
      const description = txt(r[at.desc], 200) || '(no description)';
      const memo = at.memo != null ? txt(r[at.memo], 300) : '';
      const t = { posted, amount, description, pending: false };
      if (memo && memo.toLowerCase() !== description.toLowerCase()) t.memo = memo;
      // the same line twice in one file is two real charges (two coffees): the count keeps their ids apart
      const base = posted + '|' + Math.round(amount * 100) + '|' + description.toLowerCase();
      seen[base] = (seen[base] || 0) + 1;
      t.id = 'csv-' + hash(base) + '-' + seen[base];
      if (at.balance != null) { const b = parseAmount(r[at.balance]); if (b != null) balances.push({ posted, b }); }
      out.push(t); cnt++; if (amount > 0) pos++;
    }
    if (!out.length) return { ok: false, error: 'That file has a header but no rows with a date and an amount.' };
    let flipped = at.amount != null && cnt >= 5 && pos / cnt > 0.7;
    if (opts.flip) flipped = !flipped;
    if (flipped) out.forEach((t) => { t.amount = -t.amount; t.id += 'f'; });
    out.sort((a, b) => b.posted - a.posted);
    // the newest row's balance (banks list either way round, so by date; same day → the file's first row)
    let balance = null;
    if (balances.length) balance = balances.slice().sort((a, b) => b.posted - a.posted)[0].b;
    return { ok: true, transactions: out, flipped, balance, from: out[out.length - 1].posted, to: out[0].posted };
  }

  // adding a file's rows to an account: ids already there are kept as they were
  function addTo(account, txs) {
    const have = new Set(account.transactions.map((t) => t.id));
    let added = 0;
    txs.forEach((t) => { if (!have.has(t.id)) { account.transactions.push(t); added++; } });
    account.transactions.sort((a, b) => b.posted - a.posted);
    return added;
  }

  const api = { splitCsv, readCsv, parseAmount, parseDate, addTo };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  if (typeof window === 'undefined' || !window.crypto || !window.crypto.subtle) return;

  /* ── kept in this browser, encrypted ── */
  const enc = new TextEncoder(), dec = new TextDecoder();
  const AAD = enc.encode('tasks-finance-csv-v1');
  const b64 = (bytes) => { let s = ''; bytes = new Uint8Array(bytes); for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); };
  const unb64 = (s) => { const bin = atob(s); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; };
  const readBox = () => { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { return null; } };

  let key = null, salt = null, vault = null, idleTimer = null;
  const lockedCbs = [];
  async function deriveKey(pass, s) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: s, iterations: ROUNDS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function save() {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, enc.encode(JSON.stringify(vault)));
    try { localStorage.setItem(STORE, JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), data: b64(data) })); }
    catch (e) { throw new Error('This browser is out of room for Finance’s data.'); }
  }
  function lock(why) {
    const was = !!key;
    key = null; vault = null; salt = null; clearTimeout(idleTimer); idleTimer = null;
    if (was) lockedCbs.forEach((cb) => { try { cb(why || 'asked'); } catch (e) {} });
  }
  function stillHere() { clearTimeout(idleTimer); idleTimer = setTimeout(() => lock('idle'), IDLE_LOCK_MS); }
  const lastAdded = () => (vault.accounts || []).reduce((m, a) => Math.max(m, a.addedAt || 0), 0);

  window.csvFinance = {
    csv: true,
    financeStatus: async function () {
      return { setUp: !!readBox(), unlocked: !!key, fetchedAt: vault ? lastAdded() : 0, waitSeconds: 0, minPassphrase: MIN_PASS, csv: true };
    },
    // the first file and the passphrase together
    financeSetup: async function (pass, file) {
      if (String(pass || '').length < MIN_PASS) return { ok: false, error: 'Use at least ' + MIN_PASS + ' characters for the passphrase.' };
      salt = crypto.getRandomValues(new Uint8Array(16));
      key = await deriveKey(pass, salt);
      vault = { accounts: [], kinds: {} };
      if (file) {
        const r = await window.csvFinance.financeImport(file);
        if (!r.ok) { lock(); return r; }
        return r;
      }
      await save(); stillHere();
      return { ok: true };
    },
    financeUnlock: async function (pass) {
      if (key) { stillHere(); return { ok: true }; }
      const box = readBox();
      if (!box) return { ok: false, error: 'Nothing is saved in this browser yet.' };
      try {
        const s = unb64(box.salt), k = await deriveKey(String(pass || ''), s);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv), additionalData: AAD }, k, unb64(box.data));
        vault = JSON.parse(dec.decode(plain)); key = k; salt = s;
      } catch (e) { return { ok: false, error: 'That passphrase didn’t open it.' }; }
      stillHere();
      return { ok: true };
    },
    financeLock: async function () { lock('asked'); return true; },
    financeData: async function () {
      if (!key) return { locked: true };
      stillHere();
      return { locked: false, csv: true, fetchedAt: lastAdded(), accounts: vault.accounts || [], errors: [], kinds: vault.kinds || {}, receipts: [], mail: null };
    },
    // file: { name, text, account (name to add it to), balance (typed, optional), flip }
    financeImport: async function (file) {
      if (!key) return { ok: false, error: 'locked' };
      stillHere();
      const r = readCsv(file.text, { flip: file.flip });
      if (!r.ok) return r;
      const name = txt(file.account, 120) || txt(String(file.name || '').replace(/\.[^.]*$/, ''), 120) || 'Account';
      let a = vault.accounts.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!a) { a = { id: 'csv-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, org: 'From CSV', currency: 'USD', balance: 0, available: null, balanceDate: 0, transactions: [], holdings: [] }; vault.accounts.push(a); }
      const added = addTo(a, r.transactions);
      const typed = file.balance != null && String(file.balance).trim() !== '' ? parseAmount(file.balance) : null;
      if (typed != null) { a.balance = typed; a.balanceDate = Math.floor(Date.now() / 1000); }
      else if (r.balance != null && r.to >= (a.balanceDate || 0)) { a.balance = r.balance; a.balanceDate = r.to; }
      a.addedAt = Date.now();
      await save();
      return { ok: true, account: a.name, added, total: r.transactions.length, flipped: r.flipped, from: r.from, to: r.to, hasBalance: !!a.balanceDate };
    },
    financeSetBalance: async function (id, value) {
      if (!key) return { ok: false, error: 'locked' };
      const a = vault.accounts.find((x) => x.id === id), n = parseAmount(value);
      if (!a || n == null) return { ok: false, error: 'That isn’t an amount.' };
      a.balance = n; a.balanceDate = Math.floor(Date.now() / 1000); await save(); return { ok: true };
    },
    financeRemoveAccount: async function (id) {
      if (!key) return { ok: false, error: 'locked' };
      vault.accounts = vault.accounts.filter((x) => x.id !== id); await save(); return { ok: true };
    },
    financeSetKind: async function (payee, kind) {
      if (!key) return { ok: false, error: 'locked' };
      stillHere();
      const k = String(payee || '').slice(0, 80).trim();
      if (!k || (kind != null && ['fixed', 'variable', 'skip', 'income'].indexOf(kind) === -1)) return { ok: false, error: 'bad kind' };
      const kinds = Object.assign({}, vault.kinds);
      if (kind == null) delete kinds[k]; else kinds[k] = kind;
      vault.kinds = kinds; await save();
      return { ok: true, kinds };
    },
    financeStocks: async function () { return key ? { held: 0, rows: [] } : { locked: true }; },
    financeForget: async function () { lock('forgotten'); try { localStorage.removeItem(STORE); } catch (e) {} return { ok: true }; },
    onFinanceLocked: function (cb) { lockedCbs.push(cb); },
  };
})();
