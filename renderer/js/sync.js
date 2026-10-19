/* Storage, the custom theme CSS, and device sync (Supabase, per-task last-write-wins).
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── storage ── */
const KEY = 'tasks.v1';
const store = {
  async load(){
    try{
      if(window.desktop){ const r=await window.desktop.load(); return r?JSON.parse(r):null; }
      if(window.storage){ const r=await window.storage.get(KEY); return(r&&r.value)?JSON.parse(r.value):null; }
      const r=localStorage.getItem(KEY); return r?JSON.parse(r):null;
    }catch(e){ return null; }
  },
  async save(data){
    const raw=JSON.stringify(data);
    try{
      if(window.desktop){ await window.desktop.save(raw); }
      else if(window.storage){ await window.storage.set(KEY,raw); }
      else { localStorage.setItem(KEY,raw); }
    }catch(e){ console.error('save failed',e); }
  }
};

/* ── custom theme CSS ── */
const THEME_KEY='tasks.theme.v1';
const themeStyle=document.createElement('style');
document.head.appendChild(themeStyle);
function applyTheme(css){ themeStyle.textContent=css||''; }
try{ applyTheme(localStorage.getItem(THEME_KEY)||''); }catch(e){}

/* ── device sync (Supabase-backed, per-task last-write-wins) ──
   Supports two independent channels ("workspaces"): personal and work.
   Each syncs with its own Supabase project; the remote docs never contain
   the ws field, so other devices/apps on a channel need no changes. */
const SYNC_CFG_KEY='tasks.sync.v1';
const syncState={ cfg:null, busy:false, again:false, pushTimer:null, pollTimer:null };
function normalizeSyncCfg(raw){
  if(!raw)return null;
  if(raw.url)return {personal:raw}; // legacy single-profile shape
  const out={};
  if(raw.personal&&raw.personal.url)out.personal=raw.personal;
  if(raw.work&&raw.work.url)out.work=raw.work;
  if(raw.agent&&raw.agent.url)out.agent=raw.agent;
  if(raw.school&&raw.school.url)out.school=raw.school;
  return (out.personal||out.work)?out:null;
}
try{ syncState.cfg=normalizeSyncCfg(JSON.parse(localStorage.getItem(SYNC_CFG_KEY))); }catch(e){}

function validProfile(p){ return !!(p&&p.url&&p.key&&p.syncKey); }
function profileList(){
  const c=syncState.cfg||{}; const out=[];
  if(validProfile(c.personal))out.push('personal');
  if(validProfile(c.work))out.push('work');
  if(validProfile(c.agent))out.push('agent');
  if(validProfile(c.school))out.push('school');
  return out;
}
function syncEnabled(){ return profileList().length>0; }
function workConfigured(){ return !!(syncState.cfg&&validProfile(syncState.cfg.work)); }
function agentConfigured(){ return !!(syncState.cfg&&validProfile(syncState.cfg.agent)); }
function schoolConfigured(){ return !!(syncState.cfg&&validProfile(syncState.cfg.school)); }
// "agent" is a third channel: tasks Claude works on by itself. Only it carries
// the status/note fields — personal/work docs keep the old shape so older
// builds (office app) never see fields they would drop.
function taskWs(t){ return t.ws==='work'?'work':t.ws==='agent'?'agent':t.ws==='school'?'school':'personal'; }
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
  if(tab==='agent')return ws==='agent';
  if(tab==='school')return ws==='school';
  if(tab==='work')return ws==='work';
  return ws==='personal'||ws==='work'||(ws==='school'&&schoolSurfaced(t));
}
function syncHeaders(p){ return {'apikey':p.key,'Authorization':'Bearer '+p.key,'Content-Type':'application/json'}; }
function syncBase(p){ return p.url.replace(/\/+$/,'')+'/rest/v1/tasks_sync'; }
function setSyncStatus(msg,isErr){
  const n=document.getElementById('syncStatus');
  if(n){ n.textContent=msg; n.style.color=isErr?'var(--late)':'var(--muted)'; }
}

