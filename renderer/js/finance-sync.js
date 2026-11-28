/* Finance the same on every device: the part of the Finance vault that should match everywhere (the downloaded
   accounts and their history, his fixed/variable marks, the EBT settings, the purchases read from email), merged
   between devices through the <personal key>:finance sync row.
   It leaves a device only sealed: gzipped, then AES-256-GCM (its own AAD) under the key his Finance passphrase
   makes for the shared SimpleFIN link (main/finance.js shareBox, finance-share.js). The sync server, a paired
   device without the passphrase and the Claude connector see ciphertext only, and no cloud AI is ever handed it.
   Each device keeps its whole own copy, so a lost or overwritten row costs nothing: the next device to unlock
   puts its copy back and the others merge it in.
   The computer runs this in its main process (main/finance.js finance:sync), the phone in its page
   (mobile/finance-phone.js financeSync). One of the page scripts in renderer/js (as window.FinSync, so its names
   don't clash with the others'); the page's own part is at the bottom. Also loaded by the tests. */
(function () {
  'use strict';
  const KEEP_DAYS = 400; // finance-core.js KEEP_DAYS
  const MAX_RECEIPTS = 1500; // main/finance.js lookAtMail
  const FIN_SYNC_AAD = 'tasks-finance-data-v1';
  const MAX_SEALED = 6 * 1024 * 1024; // the row itself is refused past 4 MB (supabase/setup.sql sync_set)
  const KIND_NAMES = ['fixed', 'variable', 'skip', 'income'];

  // base64 of a few hundred kilobytes, a slice at a time (one String.fromCharCode call can't take that many)
  const U = {
    bytesToB64: function (bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); },
    b64ToBytes: function (s) { const bin = atob(String(s)); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; },
  };
  const obj = function (x) { return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; };
  const arr = function (x) { return Array.isArray(x) ? x : []; };
  // JSON with every object's keys sorted, so two copies of the same thing always read the same
  function stable(v) {
    return JSON.stringify(v, function (k, x) {
      if (!x || typeof x !== 'object' || Array.isArray(x)) return x;
      const o = {}; Object.keys(x).sort().forEach(function (key) { o[key] = x[key]; }); return o;
    });
  }
  const byId = function (x, y) { return x.id < y.id ? -1 : x.id > y.id ? 1 : 0; };
  // newest first, pending (no date yet) on top: finance-core.js mergeAccounts, with the id settling a tie
  const byPosted = function (x, y) { return ((y.posted || Infinity) - (x.posted || Infinity)) || byId(x, y); };
  const byAt = function (x, y) { return (y.at - x.at) || byId(x, y); };

  // the part of a vault that is the same on every device (never the link, the Windows Hello choice or what mail was seen)
  function pick(vault) {
    const c = obj(vault && vault.cache);
    return tidy({ fetchedAt: c.fetchedAt, accounts: c.accounts, errors: c.errors, kinds: vault.kinds, kindsAt: vault.kindsAt,
      ebt: vault.ebt, ebtAt: vault.ebtAt, receipts: vault.receipts });
  }
  function tidy(s) {
    s = obj(s);
    return { v: 1, fetchedAt: Number(s.fetchedAt) || 0,
      accounts: arr(s.accounts).filter(function (a) { return a && a.id; }),
      errors: arr(s.errors), kinds: obj(s.kinds), kindsAt: obj(s.kindsAt), ebt: obj(s.ebt), ebtAt: Number(s.ebtAt) || 0,
      receipts: arr(s.receipts).filter(function (r) { return r && r.id; }) };
  }
  function put(vault, s) {
    vault.cache = { fetchedAt: s.fetchedAt, accounts: s.accounts, errors: s.errors };
    vault.kinds = s.kinds; vault.kindsAt = s.kindsAt; vault.ebt = s.ebt; vault.ebtAt = s.ebtAt; vault.receipts = s.receipts;
  }
  // for comparing: the same content in the same order, whatever order a device happened to keep it in
  function canon(s) {
    return stable(Object.assign({}, s, {
      accounts: s.accounts.map(function (a) { return Object.assign({}, a, { transactions: arr(a.transactions).slice().sort(byPosted) }); }),
      receipts: s.receipts.slice().sort(byAt) }));
  }

  /* Two copies → one, the same whichever device does it.
     Accounts: the later download decides which accounts there are, their balances and holdings, as a refresh
     does; the other copy adds the settled transactions it alone still has (history past SimpleFIN's 90 days).
     A later download with no accounts at all (a bad day at the bank) never empties the history. */
  function merge(a, b, now) {
    a = tidy(a); b = tidy(b);
    let n = a, o = b;
    if (b.fetchedAt > a.fetchedAt || (b.fetchedAt === a.fetchedAt && stable(b.accounts) > stable(a.accounts))) { n = b; o = a; }
    const cutoff = now / 1000 - KEEP_DAYS * 86400;
    const lead = n.accounts.length || !o.accounts.length ? n : o, rest = lead === n ? o : n;
    const before = {};
    rest.accounts.forEach(function (x) { before[x.id] = x; });
    const accounts = lead.accounts.map(function (acct) {
      const own = arr(acct.transactions);
      const seen = new Set(own.map(function (t) { return t.id; }));
      const kept = arr((before[acct.id] || {}).transactions).filter(function (t) { return t && !seen.has(t.id) && !t.pending && t.posted >= cutoff; });
      return Object.assign({}, acct, { transactions: own.concat(kept).sort(byPosted) });
    });
    const k = mergeKinds(a, b), e = mergeEbt(a, b);
    const cutMs = now - KEEP_DAYS * 86400000, by = {};
    o.receipts.concat(n.receipts).forEach(function (r) { if (r.at >= cutMs) by[r.id] = r; });
    return { v: 1, fetchedAt: n.fetchedAt, accounts: accounts, errors: n.errors, kinds: k.kinds, kindsAt: k.at, ebt: e.ebt, ebtAt: e.at,
      receipts: Object.keys(by).map(function (id) { return by[id]; }).sort(byAt).slice(0, MAX_RECEIPTS) };
  }
  /* his fixed/variable/income marks, payee by payee: the later change wins, and taking a mark off is a change too
     (a time with no mark). Marks from before the times were kept are simply added together. */
  function mergeKinds(a, b) {
    const kinds = {}, at = {}, keys = {};
    [a.kinds, a.kindsAt, b.kinds, b.kindsAt].forEach(function (m) { Object.keys(m).forEach(function (k) { keys[k] = 1; }); });
    const val = function (s, k) { return KIND_NAMES.indexOf(s.kinds[k]) !== -1 ? s.kinds[k] : null; };
    Object.keys(keys).forEach(function (k) {
      const ta = Number(a.kindsAt[k]) || 0, tb = Number(b.kindsAt[k]) || 0, va = val(a, k), vb = val(b, k);
      const v = ta !== tb ? (ta > tb ? va : vb) : va == null ? vb : vb == null ? va : (va < vb ? va : vb);
      if (v != null) kinds[k] = v;
      if (ta || tb) at[k] = Math.max(ta, tb);
    });
    return { kinds: kinds, at: at };
  }
  // the EBT settings as one piece: the later save wins; from before saves were timed, the later balance
  function mergeEbt(a, b) {
    let first = true;
    if (a.ebtAt !== b.ebtAt) first = a.ebtAt > b.ebtAt;
    else {
      const ra = Number(a.ebt.at) || 0, rb = Number(b.ebt.at) || 0, ka = Object.keys(a.ebt).length, kb = Object.keys(b.ebt).length;
      first = ra !== rb ? ra > rb : ka !== kb ? ka > kb : stable(a.ebt) <= stable(b.ebt);
    }
    return first ? { ebt: a.ebt, at: a.ebtAt } : { ebt: b.ebt, at: b.ebtAt };
  }
  /* one round on a device: its vault and the copy that came down (or null) → {changed: the vault was brought up
     to date, push: the row is missing something this device has, state: what to seal and send} */
  function step(vault, theirs, now) {
    const mine = pick(vault);
    const merged = theirs ? merge(mine, theirs, now) : mine;
    const out = canon(merged);
    const changed = out !== canon(mine);
    if (changed) put(vault, merged);
    return { changed: changed, push: !theirs || out !== canon(tidy(theirs)), state: merged };
  }

  /* ── sealing ── */
  const subtle = function () { return globalThis.crypto.subtle; };
  async function through(bytes, stream) {
    const w = stream.writable.getWriter();
    w.write(bytes).catch(function () {}); w.close().catch(function () {});
    const r = stream.readable.getReader(), parts = [];
    let n = 0;
    for (;;) { const x = await r.read(); if (x.done) break; parts.push(x.value); n += x.value.length; }
    const out = new Uint8Array(n);
    let at = 0;
    parts.forEach(function (p) { out.set(p, at); at += p.length; });
    return out;
  }
  async function aes(raw) { return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); }
  // state → {v, z, iv, data} for the row; z: 1 when it was gzipped first (a year of transactions shrinks about tenfold)
  async function seal(keyBytes, state) {
    let plain = new TextEncoder().encode(JSON.stringify(state)), z = 0;
    if (typeof CompressionStream === 'function') { plain = await through(plain, new CompressionStream('gzip')); z = 1; }
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const data = await subtle().encrypt({ name: 'AES-GCM', iv: iv, additionalData: new TextEncoder().encode(FIN_SYNC_AAD) }, await aes(keyBytes), plain);
    return { v: 1, z: z, iv: U.bytesToB64(iv), data: U.bytesToB64(new Uint8Array(data)) };
  }
  const okSealed = function (b) { return !!(b && b.v === 1 && typeof b.iv === 'string' && typeof b.data === 'string' && b.data.length && b.data.length <= MAX_SEALED); };
  /* what came down → the state inside, or null when this key doesn't open it (sealed under a passphrase since
     replaced: this device's copy takes its place). Throws only when this device can't unpack it at all. */
  async function read(keyBytes, box) {
    if (!okSealed(box)) return null;
    let plain;
    try { plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: U.b64ToBytes(box.iv), additionalData: new TextEncoder().encode(FIN_SYNC_AAD) }, await aes(keyBytes), U.b64ToBytes(box.data))); }
    catch (e) { return null; }
    if (box.z) {
      if (typeof DecompressionStream !== 'function') throw new Error('This device can’t unpack the shared Finance copy.');
      plain = await through(plain, new DecompressionStream('gzip'));
    }
    try { return tidy(JSON.parse(new TextDecoder().decode(plain))); } catch (e) { return null; }
  }
  // the shared link's box in the row is the one this device holds the key to
  function sameBox(x, y) {
    return !!(x && y && ['salt', 'iv', 'tag', 'data'].every(function (f) { return typeof x[f] === 'string' && x[f] === y[f]; }));
  }

  const FinSync = { pick: pick, merge: merge, step: step, seal: seal, read: read, sameBox: sameBox, canon: canon };
  if (typeof module !== 'undefined' && module.exports) module.exports = FinSync;
  else window.FinSync = FinSync;
})();

