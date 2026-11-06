/* Pairing codes: Settings → Device sync → "Add a device" shows a code like K7QM-4XR9-PB2T for 10 minutes;
   typing it on the new device fills in and saves the whole sync form there. Nothing to copy between machines.
   The code is 12 characters from Crockford's base32 (60 random bits; no I, L, O or U, so it reads aloud and
   types cleanly). Both devices stretch it with PBKDF2-SHA256 (600,000 rounds) into 64 bytes: the first half
   is the lookup id the server stores the code under, the second the AES-256-GCM key that seals the sync code.
   The code itself never leaves the device, and the server holds only the id and ciphertext, so even its
   operator has to pay the stretching for every guess, within the 10 minutes before the code is gone.
   Server side: supabase/migrations/20261101_sync_pairing.sql (one use, rate limits, a watch token so only
   the device that made the code can see it was taken or withdraw it).
   Where codes meet: the official release's project (window.ROMULUS_PAIR, written by the release build into
   pair-server.js), else this device's own sync project. Loaded after settings.js (syncCodeNow, fillFromSyncCode). */
'use strict';

const PAIR_ALPHABET='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAIR_LEN=12, PAIR_ROUNDS=600000, PAIR_SALT='romulus-pair-v1', PAIR_TTL_MS=10*60*1000;
function pairNewCode(){
  const b=crypto.getRandomValues(new Uint8Array(PAIR_LEN));
  return Array.from(b,function(x){ return PAIR_ALPHABET[x&31]; }).join(''); // 256 is a multiple of 32: no bias
}
function pairFormat(code){ return code.match(/.{1,4}/g).join('-'); }
// what he typed → the 12 characters, or null. Lowercase, spaces and dashes are fine; O reads as 0, I and L as 1.
function pairNormalize(text){
  const s=String(text||'').toUpperCase().replace(/[\s-]+/g,'').replace(/O/g,'0').replace(/[IL]/g,'1');
  if(s.length!==PAIR_LEN)return null;
  for(const ch of s)if(PAIR_ALPHABET.indexOf(ch)<0)return null;
  return s;
}
function pairHex(bytes){ return Array.from(bytes,function(b){ return b.toString(16).padStart(2,'0'); }).join(''); }
async function pairDerive(code){
  const enc=new TextEncoder();
  const base=await crypto.subtle.importKey('raw',enc.encode(code),'PBKDF2',false,['deriveBits']);
  const bits=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:enc.encode(PAIR_SALT),iterations:PAIR_ROUNDS},base,512));
  const key=await crypto.subtle.importKey('raw',bits.slice(32),{name:'AES-GCM'},false,['encrypt','decrypt']);
  return {id:pairHex(bits.slice(0,32)),key:key};
}
function pairB64(bytes){ let s=''; bytes.forEach(function(b){ s+=String.fromCharCode(b); }); return btoa(s); }
async function pairSeal(key,text){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:iv},key,new TextEncoder().encode(text)));
  const out=new Uint8Array(iv.length+ct.length); out.set(iv); out.set(ct,iv.length);
  return pairB64(out);
}
// null when it doesn't open (a wrong key or a changed byte)
async function pairOpen(key,sealed){
  try{
    const b=Uint8Array.from(atob(sealed),function(c){ return c.charCodeAt(0); });
    return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:b.slice(0,12)},key,b.slice(12)));
  }catch(e){ return null; }
}
// {url, key} of the project codes meet in, or null
function pairServer(ownUrl,ownKey){
  const p=typeof window!=='undefined'&&window.ROMULUS_PAIR;
  if(p&&p.url&&p.key)return {url:p.url,key:p.key};
  return ownUrl&&ownKey?{url:ownUrl,key:ownKey}:null;
}
async function pairRpc(server,fn,body){
  const res=await fetch(server.url.replace(/\/+$/,'')+'/rest/v1/rpc/'+fn,{method:'POST',
    headers:{'apikey':server.key,'Authorization':'Bearer '+server.key,'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!res.ok)throw new Error(res.status===404?'this sync project has no pairing codes yet':'HTTP '+res.status);
  return res.json();
}

if(typeof document!=='undefined'&&document.getElementById('pairAddBtn')){
  const addBtn=$('pairAddBtn'), box=$('pairBox'), codeEl=$('pairCode'), infoEl=$('pairInfo');
  let live=null; // {server, id, watch, timer, until}
  const server=function(){ return pairServer($('syncUrl').value.trim(),$('syncAnonKey').value.trim()); };
  const stop=function(withdraw){
    if(!live)return;
    clearInterval(live.timer);
    if(withdraw)pairRpc(live.server,'sync_pair_cancel',{p_id:live.id,p_watch:live.watch}).catch(function(){});
    live=null; box.hidden=true; codeEl.textContent=''; addBtn.textContent='Add a device';
  };
  const tick=async function(){
    if(!live)return;
    const left=live.until-Date.now();
    if(left<=0){ stop(true); setSyncStatus('that code ran out: press Add a device for a new one',true); return; }
    infoEl.textContent='Type it on the new device in Settings → Device sync. Works once, for '+Math.ceil(left/60000)+' more min.';
    const st=await pairRpc(live.server,'sync_pair_state',{p_id:live.id,p_watch:live.watch}).catch(function(){ return null; });
    if(!live)return;
    if(st==='taken'){ stop(false); setSyncStatus('paired: the other device has your sync settings now. If that wasn’t you, generate a new sync key.'); }
    else if(st==='gone'||st==='expired'){ stop(false); setSyncStatus('that code is gone: press Add a device for a new one',true); }
  };
  addBtn.addEventListener('click',async function(){
    if(live){ stop(true); return; }
    const sc=syncCodeNow(); if(!sc){ if(typeof syncShowFirstSteps==='function')syncShowFirstSteps(); setSyncStatus('nothing syncs here yet: set this device up first with the steps below',true); return; }
    const srv=server(); if(!srv){ setSyncStatus('fill in the project URL and key first',true); return; }
    addBtn.disabled=true; setSyncStatus('making a code…');
    try{
      const code=pairNewCode(), d=await pairDerive(code);
      const watch=pairHex(crypto.getRandomValues(new Uint8Array(32)));
      const why=await pairRpc(srv,'sync_pair_put',{p_id:d.id,p_sealed:await pairSeal(d.key,sc),p_watch:watch});
      if(why){ setSyncStatus(why==='rate'?'too many codes from this network: try again in an hour':why==='busy'?'pairing is busy right now: try again in a few minutes':'couldn’t make a code',true); return; }
      live={server:srv,id:d.id,watch:watch,until:Date.now()+PAIR_TTL_MS,timer:setInterval(tick,4000)};
      codeEl.textContent=pairFormat(code); box.hidden=false; addBtn.textContent='Hide the code';
      setSyncStatus('anyone who types this code in the next 10 minutes gets your lists: only type it on your own device');
      tick();
    }catch(e){ setSyncStatus('couldn’t make a code: '+e.message,true); }
    finally{ addBtn.disabled=false; }
  });
  $('syncSection').addEventListener('toggle',function(){ if(!this.open)stop(true); });
  const useBtn=$('pairUseBtn'), input=$('pairCodeIn');
  const use=async function(){
    const code=pairNormalize(input.value);
    if(!code){ setSyncStatus('a pairing code is 12 letters and numbers, like K7QM-4XR9-PB2T',true); return; }
    const srv=server(); if(!srv){ setSyncStatus('this build has no pairing server: use Copy sync code on the other device instead',true); return; }
    useBtn.disabled=true; setSyncStatus('pairing…');
    try{
      const d=await pairDerive(code);
      const r=(await pairRpc(srv,'sync_pair_take',{p_id:d.id}))[0];
      if(r&&r.refused==='rate'){ setSyncStatus('too many tries from this network: wait an hour, then try again',true); return; }
      const text=r&&r.sealed?await pairOpen(d.key,r.sealed):null;
      if(!text||text.indexOf(SYNC_CODE_PREFIX)!==0){ setSyncStatus('that code didn’t work: it may be mistyped, used or run out. Make a new one on the other device.',true); return; }
      input.value='';
      // say whose project this is before adopting it: a code someone else talked him into typing would otherwise
      // move his lists into their project without a word
      let host=''; try{ host=new URL(JSON.parse(atob(text.slice(SYNC_CODE_PREFIX.length))).url).host; }catch(e){}
      if(!host){ setSyncStatus('that code didn’t hold a sync project address',true); return; }
      if(!confirm('Use the sync project at '+host+'?\n\nYour lists will be kept there from now on. Only continue if this is your own project (or one you were given on purpose).')){ setSyncStatus('not paired'); return; }
      if(fillFromSyncCode(text)){ setSyncStatus('paired: saving…'); $('syncSaveBtn').click(); }
    }catch(e){ setSyncStatus('couldn’t pair: '+e.message,true); }
    finally{ useBtn.disabled=false; }
  };
  useBtn.addEventListener('click',use);
  input.addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); use(); } });
}

if(typeof module!=='undefined')module.exports={pairNewCode,pairFormat,pairNormalize,pairDerive,pairSeal,pairOpen,pairServer,PAIR_ALPHABET,PAIR_LEN};