async function syncPull(p){
  const res=await fetch(syncBase(p)+'?sync_key=eq.'+encodeURIComponent(p.syncKey)+'&select=doc',{headers:syncHeaders(p)});
  if(!res.ok)throw new Error('HTTP '+res.status);
  const rows=await res.json();
  return rows.length?rows[0].doc:null;
}
// The list plus when it was last written, so our upload can check nobody wrote in between.
async function syncPullRow(p){
  const res=await fetch(syncBase(p)+'?sync_key=eq.'+encodeURIComponent(p.syncKey)+'&select=doc,updated_at',{headers:syncHeaders(p)});
  if(!res.ok)throw new Error('HTTP '+res.status);
  const rows=await res.json();
  return rows.length?{doc:rows[0].doc,updatedAt:rows[0].updated_at}:{doc:null,updatedAt:null};
}
// Compare-and-swap upload: replaces the list only if it's still the version we downloaded (or creates
// it if there was none). false = someone else (phone, Claude, the connector) wrote in between.
async function syncPushCas(p,doc,prevUpdatedAt){
  const body={doc:doc,updated_at:new Date().toISOString()};
  if(prevUpdatedAt==null){
    const res=await fetch(syncBase(p),{method:'POST',headers:Object.assign(syncHeaders(p),{'Prefer':'return=minimal'}),
      body:JSON.stringify([Object.assign({sync_key:p.syncKey},body)])});
    if(res.status===409)return false;
    if(!res.ok)throw new Error('HTTP '+res.status);
    return true;
  }
  const res=await fetch(syncBase(p)+'?sync_key=eq.'+encodeURIComponent(p.syncKey)+'&updated_at=eq.'+encodeURIComponent(prevUpdatedAt),
    {method:'PATCH',headers:Object.assign(syncHeaders(p),{'Prefer':'return=representation'}),body:JSON.stringify(body)});
  if(!res.ok)throw new Error('HTTP '+res.status);
  return (await res.json()).length===1;
}
async function syncPushDoc(p,doc){
  const res=await fetch(syncBase(p),{
    method:'POST',
    headers:Object.assign(syncHeaders(p),{'Prefer':'resolution=merge-duplicates'}),
    body:JSON.stringify([{sync_key:p.syncKey,doc:doc,updated_at:new Date().toISOString()}])
  });
  if(!res.ok)throw new Error('HTTP '+res.status);
}

function canonTasks(tasks){
  return JSON.stringify(tasks.slice().sort(function(a,b){ return a.id<b.id?-1:1; }));
}
function stripWs(t){ const c=Object.assign({},t); delete c.ws; return c; }
// Doc pushed to a channel: only that workspace's tasks, without the ws field —
// remote docs stay compatible with devices that know nothing about workspaces.
function wsDoc(ws){
  return {v:1,tasks:state.tasks.filter(function(t){ return taskWs(t)===ws; }).map(stripWs),tombstones:state.tombstones};
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
  const others=state.tasks.filter(function(t){ return taskWs(t)!==ws; });
  const byId={};
  localWs.concat(rTasks).forEach(function(t){
    const prev=byId[t.id];
    if(!prev||(t.updatedAt||0)>(prev.updatedAt||0)){
      // a lane is only ever changed (switching), never removed: a newer copy that hasn't heard of it yet keeps it
      if(prev&&prev.lane&&!t.lane){ t=Object.assign({},t,{lane:prev.lane}); }
      byId[t.id]=t;
    } else if(t.lane&&!prev.lane){ byId[t.id]=Object.assign({},prev,{lane:t.lane}); }
  });
  const merged=[];
  Object.keys(byId).forEach(function(id){
    if(tombs[id]&&tombs[id]>=(byId[id].updatedAt||0))return;
    merged.push(byId[id]);
  });
  const cutoff=Date.now()-60*86400000; // drop tombstones older than 60 days
  const mergedTombs=Object.keys(tombs).filter(function(id){ return tombs[id]>cutoff; })
    .map(function(id){ return {id:id,deletedAt:tombs[id]}; });
  if(ws==='agent'){ // a task just turned "needs you" / "done" on another device: Claude answered
    const before={}; localWs.forEach(function(t){ before[t.id]=t.status; });
    if(merged.some(function(t){ return before[t.id]&&before[t.id]!==t.status&&(t.status==='needs-you'||t.status==='done'); }))buzz('answer');
  }
  const changedLocal=canonTasks(merged)!==canonTasks(localWs);
  const changedRemote=canonTasks(merged.map(stripWs))!==canonTasks(rTasksRaw)||mergedTombs.length!==rTombs.length;
  state.tasks=others.concat(merged);
  state.tombstones=mergedTombs;
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
  let firstErr=null, anyLocal=false;
  const list=profileList();
  for(let i=0;i<list.length;i++){
    const ws=list[i], p=syncState.cfg[ws];
    try{
      // download, merge, upload; if the list changed online in between (a task added from the phone
      // or by Claude), the upload is refused, so download again and merge that in too, never overwrite it
      for(let attempt=0;attempt<4;attempt++){
        const row=await syncPullRow(p);
        const r=mergeRemoteWs(row.doc,ws);
        if(r.changedLocal)anyLocal=true;
        if(!(r.changedRemote||!row.doc))break;
        if(await syncPushCas(p,wsDoc(ws),row.updatedAt))break;
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
        if(attempt===3)throw new Error('the ideas board kept changing; will retry');
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
  if(anyLocal){
    rebuildSnap();
    store.save(currentDoc());
    renderActive();
    if(spawnMissedRecurs())touch(); // ticked off on a device or by a tool that doesn't make the next one
  }
  if(firstErr)setSyncStatus('sync error: '+firstErr.message,true);
  else setSyncStatus('synced '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));
}
function schedulePush(){
  if(!syncEnabled())return;
  clearTimeout(syncState.pushTimer);
  syncState.pushTimer=setTimeout(syncNow,2500);
}
function startSyncLoop(){
  clearInterval(syncState.pollTimer);
  if(!syncEnabled())return;
  syncState.pollTimer=setInterval(syncNow,30000);
  syncNow();
}
window.__syncNow=syncNow; // debugging hook
