/* The family list: one list the people on a $5 family plan share (groceries, chores, a trip), on its own
   Family tab. It is a fifth list next to Personal, Work, Agent and School (syncState.cfg.family), synced and
   merged like them (sync.js), sealed end-to-end under a random key of its own that no one's personal key
   leads to. Why one Family list and not "share any list": a family plan is one group of people, so one list
   they all see is the whole idea, with tags (#groceries, #chores) to split it; and Personal, Work and School
   stay private by construction, since their keys are made from the personal one.
   How the key gets to the others without the server reading it:
     - "Share a list with my family" makes the key and a 12-character code (Crockford base32, like pairing codes).
       Both sides stretch the code with PBKDF2 (600,000 rounds) into a lookup id and an AES key; the server keeps
       only the id and the sealed key (sync_family_share_put), and hands it back only to someone on the same paid
       family plan (sync_family_share_take). The code works for 2 days, for everyone on the plan, and never
       leaves the devices, so the server can't open it.
     - Each device on the list writes its device public key (devices.js) into the list, under the list's seal.
   Leaving, or being taken off: the payer's app moves the list to a new key and leaves the new key under the
   old row, sealed to each kept device's public key, the row marked closed so it takes no more writes
   (supabase/migrations/20261108_sync_family_lists.sql). A device with no hand-off for itself drops the list.
   What can't be taken back: whoever had the key keeps what they already synced, on their own devices.
   Loaded after devices.js and hosted-sync.js; the pure parts are module-loadable for test/family-list.test.js. */
'use strict';

const FAMILY_SALT='romulus-family-list-v1', FAMILY_ROUNDS=600000;
const FAMILY_KEY_SHAPE=/^tk_[A-Za-z0-9_-]{13,}$/;
const FAMILY_ROLE_KEY='tasks.familyRole'; // 'payer' | 'member' | '' (the Family tab shows while it's set)
const FAMILY_WHY={
  not_family:'only people on a paid family plan can share a family list, and only with the people on that plan',
  no_code:'that code isn’t right, or it’s over 2 days old',
  rate:'too many tries from this network; try again in an hour',
  no_account:'sync hasn’t started on this device yet; try again in a minute',
  bad:'that didn’t work'
};

// the code → {id (what the server keeps it under), key (seals the list's key)}; its own salt, so it never matches a pairing code
async function familyDerive(code){
  const enc=new TextEncoder();
  const base=await crypto.subtle.importKey('raw',enc.encode(code),'PBKDF2',false,['deriveBits']);
  const bits=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:enc.encode(FAMILY_SALT),iterations:FAMILY_ROUNDS},base,512));
  const key=await crypto.subtle.importKey('raw',bits.slice(32),{name:'AES-GCM'},false,['encrypt','decrypt']);
  return {id:Array.from(bits.slice(0,32),function(b){ return b.toString(16).padStart(2,'0'); }).join(''),key:key};
}
// what a code carries, and reading it back: the list's key, or null
function familyCodeText(syncKey){ return JSON.stringify({v:1,s:syncKey}); }
function familyCodeKey(text){
  let o=null; try{ o=JSON.parse(text); }catch(e){}
  return o&&typeof o.s==='string'&&FAMILY_KEY_SHAPE.test(o.s)?o.s:null;
}
/* The deletions that go into the family list's online copy: only of tasks that copy has (or had). Every other
   list carries all of this device's deletions, which here would show the family the ids and times of private
   ones. Pure, for tests. */
function familyTombs(tombs,remoteDoc){
  const ids={};
  ((remoteDoc&&remoteDoc.tasks)||[]).forEach(function(t){ ids[t.id]=1; });
  ((remoteDoc&&remoteDoc.tombstones)||[]).forEach(function(x){ ids[x.id]=1; });
  return (tombs||[]).filter(function(x){ return ids[x.id]; });
}
// the devices on the list ({deviceId: {acct, pub, name}}) with this one in it; changed = it has to be written
function familyPeopleWithMe(people,id,me){
  const out=Object.assign({},people||{}), old=out[id];
  const entry={acct:me.acct||null,pub:me.pub||null,name:String(me.name||'').slice(0,60)};
  const changed=!old||old.acct!==entry.acct||old.name!==entry.name||JSON.stringify(old.pub||null)!==JSON.stringify(entry.pub);
  if(changed)out[id]=entry;
  return {people:out,changed:changed};
}
// how many people (accounts) and devices are on it
function familyCount(people){
  const ids=Object.keys(people||{}), accts={};
  ids.forEach(function(id){ const a=people[id].acct; if(a)accts[a]=1; });
  return {people:Object.keys(accts).length,devices:ids.length};
}
// devices whose account isn't on the plan any more (or never said which it is): they don't get the next key
function familyStale(people,allowed){
  return Object.keys(people||{}).filter(function(id){ return allowed.indexOf(people[id].acct)===-1; });
}
/* The hand-off left under the old key: the new key sealed to every kept device that has a public key.
   seal(pubJwk, text) is devicesSeal (devices.js). Pure apart from it, for tests. */
