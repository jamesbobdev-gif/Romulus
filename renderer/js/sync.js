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
  ['work','agent','school'].forEach(function(k){ const p=raw[k]; if(p&&p.url&&p.syncKey&&!p.derived)out[k]=p; });
  const p=out.personal;
  if(p&&p.url&&p.key&&p.syncKey)['work','agent','school'].forEach(function(k){ if(!out[k])out[k]={url:p.url,key:p.key,syncKey:deriveSyncKey(p.syncKey,k),derived:true}; });
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
// the Agent tab can be used here: this computer runs the agent itself (sync only shares the list with
// the phone), while the phone needs the synced list to reach it
function agentAvailable(){ return agentConfigured()||!!(window.desktop&&window.desktop.aiStatus); }
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
/* Every read and write goes through a database function that needs the list's sync key (sync_get,
   sync_put, sync_set: supabase/migrations/20261021_sync_rpc_lockdown.sql). The table itself is closed to
   the anon key, so the key in the app can't list or touch anything but what it knows the key of. */
async function syncRpc(p,fn,body){
  const res=await fetch(p.url.replace(/\/+$/,'')+'/rest/v1/rpc/'+fn,{method:'POST',headers:syncHeaders(p),body:JSON.stringify(body)});
  if(!res.ok)throw new Error('HTTP '+res.status);
  return res.json();
}
function setSyncStatus(msg,isErr){
  const n=document.getElementById('syncStatus');
  if(n){ n.textContent=msg; n.style.color=isErr?'var(--late)':'var(--muted)'; }
}

// The list plus when it was last written, so our upload can check nobody wrote in between.
// Also learns the list's live-update channel (liveTopics), which only the database knows.
async function syncPullRow(p){
  const rows=await syncRpc(p,'sync_get',{p_sync_key:p.syncKey});
  const r=rows[0]||{};
  if(r.topic)noteTopic(p,r.topic);
  return {doc:r.doc||null,updatedAt:r.updated_at||null};
}
async function syncPull(p){ return (await syncPullRow(p)).doc; }
// Compare-and-swap upload: replaces the list only if it's still the version we downloaded (or creates
// it if there was none). false = someone else (phone, Claude, the connector) wrote in between.
async function syncPushCas(p,doc,prevUpdatedAt){
  return (await syncRpc(p,'sync_put',{p_sync_key:p.syncKey,p_doc:doc,p_prev:prevUpdatedAt||null}))===true;
}
async function syncPushDoc(p,doc){
  if((await syncRpc(p,'sync_set',{p_sync_key:p.syncKey,p_doc:doc}))!==true)throw new Error('not saved');
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
  else{
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
    if(liveAllUp()&&Date.now()-(syncState.lastAt||0)<5*60000)return;
    syncNow();
  },30000);
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
