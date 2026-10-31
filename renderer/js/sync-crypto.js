/* End-to-end encrypted sync ("v2"). One page script, loaded before sync.js.
   From a list's sync key the device makes two things, with HKDF-SHA256 (salt 'romulus-sync-v2'):
     - the row's lookup id (info 'lookup'): the only thing the server sees. tk_[list_] + 24 bytes, base64url,
       made from the key without its tk_[list_] prefix, so the lists made from one sync key (tk_<id>,
       tk_agent_<id>, …) keep sharing one id and still count as one account (sync_account_of).
     - the content key (info 'content'), made from the whole key: AES-256-GCM over the whole document.
   Neither can be worked out from the other, so the database, its logs and whoever runs it hold only
   ciphertext under ids that lead nowhere. A row is {e:1, iv, ct} (base64; ct ends with the GCM tag).
   agent/sync-crypto.js does the same with Node's crypto; test/sync-crypto.test.js holds the two together.
   A side row (':ideas', ':prefs', …) is the list's lookup id plus the same suffix, under the list's content key. */
'use strict';

const SYNC_V2_SALT='romulus-sync-v2';
const syncV2Cache=new Map(); // base sync key → Promise<{lookup, key}>
function syncCryptoOk(){ return !!(window.crypto&&crypto.subtle&&crypto.subtle.deriveKey); }
// 'tk_agent_abc:prefs' → {base:'tk_agent_abc', sfx:':prefs'}
function syncSplitKey(k){ const m=/^(.*?)(:[a-z]+)?$/.exec(String(k||'')); return {base:m[1],sfx:m[2]||''}; }
function syncKeyPrefix(base){ const m=/^tk_(?:(?:work|agent|school)_)?/.exec(base); return m?m[0]:'tk_'; }
function syncB64(bytes){ let s=''; bytes.forEach(function(b){ s+=String.fromCharCode(b); }); return btoa(s); }
function syncUnB64(s){ return Uint8Array.from(atob(String(s)),function(c){ return c.charCodeAt(0); }); }
function syncB64Url(bytes){ return syncB64(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function syncV2Keys(base){
  if(!syncV2Cache.has(base))syncV2Cache.set(base,(async function(){
    const enc=new TextEncoder();
    const pre=syncKeyPrefix(base);
    const raw=await crypto.subtle.importKey('raw',enc.encode(base),'HKDF',false,['deriveKey']);
    const rawId=await crypto.subtle.importKey('raw',enc.encode(base.slice(pre.length)),'HKDF',false,['deriveBits']);
    const hk=function(info){ return {name:'HKDF',hash:'SHA-256',salt:enc.encode(SYNC_V2_SALT),info:enc.encode(info)}; };
    const id=new Uint8Array(await crypto.subtle.deriveBits(hk('lookup'),rawId,24*8));
    const key=await crypto.subtle.deriveKey(hk('content'),raw,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    return {lookup:pre+syncB64Url(id),key:key};
  })());
  return syncV2Cache.get(base);
}
// the key the database knows a row by: lookup id + suffix
async function syncV2RowKey(syncKey){ const s=syncSplitKey(syncKey); return (await syncV2Keys(s.base)).lookup+s.sfx; }
function syncIsSealed(doc){ return !!(doc&&doc.e===1&&doc.iv&&doc.ct); }
async function syncSeal(syncKey,doc){
  const k=(await syncV2Keys(syncSplitKey(syncKey).base)).key;
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv:iv},k,new TextEncoder().encode(JSON.stringify(doc)));
  return {e:1,iv:syncB64(iv),ct:syncB64(new Uint8Array(ct))};
}
async function syncOpen(syncKey,env){
  const k=(await syncV2Keys(syncSplitKey(syncKey).base)).key;
  const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:syncUnB64(env.iv)},k,syncUnB64(env.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