async function familyHandoff(people,keepIds,newKey,seal){
  const handoff={};
  for(const id of keepIds){ const e=people&&people[id]; if(e&&e.pub)handoff[id]=await seal(e.pub,familyCodeText(newKey)); }
  return handoff;
}
function familyClosedDoc(handoff,now){ return {v:1,tasks:[],tombstones:[],rotated:{at:now,handoff:handoff}}; }
// off this device: the family's tasks go from here (no deletions sent, so everyone else keeps them)
function familyDropLocal(tasks){ return tasks.filter(function(t){ return t.ws!=='family'; }); }

/* ── in the app ── */
const familyState={people:null,rotating:false,lastRotate:0,lastCheck:0,joined:false}; // joined: by a code, not yet synced
function familyRole(){ try{ return localStorage.getItem(FAMILY_ROLE_KEY)||''; }catch(e){ return ''; } }
function familySetRole(role){
  try{ if(role)localStorage.setItem(FAMILY_ROLE_KEY,role); else localStorage.removeItem(FAMILY_ROLE_KEY); }catch(e){}
  const tf=document.getElementById('tabFamily'); if(tf)tf.hidden=!(familyConfigured()||!!role);
}
function familyErr(why){ return new Error(FAMILY_WHY[why]||why); }
// the personal profile on the Romulus server, which is who the server knows is on the plan
function familyHome(){
  const c=syncState.cfg, p=c&&c.personal;
  return validProfile(p)&&typeof hostedIs==='function'&&hostedIs(p.url)?p:null;
}
async function familyAcct(){ const p=familyHome(); return p?hostedAccountId(await syncRowKey(p)):null; }
async function familyMe(){
  const me=await deviceMe();
  return {id:deviceId(),entry:{acct:await familyAcct(),pub:me.pub,name:me.name}};
}
function familySetCfg(family){
  const raw=Object.assign({},syncState.cfg);
  if(family)raw.family=family; else delete raw.family;
  syncState.cfg=normalizeSyncCfg(raw);
  syncState.docs={}; familyState.people=null;
  if(typeof syncFillForm==='function')syncFillForm();
  return syncCfgPersist(syncState.cfg);
}

// called by syncOnce after each pull of the family list: is this device's entry there? true = write it
async function familyNoteRemote(doc){
  let me; try{ me=await familyMe(); }catch(e){ return false; }
  familyState.joined=false;
  const r=familyPeopleWithMe(doc&&doc.people,me.id,me.entry);
  familyState.people=r.people;
  if(Date.now()-familyState.lastCheck>60*60*1000)setTimeout(familyCheckStale,0); // the payer's device looks for someone who left
  return r.changed;
}
// what wsDoc('family') adds to the list it uploads
function familyDocExtras(remoteDoc){
  return {tombstones:familyTombs(state.tombstones,remoteDoc),people:familyState.people||(remoteDoc&&remoteDoc.people)||{}};
}
// the list moved to a new key: take this device's hand-off, or drop the list here. → 'moved' | 'off'
async function familyFollow(doc){
  const r=doc.rotated||{}, sealed=r.handoff&&r.handoff[deviceId()];
  let next=null;
  if(sealed){ try{ const k=await deviceKeys(); if(k.priv)next=familyCodeKey(await devicesOpen(k.priv,sealed)); }catch(e){} }
  const c=syncState.cfg;
  if(next&&c&&c.family){
    await familySetCfg(Object.assign({},c.family,{syncKey:next}));
    return 'moved';
  }
  const fresh=familyState.joined; familyState.joined=false;
  await familyDropHere();
  // a code made before the list moved on opens the old key, which leads nowhere now
  setSyncStatus(fresh?'that code is from before the family list moved to a new key: ask for a new code':'you’re no longer on the family list: it moved to a key this device wasn’t given. Its tasks are gone from here.',true);
  return 'off';
}
async function familyDropHere(){
  await familySetCfg(null);
  state.tasks=familyDropLocal(state.tasks);
  if(state.activeTab==='family'&&typeof switchTab==='function')switchTab('list');
  rebuildSnap(); store.save(currentDoc()); render();
  familySetRole(familyRole());
}