/* ── the page's part (finance.js finShareUp calls it once the shared link is settled) ──
   row: the :finance row as it came down, {doc: {v, box, data}}. The device merges what's there into its vault and
   hands back a new sealed copy when the row is missing something. A device that never had the passphrase the row
   is locked with says so (needKey), and the tab asks for it once (finSyncKeyFold). */
async function finSyncData(p,row){
  if(!finNative.financeSync||!row.doc||!row.doc.box)return;
  const r=await finNative.financeSync(row.doc.box,row.doc.data||null);
  if(!r||!r.ok){ if(r&&r.needKey)finSyncNeed(row.doc.box); return; }
  finSyncNeed(null);
  if(r.box)await syncPushDoc(p,{v:1,box:row.doc.box,data:r.box});
  if(r.changed&&finApi===finNative&&state.activeTab==='finance'&&fin.data&&!fin.busy)renderFinance();
}
function finSyncNeed(box){
  if(stableJson(fin.syncNeed||null)===stableJson(box||null))return;
  fin.syncNeed=box||null;
  if(finApi===finNative&&state.activeTab==='finance'&&fin.data&&!fin.busy)renderFinance();
}
// after a change here (a refresh, a mark, the EBT balance, new purchase emails): up it goes, once things settle
let finSyncTimer=null, finSyncLast=0;
function finSyncSoon(ms){
  clearTimeout(finSyncTimer);
  finSyncTimer=setTimeout(function(){ finSyncLast=Date.now(); finShareUp(); },ms==null?2000:ms);
}
// the tab on screen and unlocked: the other devices' changes are looked for, at most once a minute
function finSyncLook(){ if(finApi===finNative&&Date.now()-finSyncLast>60000){ finSyncLast=Date.now(); finSyncSoon(500); } }
/* this device has Finance, but not the passphrase the shared copy is locked with (a phone paired with a code, or
   a computer connected under a passphrase of its own): typed once, it is kept inside this device's vault */
