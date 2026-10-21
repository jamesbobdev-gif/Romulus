/* Finance on the phone: the same Finance tab as the desktop, backed by the FinanceVault plugin
   (FinanceVaultPlugin.java) instead of the desktop's main process. prepare-www.js puts this in
   www/index.html ahead of the app, as window.phoneFinance with the desktop bridge's finance* calls.

   Pairing: the computer's Finance tab shows a QR code (main/finance.js finance:pairCode) with the SimpleFIN
   link and his fixed/variable corrections; this phone scans it, then downloads from SimpleFIN and Yahoo
   Finance itself (the shared code in renderer/js/finance-core.js, through the plugin's http call).
   Locking: everything is kept encrypted (AES-GCM) under a random key that the plugin hands out only after
   his fingerprint. The key lives in memory while Finance is open and is dropped when he leaves the app,
   after 30 minutes without use, or when he taps lock. Purchase emails stay on the computer. */
(function () {
  var cap = window.Capacitor;
  if (!cap || typeof cap.nativePromise !== 'function' || !cap.isPluginAvailable || !cap.isPluginAvailable('FinanceVault')) return;
  var call = function (method, opts) { return cap.nativePromise('FinanceVault', method, opts || {}); };
  var core = function () { return window.FinCore; };

  var IDLE_LOCK_MS = 30 * 60 * 1000;
  var MIN_REFRESH_MS = 15 * 60 * 1000; // SimpleFIN allows a couple dozen refreshes a day (shared with the computer)
  var STALE_MS = 6 * 60 * 60 * 1000;
  var QUOTE_MS = 55 * 1000, DAILY_MS = 3 * 60 * 60 * 1000;
  var PREFIX = 'tasks-finance:1:';
  var AAD = new TextEncoder().encode('tasks-finance-phone-v1');

  var key = null, vault = null, idleTimer = null, native = false;
  var lastQuotes = null, lastDaily = null;
  var lockedCbs = [], updatedCbs = [];

  var b64 = function (bytes) { var s = ''; bytes = new Uint8Array(bytes); for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); };
  var unb64 = function (s) { var bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)); var out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

  // fetch's shape over the plugin (SimpleFIN and Yahoo only; the page itself can't reach them)
  async function doFetch(url, opts) {
    var r = await call('http', { url: url, headers: (opts && opts.headers) || {} });
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async function () { return JSON.parse(r.body); }, text: async function () { return r.body; } };
  }
  async function useKey(raw) { return crypto.subtle.importKey('raw', unb64(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); }
  async function save() {
    if (!key || !vault) return;
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: AAD }, key, new TextEncoder().encode(JSON.stringify(vault)));
    await call('write', { data: JSON.stringify({ v: 1, iv: b64(iv), data: b64(data) }) });
  }
  async function open(k) {
    var r = await call('read');
    if (!r.data) throw new Error('Finance’s data is missing on this phone. Forget it and pair again.');
    var box = JSON.parse(r.data);
    var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv), additionalData: AAD }, k, unb64(box.data));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  function lock(why) {
    var was = !!key;
    key = null; vault = null; lastQuotes = null; lastDaily = null;
    clearTimeout(idleTimer); idleTimer = null;
    if (was) lockedCbs.forEach(function (cb) { try { cb(why || 'asked'); } catch (e) {} });
  }
  function stillHere() { clearTimeout(idleTimer); idleTimer = setTimeout(function () { lock('idle'); }, IDLE_LOCK_MS); }
  // leaving the app locks it (but not the fingerprint prompt or the scanner, which hide the page for a moment)
  document.addEventListener('visibilitychange', function () { if (document.hidden && !native) lock('away'); });
  async function withNative(p) { native = true; try { return await p; } finally { setTimeout(function () { native = false; }, 1500); } }

  async function refresh(force) {
    var last = (vault.cache && vault.cache.fetchedAt) || 0;
    if (Date.now() - last < MIN_REFRESH_MS) {
      if (force) return { ok: false, error: 'Updated ' + Math.round((Date.now() - last) / 60000) + ' min ago. SimpleFIN allows a refresh every 15 minutes.' };
      return { ok: true, skipped: true };
    }
    var k = key;
    var got = await core().downloadAccounts(vault.accessUrl, doFetch);
    if (key !== k) return { ok: false, error: 'locked' };
    vault.cache = { fetchedAt: Date.now(), accounts: core().mergeAccounts(vault.cache && vault.cache.accounts, got.accounts, Date.now()), errors: got.errors };
    await save();
    return { ok: true };
  }
  // what the computer's QR code holds: the SimpleFIN link and his corrections
  function readPairing(text) {
    var t = String(text || '').trim();
    if (t.indexOf(PREFIX) !== 0) return null;
    var o; try { o = JSON.parse(new TextDecoder().decode(unb64(t.slice(PREFIX.length)))); } catch (e) { return null; }
    var x = o && core().checkSimplefinUrl(o.u);
    if (!x || !x.username || !x.password) return null;
    var kinds = {};
    Object.keys((o.k && typeof o.k === 'object') ? o.k : {}).slice(0, 2000).forEach(function (p) { if (['fixed', 'variable', 'skip', 'income'].indexOf(o.k[p]) !== -1) kinds[String(p).slice(0, 80)] = o.k[p]; });
    return { accessUrl: o.u, kinds: kinds };
  }
  var why = function (e) { return (e && (e.message || e.errorMessage)) || String(e); };

  window.phoneFinance = {
    phone: true,
    financeStatus: async function () {
      var s = await call('isSetUp');
      return { setUp: !!s.setUp, unlocked: !!key, fetchedAt: vault && vault.cache ? vault.cache.fetchedAt || 0 : 0, waitSeconds: 0, minPassphrase: 0, phone: true };
    },
    // scan the computer's code, take his fingerprint, then the first download
    financePair: async function () {
      var a = await call('available');
      if (!a.ok) return { ok: false, error: a.reason };
      var text;
      try { text = (await withNative(call('scan'))).text; }
      catch (e) { return e && e.code === 'CANCELLED' ? { ok: false, cancelled: true } : { ok: false, error: why(e) }; }
      var p = readPairing(text);
      if (!p) return { ok: false, error: 'That isn’t the Finance pairing code. On the computer, open Finance → pair your phone → Show the code.' };
      var raw;
      try { raw = (await withNative(call('create'))).key; }
      catch (e) { return e && e.code === 'CANCELLED' ? { ok: false, cancelled: true } : { ok: false, error: why(e) }; }
      key = await useKey(raw);
      vault = { accessUrl: p.accessUrl, kinds: p.kinds, cache: { fetchedAt: 0, accounts: [], errors: [] } };
      await save();
      stillHere();
      try { await refresh(false); } catch (e) { return { ok: true, warning: why(e) }; }
      return { ok: true };
    },
    financeUnlock: async function () {
      if (key) { stillHere(); return { ok: true }; }
      var raw;
      try { raw = (await withNative(call('unlock'))).key; }
      catch (e) {
        if (e && e.code === 'CANCELLED') return { ok: false, cancelled: true };
        if (e && e.code === 'NOT_VISIBLE') return { ok: false, notVisible: true }; // asked while the app was in the background
        return { ok: false, error: why(e), invalidated: !!(e && e.code === 'INVALIDATED') };
      }
      var k = await useKey(raw);
      try { vault = await open(k); } catch (e) { return { ok: false, error: 'Couldn’t open Finance’s data on this phone. Forget it and pair again.' }; }
      key = k; stillHere();
      var warning;
      if (Date.now() - ((vault.cache && vault.cache.fetchedAt) || 0) > STALE_MS) { try { await refresh(false); } catch (e) { warning = why(e); } }
      return { ok: true, warning: warning };
    },
    financeLock: async function () { lock('asked'); return true; },
    financeScreen: async function (on) { try { await call('secure', { on: !!on }); } catch (e) {} return true; },
    financeData: async function () {
      if (!key) return { locked: true };
      stillHere();
      var c = vault.cache || {};
      return { locked: false, fetchedAt: c.fetchedAt || 0, accounts: c.accounts || [], errors: c.errors || [], kinds: vault.kinds || {},
        receipts: [], mail: { phone: true } };
    },
    financeRefresh: async function () {
      if (!key) return { ok: false, error: 'locked' };
      stillHere();
      try { return await refresh(true); } catch (e) { return { ok: false, error: why(e) }; }
    },
    financeSetKind: async function (payee, kind) {
      if (!key) return { ok: false, error: 'locked' };
      stillHere();
      var k = String(payee || '').slice(0, 80).trim();
      if (!k || (kind != null && ['fixed', 'variable', 'skip', 'income'].indexOf(kind) === -1)) return { ok: false, error: 'bad kind' };
      var kinds = Object.assign({}, vault.kinds);
      if (kind == null) delete kinds[k]; else kinds[k] = kind;
      vault.kinds = kinds;
      await save();
      return { ok: true, kinds: kinds };
    },
    // the tab asks every minute while it's open: that doesn't count as using it
    financeStocks: async function (force) {
      if (!key) return { locked: true };
      if (force) stillHere();
      var C = core(), k = key;
      var held = C.holdingsOf((vault.cache && vault.cache.accounts) || []);
      if (!held.length) return { held: 0, rows: [] };
      var symbols = held.map(function (h) { return h.symbol; }).filter(Boolean), error = null;
      if (force || !lastQuotes || Date.now() - lastQuotes.at >= QUOTE_MS) {
        try { var got = await C.fetchQuotes(symbols, doFetch, '1d'); if (key !== k) return { locked: true }; lastQuotes = { at: Date.now(), quotes: got.quotes, warning: got.warning }; }
        catch (e) { if (key !== k) return { locked: true }; error = why(e); }
      }
      if (!lastDaily || Date.now() - lastDaily.at >= DAILY_MS) {
        try { var d = await C.fetchQuotes(symbols, doFetch, '1y'); if (key !== k) return { locked: true }; lastDaily = { at: Date.now(), quotes: d.quotes }; }
        catch (e) { if (key !== k) return { locked: true }; }
      }
      return C.stocksView(held, lastQuotes && lastQuotes.quotes, lastDaily && lastDaily.quotes, error, lastQuotes && lastQuotes.warning);
    },
    // this phone only: the computer and SimpleFIN keep working
    financeForget: async function () { lock('forgotten'); await call('forget'); return { ok: true }; },
    onFinanceLocked: function (cb) { lockedCbs.push(cb); },
    onFinanceUpdated: function (cb) { updatedCbs.push(cb); },
    _readPairing: readPairing,
  };
})();