// a code for the list's key, kept on the server for 2 days. → 'ABCD-EFGH-JKMN'
async function familyMakeCode(syncKey){
  const p=familyHome(); if(!p)throw new Error('the family list needs sync through the Romulus server');
  const code=pairNewCode(), d=await familyDerive(code);
  const why=await syncRpc(p,'sync_family_share_put',{p_sync_key:await syncRowKey(p),p_id:d.id,p_sealed:await pairSeal(d.key,familyCodeText(syncKey))});
  if(why)throw familyErr(why);
  return pairFormat(code);
}
// Share a list with my family: the key is made here, and the list starts once the server took its code
async function familyStart(){
  const h=hostedServer(); if(!h||!familyHome())throw new Error('the family list needs sync through the Romulus server');
  const fam={url:h.url,key:h.key,syncKey:newSyncKey(),v2:true};
  const code=await familyMakeCode(fam.syncKey); // refused when this account isn't on a paid family plan: nothing made then
  await syncPushDoc(fam,{v:1,tasks:[],tombstones:[],people:{}});
  await familySetCfg(fam);
  familySetRole(familyRole());
  render(); startSyncLoop();
  return code;
}
async function familyJoin(text){
  const code=pairNormalize(text);
  if(!code)throw new Error('a family list code is 12 letters and numbers, like K7QM-4XR9-PB2T');
  const p=familyHome(), h=hostedServer(); if(!p||!h)throw new Error('the family list needs sync through the Romulus server');
  const d=await familyDerive(code);
  const r=(await syncRpc(p,'sync_family_share_take',{p_sync_key:await syncRowKey(p),p_id:d.id}))[0]||{};
  if(r.refused)throw familyErr(r.refused);
  const key=r.sealed?familyCodeKey(await pairOpen(d.key,r.sealed)):null;
  if(!key)throw new Error('that code didn’t open: ask for a new one');
  const c=syncState.cfg;
  if(c.family&&c.family.syncKey===key)return 'already';
  if(c.family){
    if(!confirm('This device already has a family list. Switch to the one this code opens?\n\nThe tasks of the one here leave this device; everyone else on it keeps them.'))return 'kept';
    state.tasks=familyDropLocal(state.tasks); rebuildSnap(); store.save(currentDoc());
  }
  await familySetCfg({url:h.url,key:h.key,syncKey:key,v2:true});
  familyState.joined=true;
  familySetRole(familyRole());
  render(); startSyncLoop();
  return 'joined';
}
/* The payer's device moves the list to a new key that only the devices of the people on the plan get
   (allowed = their account ids). Order: the list is copied under the new key and read back, only then is the
   old row closed with the hand-off, only then does this device switch. */
async function familyRotate(allowed){
  const c=syncState.cfg, old=c&&c.family;
  if(!validProfile(old)||familyState.rotating)return null;
  familyState.rotating=true; familyState.lastRotate=Date.now();
  clearInterval(syncState.pollTimer); clearTimeout(syncState.pushTimer);
  try{
    for(let i=0;i<40&&syncState.busy;i++)await new Promise(function(r){ setTimeout(r,250); });
    await syncNow(); // this device's latest edits reach the list first
    if(syncState.cfg.family!==old)return null; // the sync followed someone else's move
    const doc=(await syncPullRow(old)).doc||{v:1,tasks:[],tombstones:[],people:{}};
    if(doc.rotated)return null;
    const people=doc.people||{};
    const keep=Object.keys(people).filter(function(id){ return allowed.indexOf(people[id].acct)!==-1; });
    const kept={}; keep.forEach(function(id){ kept[id]=people[id]; });
    const nk=newSyncKey(), next=Object.assign({},old,{syncKey:nk});
    const copy={v:1,tasks:doc.tasks||[],tombstones:doc.tombstones||[],people:kept};
    await syncPushDoc(next,copy);
    if(stableJson(await syncPull(next))!==stableJson(copy))throw new Error('the copy under the new key did not read back');
    const sealed=await syncSeal(old.syncKey,familyClosedDoc(await familyHandoff(people,keep,nk,devicesSeal),Date.now()));
    // closed:1 sits outside the seal so the server can see it: that row takes no write after this one
    if((await syncRpc(old,'sync_set',{p_sync_key:await syncRowKey(old),p_doc:Object.assign({closed:1},sealed)}))!==true)throw new Error('the old copy couldn’t be closed');
    await familySetCfg(next);
    return {kept:keep.length,dropped:Object.keys(people).length-keep.length};
  }finally{
    familyState.rotating=false;
    startSyncLoop();
  }
}
// on the payer's device: anyone on the list whose account left the plan? Then the list moves on without them.
async function familyCheckStale(){
  const p=familyHome(), c=syncState.cfg;
  if(!p||!c||!validProfile(c.family)||familyState.rotating||Date.now()-familyState.lastRotate<10*60*1000)return null;
  familyState.lastCheck=Date.now();
  let rows=[]; try{ rows=await syncRpc(p,'sync_family_list',{p_sync_key:await syncRowKey(p)}); }catch(e){ return null; }
  if(!(rows[0]&&rows[0].role==='payer'))return null;
  const allowed=[await familyAcct()].concat(rows.map(function(r){ return r.member; }).filter(Boolean));
  let people=familyState.people;
  if(!people){ try{ people=((await syncPullRow(c.family)).doc||{}).people||{}; }catch(e){ return null; } }
  if(!familyStale(people,allowed).length)return null;
  try{
    const r=await familyRotate(allowed);
    if(r&&r.dropped)setSyncStatus('the family list moved to a new key: '+r.dropped+' device'+(r.dropped===1?'':'s')+' of someone no longer on your plan won’t get anything new');
    return r;
  }catch(e){ setSyncStatus('couldn’t move the family list to a new key: '+e.message,true); return null; }
}

