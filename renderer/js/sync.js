/* Storage, the custom theme CSS, and device sync (Supabase, per-task last-write-wins).
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── storage ── */
const KEY = 'tasks.v1';
/* The phone (and a plain browser) keeps the tasks in IndexedDB: localStorage stops at about 5 MB, and a list
   that outgrew it would stop saving. The localStorage copy older versions wrote is read once, then dropped. */
const idb={
  db:null,
  open(){
    if(this.db)return this.db;
    this.db=new Promise(function(ok,fail){
      if(!window.indexedDB){ fail(new Error('no IndexedDB')); return; }
      const r=indexedDB.open('romulus',1);
      r.onupgradeneeded=function(){ r.result.createObjectStore('kv'); };
      r.onsuccess=function(){ ok(r.result); }; r.onerror=function(){ fail(r.error); };
    });
    this.db.catch(function(){ idb.db=null; });
    return this.db;
  },
  async get(k){ const db=await this.open(); return new Promise(function(ok,fail){ const r=db.transaction('kv').objectStore('kv').get(k); r.onsuccess=function(){ ok(r.result); }; r.onerror=function(){ fail(r.error); }; }); },
  async set(k,v){ const db=await this.open(); return new Promise(function(ok,fail){ const tx=db.transaction('kv','readwrite'); tx.objectStore('kv').put(v,k); tx.oncomplete=function(){ ok(); }; tx.onerror=tx.onabort=function(){ fail(tx.error||new Error('save aborted')); }; }); }
};
let saveWarned=false; // one toast per session when saving fails, not one per edit
const store = {
  async load(){
    // desktop: a file that can't be read (or parsed) throws, and init.js then refuses to save over it; null = first run.
    // When it fell back to a backup copy, say so once the page is up.
    if(window.desktop){
      const r=await window.desktop.load();
      if(window.desktop.loadRestored)window.desktop.loadRestored().then(function(from){ if(from)setTimeout(function(){ voiceToast('Your tasks file was damaged, so Romulus opened its backup ('+from+').',true); },1500); }).catch(function(){});
      return r?JSON.parse(r):null;
    }
    try{
      if(window.storage){ const r=await window.storage.get(KEY); return(r&&r.value)?JSON.parse(r.value):null; }
      let r=null; try{ r=await idb.get(KEY); }catch(e){}
      if(r==null)r=localStorage.getItem(KEY);
      return r?JSON.parse(r):null;
    }catch(e){ return null; }
  },
  async save(data){
    const raw=JSON.stringify(data);
    try{
      if(window.desktop){ if(await window.desktop.save(raw)===false)throw new Error('the tasks file could not be written'); }
      else if(window.storage){ await window.storage.set(KEY,raw); }
      else {
        let inDb=false; try{ await idb.set(KEY,raw); inDb=true; }catch(e){}
        if(inDb){ try{ localStorage.removeItem(KEY); }catch(e){} }
        else localStorage.setItem(KEY,raw);
      }
      saveWarned=false;
    }catch(e){
      console.error('save failed',e);
      if(!saveWarned&&typeof voiceToast==='function'){ saveWarned=true; voiceToast('Couldn’t save your tasks on this device. Your last change may be lost if the app closes.',true); }
    }
  }
};

/* ── custom theme CSS ── */
const THEME_KEY='tasks.theme.v1';
const themeStyle=document.createElement('style');
document.head.appendChild(themeStyle);
function applyTheme(css){ themeStyle.textContent=css||''; }
// light / dark / system (the computer's setting): html[data-theme], read by styles.css.
// custom: only the saved Custom CSS over the plain base colors (pinned light, so the computer's dark mode
// never mixes in); the other modes keep it saved but switch it off
const THEME_MODE_KEY='tasks.themeMode.v1';
function themeModeSaved(){
  const mode=localStorage.getItem(THEME_MODE_KEY);
  if(mode)return mode;
  return localStorage.getItem(THEME_KEY)?'custom':'system'; // CSS saved before the Custom chip existed
}
function applyThemeMode(mode){
  if(mode==='light'||mode==='dark')document.documentElement.dataset.theme=mode;
  else if(mode==='custom')document.documentElement.dataset.theme='light';
  else delete document.documentElement.dataset.theme;
  let css=''; try{ if(mode==='custom')css=localStorage.getItem(THEME_KEY)||''; }catch(e){}
  applyTheme(css);
  themeGuard(mode==='custom');
}

/* Custom CSS can leave text the same colour as what's behind it (many styles.css colours are fixed, not
   variables). While Custom is on, any visible text below 2:1 contrast (barely readable; the built-in
   --faint is ~2.7:1, so deliberately quiet text is left alone) gets the theme's --ink or --surface,
   whichever reads, else black/white; rechecked as the screen changes, undone when Custom goes off. */