function finSyncKeyFold(){
  const box=el('div','fin-card fin-setup');
  box.appendChild(el('h3',null,'Keep Finance the same on all your devices'));
  box.appendChild(el('p','fin-note',(finApi.phone?'This phone':'This computer')+' has your accounts, but not the history, bills, fixed and variable marks and EBT balance from your other devices. Type the Finance passphrase from your other '+(finApi.phone?'computer':'device')+' once and they stay the same everywhere. It is all locked with that passphrase before it leaves a device, so nobody else can read it, the sync server included.'+(finApi.phone?' Checking the passphrase can take up to half a minute.':'')));
  const pass=finInput('password','Finance passphrase from your other device');
  const go=el('button','btn-accent',fin.busy?'Checking…':'Keep them the same'); go.disabled=fin.busy;
  const take=async function(){
    if(!pass.value||fin.busy)return;
    fin.busy=true; go.disabled=true; go.textContent='Checking…';
    const r=await finNative.financeAdoptShare(fin.syncNeed,pass.value).catch(function(e){ return {ok:false,error:e.message}; });
    pass.value=''; fin.busy=false;
    if(!r.ok){ finSay(r.error,true); return renderFinance(); }
    fin.syncNeed=null; finSay('Done. This device now keeps Finance in step with your others.'); renderFinance(); finSyncSoon(0);
  };
  pass.addEventListener('keydown',function(e){ if(e.key==='Enter')take(); });
  go.addEventListener('click',take);
  const row=el('div','fin-row'); row.appendChild(pass); row.appendChild(go); box.appendChild(row);
  // a computer can make its own passphrase the shared one instead (the other device's is lost, or that device is gone)
  if(!finApi.phone){
    const mine=el('button','ghost mono','use this computer’s passphrase for all devices instead');
    mine.addEventListener('click',async function(){
      if(fin.busy)return;
      fin.busy=true; mine.disabled=true;
      try{ const p=finShareProfile(), r=p&&await finNative.financeShareBox(); if(r&&r.ok)await syncPushDoc(p,{v:1,box:r.box}); }catch(e){}
      fin.busy=false; fin.syncNeed=null;
      finSay('Done. Your other devices will ask for this computer’s Finance passphrase once.'); renderFinance(); finSyncSoon(0);
    });
    box.appendChild(mine);
  }
  return box;
}