/* ── Settings → Device sync → Family → Family list (drawn by hosted-sync.js drawFamily) ── */
function familyDraw(role){
  const box=document.getElementById('familyListBox'); if(!box)return;
  familySetRole(role||'');
  box.hidden=!role;
  if(!role)return;
  const on=validProfile(syncState.cfg&&syncState.cfg.family);
  const info=document.getElementById('familyListInfo');
  document.getElementById('familyStartBtn').hidden=on;
  document.getElementById('familyCodeBtn').hidden=!on;
  document.getElementById('familyLeaveBtn').hidden=!on;
  if(!on){ info.textContent='One list everyone on your plan shares: groceries, chores, a trip. Changes show up on everyone’s devices as they happen, and it’s end-to-end encrypted like your other lists, so the server can’t read it.'; return; }
  const n=familyCount(familyState.people);
  info.textContent='The Family tab is shared'+(n.people>1?' with '+(n.people-1)+' more '+(n.people===2?'person':'people'):'; nobody else has joined yet')+'. Make a code for anyone on your plan who should join.';
}
if(typeof document!=='undefined'&&document.getElementById('familyListBox')){
  const codeEl=$('familyListCode'), info=$('familyListInfo');
  const showCode=function(code){
    codeEl.textContent=code; codeEl.hidden=false;
    info.textContent='Give this code to the people on your plan. In their Romulus: Settings → Device sync → I have a family list code. It works for 2 days, only for people on your plan.';
  };
  const busy=function(b,on){ b.disabled=on; };
  $('familyStartBtn').addEventListener('click',async function(){
    const b=this; busy(b,true); setSyncStatus('starting the family list…');
    try{ showCode(await familyStart()); setSyncStatus('the family list is on the Family tab'); $('familyStartBtn').hidden=true; $('familyCodeBtn').hidden=$('familyLeaveBtn').hidden=false; }
    catch(e){ setSyncStatus('couldn’t start the family list: '+e.message,true); }
    finally{ busy(b,false); }
  });
  $('familyCodeBtn').addEventListener('click',async function(){
    const b=this, c=syncState.cfg; if(!c||!validProfile(c.family))return;
    busy(b,true);
    try{ showCode(await familyMakeCode(c.family.syncKey)); setSyncStatus('family list code made'); }
    catch(e){ setSyncStatus('couldn’t make a code: '+e.message,true); }
    finally{ busy(b,false); }
  });
  $('familyJoinBtn').addEventListener('click',async function(){
    const text=prompt('The family list code someone on your plan gave you:');
    if(!text||!text.trim())return;
    const b=this; busy(b,true); setSyncStatus('joining the family list…');
    try{
      const r=await familyJoin(text);
      if(r!=='kept')setSyncStatus(r==='already'?'this device already has that family list':'you’re on the family list: it’s on the Family tab');
      if(typeof hostedDraw==='function')hostedDraw();
    }catch(e){ setSyncStatus('couldn’t join: '+e.message,true); }
    finally{ busy(b,false); }
  });
  $('familyLeaveBtn').addEventListener('click',async function(){
    if(!confirm('Leave the family list on this device?\n\nIts tasks go from this device; everyone else keeps them. To join again you need a new code.'))return;
    await familyDropHere(); codeEl.hidden=true;
    setSyncStatus('this device left the family list');
    if(typeof hostedDraw==='function')hostedDraw();
  });
  // the Family tab shows for someone on a family plan before Settings was ever opened
  setTimeout(async function(){
    const p=familyHome(); if(!p)return;
    try{ const rows=await syncRpc(p,'sync_family_list',{p_sync_key:await syncRowKey(p)}); familySetRole((rows[0]&&rows[0].role)||''); }catch(e){}
  },4000);
  familySetRole(familyRole());
}

if(typeof module!=='undefined')module.exports={familyDerive,familyCodeText,familyCodeKey,familyTombs,familyPeopleWithMe,familyCount,familyStale,familyHandoff,familyClosedDoc,familyDropLocal,FAMILY_WHY};