let themeGuardObs=null, themeGuardTimer=0;
function themeGuardRgba(s){ const m=String(s).match(/[\d.]+/g); if(!m||m.length<3)return null; return [+m[0],+m[1],+m[2],m.length>3?+m[3]:1]; }
function themeGuardLum(c){ const f=function(v){ v/=255; return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4); }; return .2126*f(c[0])+.7152*f(c[1])+.0722*f(c[2]); }
function themeGuardOver(top,bot){ const a=top[3]; return [top[0]*a+bot[0]*(1-a),top[1]*a+bot[1]*(1-a),top[2]*a+bot[2]*(1-a),1]; }
function themeGuardRatio(a,b){ const x=themeGuardLum(a), y=themeGuardLum(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); }
function themeGuardBehind(el){
  const layers=[];
  for(let e=el;e;e=e.parentElement){ const c=themeGuardRgba(getComputedStyle(e).backgroundColor); if(c&&c[3]>0){ layers.push(c); if(c[3]>=1)break; } }
  let b=themeGuardRgba(getComputedStyle(document.documentElement).getPropertyValue('--bg'))||[255,255,255,1];
  if(!layers.length||layers[layers.length-1][3]<1){ const bodyBg=themeGuardRgba(getComputedStyle(document.body).backgroundColor); if(bodyBg&&bodyBg[3]>=1)b=bodyBg; }
  for(let i=layers.length-1;i>=0;i--)b=themeGuardOver(layers[i],b);
  return b;
}
function themeGuardUndo(){
  document.querySelectorAll('[data-tfix]').forEach(function(el){
    el.style.removeProperty('color');
    if(el.dataset.tfix!=='-')el.style.color=el.dataset.tfix;
    delete el.dataset.tfix;
  });
}
function themeGuardRun(){
  themeGuardUndo();
  const probe=document.createElement('span'); document.body.appendChild(probe);
  const pick=function(v){ probe.style.color='var('+v+')'; return themeGuardRgba(getComputedStyle(probe).color); };
  const options=[pick('--ink'),pick('--surface'),[0,0,0,1],[255,255,255,1]].filter(Boolean);
  probe.remove();
  document.querySelectorAll('body *').forEach(function(el){
    const tag=el.tagName;
    if(tag==='SCRIPT'||tag==='STYLE'||tag==='svg'||el.closest('svg'))return;
    let text=false;
    for(const n of el.childNodes){ if(n.nodeType===3&&n.textContent.trim()){ text=true; break; } }
    if(!text&&(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'))text=true;
    if(!text)return;
    const cs=getComputedStyle(el);
    if(cs.visibility==='hidden'||+cs.opacity===0)return;
    if(!el.getClientRects().length)return;
    const fg=themeGuardRgba(cs.color); if(!fg)return;
    const bg=themeGuardBehind(el);
    if(themeGuardRatio(themeGuardOver(fg,bg),bg)>=2)return;
    const best=options.find(function(c){ return themeGuardRatio(c,bg)>=4.5; })||options.reduce(function(a,c){ return themeGuardRatio(c,bg)>themeGuardRatio(a,bg)?c:a; });
    el.dataset.tfix=el.style.color||'-';
    el.style.setProperty('color','rgb('+best.slice(0,3).map(Math.round).join(',')+')','important'); // beats !important in the custom CSS
  });
}
function themeGuard(on){
  clearTimeout(themeGuardTimer);
  if(themeGuardObs){ themeGuardObs.disconnect(); themeGuardObs=null; }
  if(!on){ themeGuardUndo(); return; }
  const later=function(){ clearTimeout(themeGuardTimer); themeGuardTimer=setTimeout(themeGuardRun,250); };
  // our own fixes only touch style, which isn't watched, so this never loops
  themeGuardObs=new MutationObserver(later);
  themeGuardObs.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','hidden','open']});
  later();
}
try{ applyThemeMode(themeModeSaved()); }catch(e){}

/* ── device sync (Supabase-backed, per-task last-write-wins) ──
   Supports two independent channels ("workspaces"): personal and work.
   Each syncs with its own Supabase project; the remote docs never contain
   the ws field, so other devices/apps on a channel need no changes. */
const SYNC_CFG_KEY='tasks.sync.v1';
const syncState={ cfg:null, busy:false, again:false, pushTimer:null, pollTimer:null,
  docs:{}, // the last document pulled per row (url|key → {doc, updatedAt}): sync_get sends nothing back while it's unchanged
  noSince:false, // the project's sync_get is an older one without p_since (migration not applied): pull whole rows
  errStreak:0, nextTryAt:0 }; // after errors the poll backs off (a minute, then doubling, up to 15 minutes)
const SYNC_POLL_MS=90*1000; // the fallback poll when live updates aren't connected (they usually are)
/* One project, one sync key. The Work, Agent and School lists live in the same project under keys made
   from the personal one (tk_<id> → tk_work_<id>, tk_agent_<id>, tk_school_<id>; the Agent one must start
   with tk_agent_ for the server's claim function), unless a list was given its own key. A derived
   profile is marked derived:true so Settings shows it as automatic and it follows the personal key.
   The same rule lives in agent/supabase.js for the desktop side. */
function deriveSyncKey(personalKey,list){
  const id=String(personalKey||'').replace(/^tk_/,'');
  return id?'tk_'+list+'_'+id:'';
}
function normalizeSyncCfg(raw){
  if(!raw)return null;
  if(raw.url)raw={personal:raw}; // legacy single-profile shape
  const out={};
  if(raw.personal&&raw.personal.url)out.personal=raw.personal;
  // the family list (family-list.js) always has a key of its own: it's shared, so nobody's personal key may lead to it
  ['work','agent','school','family'].forEach(function(k){ const p=raw[k]; if(p&&p.url&&p.syncKey&&!p.derived)out[k]=p; });
  const p=out.personal;
  if(p&&p.url&&p.key&&p.syncKey)['work','agent','school'].forEach(function(k){ if(!out[k]){ out[k]={url:p.url,key:p.key,syncKey:deriveSyncKey(p.syncKey,k),derived:true}; if(p.v2)out[k].v2=true; } });
  return (out.personal||out.work)?out:null;
}
/* Where the config lives. The sync key is the password to every list, so on the desktop it stays in
   config.json (main/store.js keeps it encrypted with the OS; reached through syncGetCfg/syncSaveCfg) and
   only in memory here. The phone and plain web have no such store: there it stays in localStorage. */
function syncCfgDesktop(){ return !!(window.desktop&&window.desktop.syncGetCfg&&window.desktop.syncSaveCfg); }
function syncCfgLocalRead(){ try{ return normalizeSyncCfg(JSON.parse(localStorage.getItem(SYNC_CFG_KEY))); }catch(e){ return null; } }
function syncCfgPersist(cfg){ // cfg null = sync turned off
  if(syncCfgDesktop()){ try{ localStorage.removeItem(SYNC_CFG_KEY); }catch(e){} return window.desktop.syncSaveCfg(cfg||null); }
  try{ if(cfg)localStorage.setItem(SYNC_CFG_KEY,JSON.stringify(cfg)); else localStorage.removeItem(SYNC_CFG_KEY); }catch(e){}
  return Promise.resolve(true);
}
if(syncCfgDesktop()){
  // init.js waits for this before the first sync. A config left in localStorage by an older build is moved
  // into config.json (when that has none) and removed from localStorage either way.
  syncState.ready=(async function(){
    let n=null; try{ n=normalizeSyncCfg(await window.desktop.syncGetCfg()); }catch(e){}
    const legacy=syncCfgLocalRead();
    if(!n&&legacy){ n=legacy; try{ await window.desktop.syncSaveCfg(n); }catch(e){} }
    // config.json with only a personal profile (an older setup, or a seed file): the lists made from it go back, so the runner sees the agent list
    else if(n&&['work','agent','school'].some(function(k){ return n[k]&&n[k].derived; })){ try{ window.desktop.syncSaveCfg(n); }catch(e){} }
    if(!syncState.cfg)syncState.cfg=n; // Settings may have saved one while this was in flight
    try{ localStorage.removeItem(SYNC_CFG_KEY); }catch(e){}
  })();
} else syncState.cfg=syncCfgLocalRead();

function validProfile(p){ return !!(p&&p.url&&p.key&&p.syncKey); }
function profileList(){
  const c=syncState.cfg||{}; const out=[];
  if(validProfile(c.personal))out.push('personal');
  if(validProfile(c.work))out.push('work');
  if(validProfile(c.agent))out.push('agent');
  if(validProfile(c.school))out.push('school');
  if(validProfile(c.family))out.push('family');
  return out;
}
function syncEnabled(){ return profileList().length>0; }
function workConfigured(){ return !!(syncState.cfg&&validProfile(syncState.cfg.work)); }
function agentConfigured(){ return !!(syncState.cfg&&validProfile(syncState.cfg.agent)); }
// the Agent tab can be used here: this computer runs the agent itself (sync only shares the list with
// the phone), while the phone needs the synced list to reach it
function agentAvailable(){ return agentConfigured()||!!(window.desktop&&window.desktop.aiStatus); }
function schoolConfigured(){ return !!(syncState.cfg&&validProfile(syncState.cfg.school)); }
function familyConfigured(){ return !!(syncState.cfg&&validProfile(syncState.cfg.family)); }
// "agent" is a third channel: tasks Claude works on by itself. Only it carries
// the status/note fields — personal/work docs keep the old shape so older
// builds (office app) never see fields they would drop.
function taskWs(t){ return t.ws==='work'?'work':t.ws==='agent'?'agent':t.ws==='school'?'school':t.ws==='family'?'family':'personal'; }
/* School: every assignment lives on the School tab; it also joins the Human list ahead of its
   due date — regular work 2 weeks before, exams 3 weeks before, projects right away. */
const SCHOOL_LEAD_DAYS={regular:14,exam:21,project:null};
const SCHOOL_KIND_LABEL={regular:'Regular',exam:'Exam',project:'Project'};
function schoolKind(t){ return t.kind==='exam'||t.kind==='project'?t.kind:'regular'; }
function schoolShowFrom(t){ // the day it joins the Human list; null = it's there already
  const lead=SCHOOL_LEAD_DAYS[schoolKind(t)];
  if(lead==null||!t.due)return null;
  const p=t.due.split('-').map(Number); const d=new Date(p[0],p[1]-1,p[2]); d.setDate(d.getDate()-lead);
  return d;
}
function schoolSurfaced(t){ const f=schoolShowFrom(t); return !f||todayStart()>=f; }
// which tasks a list tab shows ('list' = Human)
function inTab(t,tab){
  const ws=taskWs(t);
  if(tab==='agent')return ws==='agent'&&t.status!=='suggested'; // a suggestion waits on the Human tab for Accept / Deny
  if(tab==='school')return ws==='school';
  if(tab==='work')return ws==='work';
  if(tab==='family')return ws==='family'; // the family's list stays on its own tab
  return ws==='personal'||ws==='work'||(ws==='school'&&schoolSurfaced(t));
}
function syncHeaders(p){ return {'apikey':p.key,'Authorization':'Bearer '+p.key,'Content-Type':'application/json'}; }
/* Every read and write goes through a database function that needs the list's sync key (sync_get,
   sync_put, sync_set: supabase/migrations/20261021_sync_rpc_lockdown.sql). The table itself is closed to
   the anon key, so the key in the app can't list or touch anything but what it knows the key of. */
async function syncRpc(p,fn,body){
  const res=await fetch(p.url.replace(/\/+$/,'')+'/rest/v1/rpc/'+fn,{method:'POST',headers:syncHeaders(p),body:JSON.stringify(body)});
  if(!res.ok){
    // the Romulus server limits downloads (supabase/migrations/20261111_sync_read_limits.sql): say so, it clears by itself
    let msg=''; try{ msg=String((await res.json()).message||''); }catch(e){}
    if(msg==='read_limit')throw new Error(SYNC_READ_LIMIT);
    throw new Error('HTTP '+res.status);
  }
  return res.json();
}
const SYNC_READ_LIMIT='sync paused for a while: this account downloaded a lot in a short time. Your lists are safe on this device, and it picks up again on its own.';
/* End-to-end encryption (sync-crypto.js). A profile with v2:true is found under its lookup id and its rows
   go up sealed; every list made from the personal key follows it (normalizeSyncCfg). A profile built for one
   row (ideasProfile, prefsProfile, …) has no flag of its own: it's whatever the list it belongs to is. */
function syncV2(p){
  if(p.v2!=null)return !!p.v2;
  const base=syncSplitKey(p.syncKey).base, c=syncState.cfg||{};
  return ['personal','work','agent','school'].some(function(ws){ return c[ws]&&c[ws].syncKey===base&&c[ws].v2; });
}
async function syncRowKey(p){ return syncV2(p)?syncV2RowKey(p.syncKey):p.syncKey; }
/* Another device moved these lists to v2 and left {moved:'v2'} under the old key (syncMoveToV2 in
   settings.js): this one follows, so it never writes plain lists again. */
function syncAdoptV2(p){
  const base=syncSplitKey(p.syncKey).base, c=syncState.cfg;
  if(!c||!syncCryptoOk())return false;
  const ws=['personal','work','agent','school'].find(function(w){ return c[w]&&c[w].syncKey===base; });
  if(!ws)return false;
  const raw=Object.assign({},c);
  if(ws==='personal'||c[ws].derived)raw.personal=Object.assign({},c.personal,{v2:true});
  else raw[ws]=Object.assign({},c[ws],{v2:true});
  syncState.cfg=normalizeSyncCfg(raw);
  syncCfgPersist(syncState.cfg);
  syncState.docs={};
  return true;
}
/* Before switching to a Supabase project typed into Settings: is it reachable, is the key right, and was
   setup.sql run in it? '' = fine (or something the normal sync will report better). */
async function syncCheckProject(p){
  let res;
  try{ res=await fetch(p.url.replace(/\/+$/,'')+'/rest/v1/rpc/sync_get',{method:'POST',headers:syncHeaders(p),body:JSON.stringify({p_sync_key:p.syncKey})}); }
  catch(e){ return 'couldn’t reach that Project URL: check it, and that you’re online'; }
  if(res.ok)return '';
  if(res.status===401||res.status===403)return 'that key was refused: paste the publishable key from Project Settings → API';
  if(res.status===404)return 'that project isn’t set up yet: press Copy setup.sql, paste it in the project’s SQL Editor and press Run, then Save & sync again';
  return '';
}
/* Moving the lists to another project (Romulus server → your own): once this device's lists are up there, the
   old personal row gets {movedTo:{url,key}} in place of the list, sealed like every row there, so only a
   device with the sync key can read it. Every other device on these lists follows it on its next sync
   (syncFollowMove), so nobody has to pair them again. An older build that doesn't know the note just keeps
   syncing where it was. The note's list is empty with no tombstones, so merging it deletes nothing. */
async function syncLeaveMovedNote(oldP,newP){
  await syncPushDoc(oldP,{v:1,tasks:[],tombstones:[],movedTo:{url:newP.url,key:newP.key,v2:!!newP.v2}});
}
function syncFollowMove(from,m){
  const c=syncState.cfg;
  if(!c||!m||typeof m.url!=='string'||typeof m.key!=='string'||!/^https:\/\/[^\s/]+/.test(m.url)||m.key.length<10)return false;
  if(m.url.replace(/\/+$/,'')===from.url.replace(/\/+$/,''))return false;
  const raw={};
  ['personal','work','agent','school'].forEach(function(ws){
    const x=c[ws]; if(!x||(ws!=='personal'&&x.derived))return;
    if(x.url!==from.url){ raw[ws]=x; return; }
    const y=Object.assign({},x,{url:m.url,key:m.key});
    if(m.v2)y.v2=true; else delete y.v2;
    raw[ws]=y;
  });
  if(c.family)raw.family=c.family; // the family list stays on the Romulus server whatever project the rest moves to
  syncState.cfg=normalizeSyncCfg(raw);
  syncCfgPersist(syncState.cfg);
  syncState.docs={};
  if(typeof hostedSetOptOut==='function')hostedSetOptOut(true); // don't start on the Romulus server by itself again
  if(typeof syncFillForm==='function')syncFillForm();
  return true;
}
function setSyncStatus(msg,isErr){
  const n=document.getElementById('syncStatus');
  if(n){ n.textContent=msg; n.style.color=isErr?'var(--late)':'var(--muted)'; }
}

// The list plus when it was last written, so our upload can check nobody wrote in between.
// Also learns the list's live-update channel (liveTopics), which only the database knows.
// With p_since (when this row was last pulled) the database sends the document only if it changed since;
// otherwise the copy kept here is used, so an unchanged list costs ~100 bytes a poll, not the whole list.
async function syncPullRow(p){
  const v2=syncV2(p), rk=await syncRowKey(p);
  const k=p.url+'|'+rk, c=syncState.docs[k];
  let rows;
  if(c&&c.updatedAt&&!syncState.noSince){
    try{ rows=await syncRpc(p,'sync_get',{p_sync_key:rk,p_since:c.updatedAt}); }
    catch(e){ if(!/HTTP 404/.test(e.message))throw e; syncState.noSince=true; } // an older database: no p_since yet
  }
  if(!rows)rows=await syncRpc(p,'sync_get',{p_sync_key:rk});
  const r=rows[0]||{};
  if(r.topic)noteTopic(p,r.topic);
  if(r.unchanged&&c&&r.updated_at===c.updatedAt)return {doc:c.doc,updatedAt:c.updatedAt};
  if(!v2&&r.doc&&r.doc.moved==='v2'){
    if(syncAdoptV2(p))return syncPullRow(Object.assign({},p,{v2:true}));
    throw new Error('these lists are end-to-end encrypted now, and this device can’t open them');
  }
  // a v2 row is opened here, so everything above this layer only ever sees the plain document
  if(v2&&r.doc&&!syncIsSealed(r.doc))throw new Error('an unencrypted copy is where the encrypted list should be; not touching it');
  const row={doc:r.doc?(syncIsSealed(r.doc)?await syncOpen(p.syncKey,r.doc):r.doc):null,updatedAt:r.updated_at||null};
  if(row.updatedAt)syncState.docs[k]={doc:row.doc,updatedAt:row.updatedAt}; else delete syncState.docs[k];
  return row;
}
async function syncPull(p){ return (await syncPullRow(p)).doc; }
// The database also refuses a write when the account is over its storage allowance, saving too often, or
// new and its network has made too many accounts this hour (supabase/migrations/20261030_sync_account_limits.sql).
// That comes back false too, so ask why: a refusal is shown and backed off from, not retried as a clash.
const SYNC_REFUSED={
  full:'sync paused: this account’s online storage is full. Your lists are safe on this device; deleting old tasks frees space.',
  rate:'sync paused for a minute: it was saving too often',
  new_accounts:'sync couldn’t start: too many new sync keys from this network this hour. It tries again later.',
  server_full:'sync paused: the sync server is full right now. Your lists are safe on this device.',
  weak_key:'sync couldn’t start: that sync key is too short to be safe. Press Generate key in Settings → Sync.'
};
async function syncRefusal(p){
  try{
    const rk=await syncRowKey(p);
    const r=(await syncRpc(p,'sync_usage',{p_sync_key:rk}))[0];
    if(r&&r.refused)return SYNC_REFUSED[r.refused]||'sync refused ('+r.refused+')';
    // a new account on a key id under 32 characters is refused before it exists, so sync_usage can't say so
    // (sync_guard, supabase/migrations/20261031_sync_key_hardening.sql)
    if(r&&!Number(r.used_bytes)&&rk.replace(/^tk_(work_|agent_|school_)?/,'').replace(/:.*$/,'').length<32)return SYNC_REFUSED.weak_key;
    return '';
  }catch(e){ return ''; } // an older database without sync_usage
}
function refusedError(msg){ const e=new Error(msg); e.refused=true; return e; }
// Compare-and-swap upload: replaces the list only if it's still the version we downloaded (or creates
// it if there was none). false = someone else (phone, Claude, the connector) wrote in between.
async function syncUpDoc(p,doc){ return syncV2(p)?syncSeal(p.syncKey,doc):doc; } // what goes over the wire
async function syncPushCas(p,doc,prevUpdatedAt){
  if((await syncRpc(p,'sync_put',{p_sync_key:await syncRowKey(p),p_doc:await syncUpDoc(p,doc),p_prev:prevUpdatedAt||null}))===true)return true;
  const why=await syncRefusal(p);
  if(why)throw refusedError(why);
  return false;
}
async function syncPushDoc(p,doc){
  if((await syncRpc(p,'sync_set',{p_sync_key:await syncRowKey(p),p_doc:await syncUpDoc(p,doc)}))===true)return;
  const why=await syncRefusal(p);
  throw why?refusedError(why):new Error('not saved');
}

// JSON with every object's keys sorted. The database stores a document as jsonb, which hands its keys back
// in its own order (shortest first), so a plain JSON.stringify of the online copy never matched the one
// here: every sync took the list for changed and uploaded it, and with live updates on, each upload woke
// this device to sync again, without end.
function stableJson(v){
  return JSON.stringify(v,function(k,x){
    if(!x||typeof x!=='object'||Array.isArray(x))return x;
    const o={}; Object.keys(x).sort().forEach(function(key){ o[key]=x[key]; }); return o;
  });
}
function canonTasks(tasks){
  return stableJson(tasks.slice().sort(function(a,b){ return a.id<b.id?-1:1; }));
}
function stripWs(t){ const c=Object.assign({},t); delete c.ws; return c; }
// Doc pushed to a channel: only that workspace's tasks, without the ws field —
// remote docs stay compatible with devices that know nothing about workspaces.
// The family list (shared with other people) carries only its own deletions and the devices on it (family-list.js).
function wsDoc(ws,remoteDoc){
  const d={v:1,tasks:state.tasks.filter(function(t){ return taskWs(t)===ws; }).map(stripWs),tombstones:state.tombstones};
  if(ws==='family'&&typeof familyDocExtras==='function')Object.assign(d,familyDocExtras(remoteDoc));
  return d;
}
// Merge one channel's remote doc into that workspace's slice of local state.
// Per task id the newer updatedAt wins; a tombstone beats a task unless the
// task was edited after the deletion.
function mergeRemoteWs(remoteDoc,ws){
  const rTasksRaw=(remoteDoc&&Array.isArray(remoteDoc.tasks))?remoteDoc.tasks:[];
  const rTombs=(remoteDoc&&Array.isArray(remoteDoc.tombstones))?remoteDoc.tombstones:[];
  const rTasks=rTasksRaw.map(function(t){ const c=Object.assign({},t); c.ws=ws; if(!Array.isArray(c.subs))c.subs=[]; return c; });
  const tombs={};
  state.tombstones.concat(rTombs).forEach(function(x){ if(!tombs[x.id]||x.deletedAt>tombs[x.id])tombs[x.id]=x.deletedAt; });
  const localWs=state.tasks.filter(function(t){ return taskWs(t)===ws; });
  let others=state.tasks.filter(function(t){ return taskWs(t)!==ws; });
  const elsewhere={}; others.forEach(function(t){ elsewhere[t.id]=t; });
  const byId={};
  localWs.concat(rTasks).forEach(function(t){
    const prev=byId[t.id];
    if(!prev||(t.updatedAt||0)>(prev.updatedAt||0)){
      // a lane is only ever changed (switching), never removed: a newer copy that hasn't heard of it yet keeps it
      if(prev&&prev.lane&&!t.lane){ t=Object.assign({},t,{lane:prev.lane}); }
      byId[t.id]=t;
    } else if(t.lane&&!prev.lane){ byId[t.id]=Object.assign({},prev,{lane:t.lane}); }
  });
  // A task lives in one list. One moved to another list (Personal → Work) is still in the old list's online
  // copy, and must not come back there: the newer copy says where it lives (a tie keeps it where it is now
  // in the other list) and the stale one goes. Two copies of one id made every save restamp both, and the
  // lists uploaded each other's change forever.
  const merged=[], movedOut={};
  Object.keys(byId).forEach(function(id){
    if(tombs[id]&&tombs[id]>=(byId[id].updatedAt||0))return;
    const o=elsewhere[id];
    if(o&&(o.updatedAt||0)>=(byId[id].updatedAt||0))return;
    if(o)movedOut[id]=1;
    merged.push(byId[id]);
  });
  if(Object.keys(movedOut).length)others=others.filter(function(t){ return !movedOut[t.id]; });
  const cutoff=Date.now()-60*86400000; // drop tombstones older than 60 days
  const mergedTombs=Object.keys(tombs).filter(function(id){ return tombs[id]>cutoff; })
    .map(function(id){ return {id:id,deletedAt:tombs[id]}; });
  if(ws==='agent'){ // a task just turned "needs you" / "done" on another device: Claude answered
    const before={}; localWs.forEach(function(t){ before[t.id]=t.status; });
    if(merged.some(function(t){ return before[t.id]&&before[t.id]!==t.status&&(t.status==='needs-you'||t.status==='done'); }))buzz('answer');
  }
  const changedLocal=canonTasks(merged)!==canonTasks(localWs)||Object.keys(movedOut).length>0;
  const upTombs=ws==='family'&&typeof familyTombs==='function'?familyTombs(mergedTombs,remoteDoc):mergedTombs; // what wsDoc sends
  const changedRemote=canonTasks(merged.map(stripWs))!==canonTasks(rTasksRaw)||upTombs.length!==rTombs.length;
  state.tasks=others.concat(merged);
  state.tombstones=mergedTombs;
  if(changedLocal&&typeof billAlerts==='function')billAlerts(); // a bill to-do came from the computer (bill-reminders.js)
  return {changedLocal:changedLocal,changedRemote:changedRemote};
}

async function syncNow(){
  if(!syncEnabled())return;
  if(syncState.busy){ syncState.again=true; return; } // an edit during a sync: run once more right after it
  syncState.busy=true; syncState.again=false;
  try{ await syncOnce(); }
  finally{
    syncState.busy=false;
    if(syncState.again){ syncState.again=false; schedulePush(); }
  }
}
async function syncOnce(){
  setSyncStatus('syncing…');
  // this device's place in Settings → Devices, and whether the sync key moved on without it (devices.js)
  if(typeof devicesTick==='function'){
    const d=await devicesTick();
    if(d==='moved'){ setTimeout(startSyncLoop,0); return; }
    if(d==='off')return;
  }
  let firstErr=null, anyLocal=false;
  const list=profileList();
  for(let i=0;i<list.length;i++){
    const ws=list[i], p=syncState.cfg[ws];
    try{
      // download, merge, upload; if the list changed online in between (a task added from the phone
      // or by Claude), the upload is refused, so download again and merge that in too, never overwrite it
      for(let attempt=0;attempt<4;attempt++){
        const row=await syncPullRow(p);
        // the family list moved to a new key when someone left: follow it, or drop it here (family-list.js)
        if(ws==='family'&&row.doc&&row.doc.rotated&&typeof familyFollow==='function'){
          if(await familyFollow(row.doc)==='moved'){ setTimeout(startSyncLoop,0); return; }
          anyLocal=true; break;
        }
        // the list moved to a new sync key this device wasn't given: uploading here would only fill the blanked row again
        if(row.doc&&row.doc.rotated)throw new Error('the sync key was changed on another device: pair this one again with Add a device');
        // another device moved these lists to a different Supabase project: follow it there (syncLeaveMovedNote)
        if(ws==='personal'&&row.doc&&row.doc.movedTo&&syncFollowMove(p,row.doc.movedTo)){
          setSyncStatus('your lists moved to another Supabase project; following them there');
          setTimeout(startSyncLoop,0); return;
        }
        if(row.doc&&typeof markWelcomed==='function')markWelcomed(); // the account already has lists, so it was welcomed on another device
        const r=mergeRemoteWs(row.doc,ws);
        if(ws==='family'&&typeof familyNoteRemote==='function'&&await familyNoteRemote(row.doc))r.changedRemote=true; // this device's entry on it
        if(r.changedLocal)anyLocal=true;
        if(!(r.changedRemote||!row.doc))break;
        if(await syncPushCas(p,wsDoc(ws,row.doc),row.updatedAt))break;
        if(attempt===3)throw new Error('the list kept changing; will retry');
      }
    }catch(e){
      if(!firstErr)firstErr=e;
    }
  }
  const ip=ideasProfile();
  if(ip){
    try{
      for(let attempt=0;attempt<4;attempt++){ // same download-merge-upload as the lists above
        const row=await syncPullRow(ip);
        const r=mergeIdeas(row.doc);
        if(r.changedLocal)anyLocal=true;
        if(!(r.changedRemote||(!row.doc&&(state.ideas.cards.length||state.ideas.groups.length))))break;
        if(await syncPushCas(ip,ideasDoc(),row.updatedAt))break;
        if(attempt===3)throw new Error('the notes board kept changing; will retry');
      }
    }catch(e){
      if(!firstErr)firstErr=e;
    }
  }
  const hp=hoursProfile();
  if(hp){
    try{
      for(let attempt=0;attempt<4;attempt++){ // same download-merge-upload for the Hours log
        const row=await syncPullRow(hp);
        const r=mergeHours(row.doc);
        if(r.changedLocal)anyLocal=true;
        if(!(r.changedRemote||(!row.doc&&state.hours.entries.length)))break;
        if(await syncPushCas(hp,hoursDoc(),row.updatedAt))break;
        if(attempt===3)throw new Error('the hours log kept changing; will retry');
      }
    }catch(e){
      if(!firstErr)firstErr=e;
    }
  }
  // daily health totals the phone read (health.js); only when the lists are end-to-end encrypted
  const hlp=typeof healthProfile==='function'?healthProfile():null;
  let healthNew=false;
  if(hlp&&Date.now()>=healthRun.noRowUntil){
    try{
      for(let attempt=0;attempt<4;attempt++){
        const row=await syncPullRow(hlp);
        const r=mergeHealth(row.doc);
        if(r.changedLocal){ anyLocal=true; healthNew=true; }
        if(!(r.changedRemote||(!row.doc&&Object.keys(state.health.days).length)))break;
        if(await syncPushCas(hlp,healthDoc(),row.updatedAt))break;
        // making the row was refused: a database without the :health key yet
        // (supabase/migrations/20261116_sync_health_key.sql). The lists sync as before; try again in an hour
        if(!row.updatedAt){ healthRun.noRowUntil=Date.now()+3600000; break; }
        if(attempt===3)throw new Error('the health totals kept changing; will retry');
      }
    }catch(e){
      if(!firstErr)firstErr=e;
    }
  }
  // the Kitchen tab's pantry and recipes: their own row, merged by kitchen.js (never throws)
  if(typeof kitchenSync==='function'&&await kitchenSync())anyLocal=true;
  // the family's shared lists and sent to-dos: their own row, merged and drawn by family.js
  if(typeof familySync==='function'){
    try{ await familySync(); }catch(e){ if(!firstErr)firstErr=e; }
  }
  if(anyLocal){
    rebuildSnap();
    store.save(currentDoc());
    renderActive();
    if(spawnMissedRecurs())touch(); // ticked off on a device or by a tool that doesn't make the next one
  }
  if((anyLocal||healthNew)&&typeof healthAutoCheck==='function')healthAutoCheck(); // a task's goal reached on the phone, or just synced
  if(firstErr){
    // back off: a minute, then doubling, up to 15 minutes. Hammering a project that answers 402 (over its plan's limit) helps nobody
    syncState.errStreak=Math.min(syncState.errStreak+1,5);
    syncState.nextTryAt=Date.now()+Math.min(15*60000,60000*Math.pow(2,syncState.errStreak-1));
    setSyncStatus(/HTTP 402/.test(firstErr.message)?'sync paused: Supabase says the project is over its plan’s limit (egress). It resumes when the limit resets or the plan changes.':firstErr.refused?firstErr.message:'sync error: '+firstErr.message,true);
  }
  else{
    syncState.errStreak=0; syncState.nextTryAt=0;
    syncState.lastAt=Date.now();
    setSyncStatus('synced '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+(liveAllUp()?' · live':''));
  }
}
function schedulePush(){
  if(!syncEnabled())return;
  clearTimeout(syncState.pushTimer);
  syncState.pushTimer=setTimeout(syncNow,2500);
}
function startSyncLoop(){
  clearInterval(syncState.pollTimer);
  liveStop();
  if(!syncEnabled())return;
  // While Realtime is connected, changes arrive the moment they happen; the timer is only a safety net then.
  syncState.pollTimer=setInterval(function(){
    if(Date.now()<syncState.nextTryAt)return; // backing off after errors
    if(liveAllUp()&&Date.now()-(syncState.lastAt||0)<5*60000)return;
    syncNow();
  },SYNC_POLL_MS);
  syncNow(); // its downloads learn each list's live channel, which opens the sockets (noteTopic)
}

/* ── live updates (Supabase Realtime) ──
   One socket per Supabase project. The database says "changed" on a list's own broadcast channel
   whenever it is written (a trigger, in the migration above); the channel's name is a hash of the sync
   key that sync_get hands back, so nobody can listen without the key, and nothing travels on it but
   the nudge. A change from anywhere (phone, Claude, the connector, the hub) just starts a normal sync:
   the download-merge-upload above stays the only way data moves, so nothing here can lose an edit. */
const live={sockets:{}, nudgeTimer:null};
const liveTopics={}; // url|key|syncKey → channel name, learned from each list's first download
function noteTopic(p,topic){
  const id=p.url.replace(/\/+$/,'')+'|'+p.key;
  if(liveTopics[id+'|'+p.syncKey]===topic)return;
  liveTopics[id+'|'+p.syncKey]=topic;
  liveStart(); // a socket already open for this project joins the new channel
}
function liveTargets(){
  const out={};
  function add(p){
    if(!p)return;
    const url=p.url.replace(/\/+$/,''), id=url+'|'+p.key, topic=liveTopics[id+'|'+p.syncKey];
    const t=(out[id]=out[id]||{url:url,key:p.key,topics:[]});
    if(topic&&t.topics.indexOf(topic)<0)t.topics.push(topic);
  }
  profileList().forEach(function(ws){ add(syncState.cfg[ws]); });
  if(typeof ideasProfile==='function')add(ideasProfile());
  if(typeof hoursProfile==='function')add(hoursProfile());
  if(typeof healthProfile==='function')add(healthProfile());
  if(typeof kitchenProfile==='function')add(kitchenProfile());
  if(typeof familyProfile==='function')add(familyProfile());
  Object.keys(out).forEach(function(id){ if(!out[id].topics.length)delete out[id]; });
  return out;
}
function liveAllUp(){
  const ids=Object.keys(live.sockets);
  return ids.length>0&&ids.every(function(id){ const s=live.sockets[id]; return s.ws&&s.ws.readyState===1&&s.wanted.every(function(t){ return s.joined[t]; }); });
}
function liveNudge(){ // a burst of writes (our own upload's echo included) becomes one sync
  clearTimeout(live.nudgeTimer);
  live.nudgeTimer=setTimeout(syncNow,300);
}
function liveJoin(s,topic){ // one Phoenix channel per list, on the shared socket
  if(!s.ws||s.ws.readyState!==1||s.joined[topic]!=null)return;
  s.ref++; s.joined[topic]=false; s.refs[String(s.ref)]=topic;
  try{ s.ws.send(JSON.stringify({topic:'realtime:'+topic,event:'phx_join',ref:String(s.ref),join_ref:String(s.ref),
    payload:{config:{broadcast:{self:false,ack:false},presence:{key:''},postgres_changes:[],private:false}}})); }catch(e){}
}
function liveOpen(id,t,tries){
  if(typeof WebSocket!=='function')return;
  const s={ws:null,wanted:t.topics.slice(),joined:{},refs:{},ref:0,hb:null,retry:null,lastMsg:Date.now(),tries:tries||0};
  live.sockets[id]=s;
  try{ s.ws=new WebSocket(t.url.replace(/^http/,'ws')+'/realtime/v1/websocket?apikey='+encodeURIComponent(t.key)+'&vsn=1.0.0'); }
  catch(e){ return; }
  s.ws.onopen=function(){
    s.wanted.forEach(function(topic){ liveJoin(s,topic); });
    s.hb=setInterval(function(){
      if(Date.now()-s.lastMsg>60000){ try{ s.ws.close(); }catch(e){} return; } // went quiet: reconnect
      s.ref++; try{ s.ws.send(JSON.stringify({topic:'phoenix',event:'heartbeat',payload:{},ref:String(s.ref)})); }catch(e){}
    },25000);
  };
  s.ws.onmessage=function(e){
    s.lastMsg=Date.now();
    let m; try{ m=JSON.parse(e.data); }catch(err){ return; }
    const topic=String(m.topic||'').replace(/^realtime:/,'');
    if(m.event==='phx_reply'&&s.refs[m.ref]){ // the answer to a join
      const st=m.payload&&m.payload.status;
      if(st==='ok'){ s.joined[s.refs[m.ref]]=true; s.tries=0; syncNow(); } // catch up on anything missed while away
      else { try{ s.ws.close(); }catch(err){} }
    } else if(m.event==='broadcast'&&s.joined[topic]){ liveNudge(); }
    else if(m.event==='phx_error'||m.event==='phx_close'){ try{ s.ws.close(); }catch(err){} }
  };
  s.ws.onclose=function(){
    clearInterval(s.hb);
    if(live.sockets[id]!==s)return; // stopped on purpose
    const wait=Math.min(60000,2000*Math.pow(2,s.tries)); // 2s, 4s, 8s … up to a minute
    s.retry=setTimeout(function(){ if(live.sockets[id]===s)liveOpen(id,liveTargets()[id]||t,s.tries+1); },wait);
  };
}
function liveStart(){
  if(!syncEnabled())return;
  const targets=liveTargets();
  Object.keys(targets).forEach(function(id){
    const s=live.sockets[id];
    if(!s){ liveOpen(id,targets[id]); return; }
    targets[id].topics.forEach(function(topic){ if(s.wanted.indexOf(topic)<0)s.wanted.push(topic); liveJoin(s,topic); });
  });
}
function liveStop(){
  Object.keys(live.sockets).forEach(function(id){
    const s=live.sockets[id]; delete live.sockets[id];
    clearInterval(s.hb); clearTimeout(s.retry);
    try{ s.ws&&s.ws.close(); }catch(e){}
  });
}
// The phone suspends sockets in the background: coming back reconnects straight away instead of after the backoff.
document.addEventListener('visibilitychange',function(){
  if(document.hidden||!syncEnabled())return;
  if(!liveAllUp()){ liveStop(); liveStart(); }
});
window.__syncNow=syncNow; // debugging hook
