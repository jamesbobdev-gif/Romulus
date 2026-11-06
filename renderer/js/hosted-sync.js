/* Romulus sync: the project an official build ships with (window.ROMULUS_PAIR, renderer/js/pair-server.js) is
   where a new install syncs from the first start, so nobody has to make a Supabase project to get their phone
   and computer talking. Each install gets its own random sync key and its lists go up end-to-end encrypted
   (sync-crypto.js): the database holds them only under a lookup id made from the key, sealed, and every table
   is closed to the app's key (row-level security, no policies); lists are reached only through functions that
   need the key. So one person's lists can't be found, read or changed by another, or read by whoever runs it.
   Each account has free_quota_bytes there (supabase/migrations/20261106_sync_paid_plan.sql). Past that, it can
   pay $5 a month for more (Stripe, ROMULUS_PAIR.pay) or move to a Supabase project of its own; this file shows
   that choice in Settings → Device sync. Loads after settings.js and pair-server.js, before init.js uses it. */
'use strict';

const HOSTED_OFF_KEY='tasks.syncHostedOff'; // he turned sync off or chose his own project: no auto start again
const HOSTED_SIDE_ROWS={personal:[':ideas',':hours',':devices'],agent:[':prefs',':locked',':routing',':standing'],work:[],school:[]};
function hostedServer(){ const p=typeof window!=='undefined'&&window.ROMULUS_PAIR; return p&&p.url&&p.key?p:null; }
function hostedTrim(u){ return String(u||'').trim().replace(/\/+$/,''); }
// a build from an app store (window.ROMULUS_STORE, set per Android flavor): the stores want their own billing for
// a subscription bought inside the app, so the $5 plan isn't offered there. Paying on a computer still covers it.
function hostedInStore(){ const s=typeof window!=='undefined'&&window.ROMULUS_STORE; return !!(s&&s!=='github'); }
function hostedCanPay(h){ return !!(h&&h.pay&&!hostedInStore()); }
function hostedIs(url){ const h=hostedServer(); return !!(h&&url&&hostedTrim(h.url)===hostedTrim(url)); }
function hostedOptedOut(){ try{ return localStorage.getItem(HOSTED_OFF_KEY)==='1'; }catch(e){ return false; } }
function hostedSetOptOut(on){ try{ if(on)localStorage.setItem(HOSTED_OFF_KEY,'1'); else localStorage.removeItem(HOSTED_OFF_KEY); }catch(e){} }
// every plain key a device could look for these lists under (pure, for tests)
function hostedMarkerKeys(sk){
  const out=[];
  ['personal','work','agent','school'].forEach(function(ws){
    const base=ws==='personal'?sk:deriveSyncKey(sk,ws);
    [''].concat(HOSTED_SIDE_ROWS[ws]).forEach(function(sfx){ out.push(base+sfx); });
  });
  return out;
}
// the account id the database counts space by (sync_account_of in setup.sql): sha256 of the row key's id part
async function hostedAccountId(rowKey){
  const id=String(rowKey).replace(/^tk_(work_|agent_|school_)?/,'').replace(/:.*$/,'');
  const h=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id));
  return Array.from(new Uint8Array(h),function(b){ return b.toString(16).padStart(2,'0'); }).join('');
}

/* A fresh encrypted setup on the Romulus project. {moved:'v2'} goes under every plain key first: a device
   paired later (or an older build) that looks there switches to the encrypted lists (syncAdoptV2) and the
   database refuses anything but that marker under those keys, so the lists never go up in the clear. */
async function hostedStart(){
  const h=hostedServer();
  if(!h||!syncCryptoOk())return false;
  const sk=newSyncKey();
  const p={url:h.url,key:h.key};
  for(const k of hostedMarkerKeys(sk)){
    // a side row the database doesn't know yet (an older setup.sql) can't be written in the clear either: only a list's own key has to take it
    if((await syncRpc(p,'sync_set',{p_sync_key:k,p_doc:{moved:'v2'}}))!==true&&k.indexOf(':')===-1){
      const why=await syncRefusal(Object.assign({syncKey:k,v2:false},p));
      throw new Error(why||'the sync server said no');
    }
  }
  syncState.cfg=normalizeSyncCfg({personal:{url:h.url,key:h.key,syncKey:sk,v2:true}});
  await syncCfgPersist(syncState.cfg);
  hostedSetOptOut(false);
  return true;
}
// first start: nothing syncs, this build has a Romulus project, and he hasn't turned it off → sync there
async function hostedAutoStart(){
  if(syncState.cfg||hostedOptedOut()||!hostedServer())return false;
  try{ return await hostedStart(); }catch(e){ return false; } // offline: the next start tries again
}

function hostedMb(b){ b=Number(b)||0; return b>=1024*1024*1024?(b/1024/1024/1024).toFixed(b%(1024*1024*1024)?1:0)+' GB':b>=1024*1024?(b/1024/1024).toFixed(1).replace(/\.0$/,'')+' MB':Math.max(1,Math.round(b/1024))+' KB'; }
// what the box says (pure, for tests): u = sync_usage's row
/* How the plan is offered (pure, for tests): family and history first, storage last, since people can picture
   sharing lists with a partner or undoing a bad day, not 600 MB. h.trialDays (repository variable PAY_TRIAL_DAYS)
   says the Stripe links start with that many free days; only then does it say so. */
function hostedPlanPitch(h){
  const days=Math.max(0,Math.floor(Number(h&&h.trialDays)||0));
  const pitch='The family plan: share Romulus with up to 4 more people, with a family list you all keep together (groceries, chores, a trip) and private lists of your own, and undo a bad day with 30 days of history. You also get new versions early, and 600 MB of storage instead of 5 MB.';
  return days?{
    button:'Try the family plan free for '+days+' days',
    year:'or $50 a year',
    pitch:pitch+' Free for '+days+' days, then $5 a month. Cancel before the trial ends and you pay nothing.'
  }:{
    button:'Family plan: $5 a month for up to 5 people',
    year:'or $50 a year',
    pitch:pitch
  };
}
function hostedPlanText(u,hasPay){
  if(!u)return {line:'',full:false};
  const used=Number(u.used_bytes)||0, quota=Number(u.quota_bytes)||0;
  const paid=!!u.paid_until;
  const full=u.refused==='full'||(quota>0&&used>=quota*0.9);
  let line='Using '+hostedMb(used)+' of '+hostedMb(quota)+(paid?' (paid until '+new Date(u.paid_until).toLocaleDateString(undefined,{month:'short',day:'numeric'})+').':' free.');
  if(full&&!paid)line+=' Your lists have nearly outgrown the free space. '+(hasPay?'Keep syncing here for $5 a month ('+hostedMb(u.paid_quota_bytes)+'), or move':'Move')+' to a Supabase project of your own: free up to 500 MB, or Pro at $25 a month.';
  if(paid&&Number(u.history_bytes))line+=' History uses '+hostedMb(u.history_bytes)+' more.';
  return {line:line,full:full&&!paid};
}

/* Restore a list as it was at the end of a day (the $5 plan's 30 days of history; the copies come from
   sync_history_get). Pure, for tests: the tasks of that list become the day's copy, stamped now so they win on
   every device, and whatever it has now that the copy hadn't gets a tombstone, so it goes everywhere too. */
function hostedRestorePlan(tasks,tombstones,ws,snap,now){
  const wsOf=function(t){ return t.ws==='work'||t.ws==='agent'||t.ws==='school'?t.ws:'personal'; };
  const back={}; snap.forEach(function(t){ back[t.id]=1; });
  const outTombs=tombstones.filter(function(x){ return !back[x.id]; });
  const out=[];
  tasks.forEach(function(t){
    if(back[t.id])return; // the day's copy takes its place (and from another list it moved to since)
    if(wsOf(t)===ws){ outTombs.push({id:t.id,deletedAt:now}); return; }
    out.push(t);
  });
  snap.forEach(function(t){ const c=Object.assign({},t,{ws:ws,updatedAt:now}); if(!Array.isArray(c.subs))c.subs=[]; out.push(c); });
  return {tasks:out,tombstones:outTombs};
}
function hostedDayLabel(day){ // '2026-11-03' → 'Tue, Nov 3'
  const p=String(day).split('-').map(Number);
  return new Date(p[0],p[1]-1,p[2]).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
}
const HOSTED_FAMILY_WHY={not_paid:'only the person paying for the plan can invite',family_full:'the plan already covers 4 more people',bad:'that didn’t work',rate:'too many tries from this network; try again in an hour',no_code:'that code isn’t right, or it’s over 2 days old',no_account:'sync hasn’t started on this device yet; try again in a minute',own:'that’s your own code: give it to the person you want on your plan'};

/* Delete my synced data: everything this install's lists keep on the Romulus server goes (rows, photos and
   files, a paid plan), through supabase/functions/sync-delete. What it sends, pure for tests: every key the
   server could hold a row of these lists under (the plain keys, where the moved markers are, and the encrypted
   lookup ids) and the agent keys, whose hash names the storage folders. Only lists on the Romulus server. */
async function hostedDeleteBody(cfg,rowKeyOf){
  const keys=[], agentKeys=[];
  for(const ws of ['personal','work','agent','school']){
    const p=cfg&&cfg[ws]; if(!p||!p.syncKey||!hostedIs(p.url))continue;
    [p.syncKey,await rowKeyOf(p)].forEach(function(k){ k=String(k||'').replace(/:.*$/,''); if(k&&keys.indexOf(k)===-1)keys.push(k); });
    if(ws==='agent'&&agentKeys.indexOf(p.syncKey)===-1)agentKeys.push(p.syncKey);
  }
  return {keys:keys,agentKeys:agentKeys};
}
async function hostedDeleteAll(){
  const h=hostedServer(); if(!h)throw new Error('this build has no Romulus server');
  const body=await hostedDeleteBody(syncState.cfg,syncRowKey);
  if(!body.keys.length)throw new Error('nothing of yours is on the Romulus server');
  const res=await fetch(hostedTrim(h.url)+'/functions/v1/sync-delete',{method:'POST',headers:syncHeaders({key:h.key}),body:JSON.stringify(body)});
  let out=null; try{ out=await res.json(); }catch(e){}
  if(!res.ok||!out||!out.ok)throw new Error((out&&out.error)||('HTTP '+res.status));
  return out;
}

if(typeof document!=='undefined'&&document.getElementById('hostedBox')){
  const box=$('hostedBox'), info=$('hostedInfo'), payBtn=$('hostedPayBtn'), ownBtn=$('hostedOwnBtn'), backBtn=$('hostedBackBtn'), delBtn=$('hostedDeleteBtn');
  const draw=async function(){
    const h=hostedServer(), c=syncState.cfg, p=c&&c.personal;
    if(!h){ box.hidden=true; return; }
    box.hidden=false;
    const on=validProfile(p)&&hostedIs(p.url);
    ownBtn.hidden=!on; backBtn.hidden=on; delBtn.hidden=!on;
    if(!on){
      planBox.hidden=famBox.hidden=histBox.hidden=earlyRow.hidden=supporters.hidden=true;
      if(typeof familyDraw==='function')familyDraw('');
      info.textContent=validProfile(p)?'Your lists sync through your own Supabase project.':'Sync is off on this device.';
      return;
    }
    info.textContent='Your lists sync through the Romulus server, end-to-end encrypted: only your devices can read them, not other people on it and not whoever runs it.';
    let u=null; try{ u=(await syncRpc(p,'sync_usage',{p_sync_key:await syncRowKey(p)}))[0]; }catch(e){}
    if(syncState.cfg!==c)return;
    const t=hostedPlanText(u,hostedCanPay(h));
    if(t.line)info.textContent+=' '+t.line;
    const paid=!!(u&&u.paid_until);
    // the plan is on offer the whole time someone is on the free space, not only once it's nearly full
    planBox.hidden=!u||paid;
    payBtn.hidden=!hostedCanPay(h);
    const words=hostedPlanPitch(h);
    $('hostedPitch').textContent=words.pitch; payBtn.textContent=words.button; payYearBtn.textContent=words.year;
    payYearBtn.hidden=!(hostedCanPay(h)&&h.payYear);
    // at 90% of the free space the two ways on sit side by side: pay for more, or move to a project of one's own
    planOwnBtn.hidden=!t.full;
    drawFamily(p,c);
    drawHistory(p,c,paid);
    drawEarly(paid);
    drawSupporters(p,c);
  };
  const planBox=$('hostedPlan'), payYearBtn=$('hostedPayYearBtn'), joinBtn=$('hostedJoinBtn'), planOwnBtn=$('hostedPlanOwnBtn');
  const famBox=$('hostedFamily'), famInfo=$('hostedFamilyInfo'), famList=$('hostedFamilyList'), inviteBtn=$('hostedInviteBtn'), leaveBtn=$('hostedLeaveBtn');
  const histBox=$('hostedHistory'), histDay=$('hostedHistoryDay'), restoreBtn=$('hostedRestoreBtn');
  const earlyRow=$('hostedEarlyRow'), early=$('hostedEarly'), supporters=$('hostedSupporters');
  const rowKey=async function(){ const p=syncState.cfg&&syncState.cfg.personal; return validProfile(p)&&hostedIs(p.url)?{p:p,rk:await syncRowKey(p)}:null; };
  async function drawFamily(p,c){
    let rows=[]; try{ rows=await syncRpc(p,'sync_family_list',{p_sync_key:await syncRowKey(p)}); }catch(e){ famBox.hidden=true; return; }
    if(syncState.cfg!==c)return;
    const role=rows[0]&&rows[0].role;
    famBox.hidden=!role; inviteBtn.hidden=role!=='payer'; leaveBtn.hidden=role!=='member';
    famList.textContent='';
    if(typeof familyDraw==='function')familyDraw(role||''); // the family list (family-list.js)
    if(role==='member'){ famInfo.textContent='Your $5 plan comes from someone’s family plan.'; return; }
    if(role!=='payer')return;
    const members=rows.filter(function(r){ return r.member; });
    famInfo.textContent=members.length?'Your plan covers '+members.length+' more '+(members.length===1?'person':'people')+' (up to 4).':'Your plan can cover up to 4 more people. Invite someone: they type the code into their own app.';
    members.forEach(function(m,i){
      const row=document.createElement('div'); row.className='settings-row'; row.style.alignItems='center';
      const s=document.createElement('span'); s.className='settings-hint'; s.style.margin='0';
      s.textContent='Person '+(i+1)+(m.since?', joined '+new Date(m.since).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'');
      const b=document.createElement('button'); b.className='ghost mono'; b.textContent='Take off';
      b.addEventListener('click',async function(){
        const shared=typeof familyConfigured==='function'&&familyConfigured();
        if(!confirm('Take this person off your plan? They go back to the free space; nothing of theirs is deleted.'+(shared?'\n\nThe family list moves to a new key their devices don’t get, so nothing new reaches them. What they already synced stays on their devices: that can’t be taken back.':'')))return;
        const k=await rowKey(); if(!k)return;
        try{ await syncRpc(k.p,'sync_family_remove',{p_sync_key:k.rk,p_member:m.member}); }catch(e){ setSyncStatus('couldn’t: '+e.message,true); draw(); return; }
        if(shared){ familyState.lastRotate=0; await familyCheckStale(); }
        draw();
      });
      row.appendChild(s); row.appendChild(b); famList.appendChild(row);
    });
  }
  async function drawHistory(p,c,paid){
    if(!paid){ histBox.hidden=true; return; }
    let days=[]; try{ days=await syncRpc(p,'sync_history_days',{p_sync_key:await syncRowKey(p)}); }catch(e){}
    if(syncState.cfg!==c)return;
    histBox.hidden=false; histDay.textContent='';
    days.forEach(function(r){ const o=document.createElement('option'); o.value=r.day; o.textContent=hostedDayLabel(r.day); histDay.appendChild(o); });
    if(!days.length){ const o=document.createElement('option'); o.textContent='The first copy is kept today'; histDay.appendChild(o); }
    histDay.disabled=restoreBtn.disabled=!days.length;
  }
  function drawEarly(paid){
    const d=window.desktop;
    earlyRow.hidden=!(paid&&d&&d.updateGetEarly);
    if(!earlyRow.hidden)d.updateGetEarly().then(function(v){ early.checked=!!v; }).catch(function(){});
  }
  async function drawSupporters(p,c){
    let names=[]; try{ names=await syncRpc(p,'sync_supporters_list',{}); }catch(e){}
    if(syncState.cfg!==c)return;
    supporters.hidden=!names.length;
    const list=names.map(function(r){ return r.name; }).join(', ');
    supporters.textContent=names.length?'Thanks to the people keeping Romulus running: '+list+(/[.!?]$/.test(list)?'':'.'):'';
  }
  const openPay=async function(link){
    const h=hostedServer(), p=syncState.cfg&&syncState.cfg.personal; if(!hostedCanPay(h)||!link||!validProfile(p))return;
    // the link carries the account id, a hash of the key's lookup id: Stripe never sees the key
    const acct=await hostedAccountId(await syncRowKey(p));
    openOutside(link+(link.indexOf('?')===-1?'?':'&')+'client_reference_id='+acct);
    setSyncStatus('once the payment goes through, the plan turns on within a minute');
  };
  payBtn.addEventListener('click',function(){ const h=hostedServer(); openPay(h&&h.pay); });
  payYearBtn.addEventListener('click',function(){ const h=hostedServer(); openPay(h&&h.payYear); });
  planOwnBtn.addEventListener('click',function(){ ownBtn.click(); });
  joinBtn.addEventListener('click',async function(){
    const code=prompt('The family code someone with the $5 plan gave you:');
    if(!code||!code.trim())return;
    const k=await rowKey(); if(!k)return;
    try{
      const why=await syncRpc(k.p,'sync_family_join',{p_sync_key:k.rk,p_code:code.trim()});
      setSyncStatus(why?'couldn’t join: '+(HOSTED_FAMILY_WHY[why]||why):'you’re on the family plan now',!!why);
    }catch(e){ setSyncStatus('couldn’t join: '+e.message,true); }
    draw();
  });
  inviteBtn.addEventListener('click',async function(){
    const k=await rowKey(); if(!k)return;
    try{
      const r=(await syncRpc(k.p,'sync_family_invite',{p_sync_key:k.rk}))[0]||{};
      if(r.why){ setSyncStatus('couldn’t make a code: '+(HOSTED_FAMILY_WHY[r.why]||r.why),true); return; }
      famInfo.textContent='Their code: '+r.code+'. In their own Romulus app: Settings → Device sync → I have a family code. It works once, for 2 days.';
      setSyncStatus('family code made');
    }catch(e){ setSyncStatus('couldn’t make a code: '+e.message,true); }
  });
  leaveBtn.addEventListener('click',async function(){
    const shared=typeof familyConfigured==='function'&&familyConfigured();
    if(!confirm('Leave the family plan? You go back to the free space; nothing of yours is deleted.'+(shared?'\n\nThe family list leaves this device too; everyone else keeps it.':'')))return;
    const k=await rowKey(); if(!k)return;
    try{
      await syncRpc(k.p,'sync_family_remove',{p_sync_key:k.rk,p_member:null});
      if(shared)await familyDropHere();
      setSyncStatus('you left the family plan');
    }catch(e){ setSyncStatus('couldn’t: '+e.message,true); }
    draw();
  });
  restoreBtn.addEventListener('click',async function(){
    const day=histDay.value; if(!day)return;
    if(!confirm('Restore your lists as they were at the end of '+hostedDayLabel(day)+'?\n\nEvery device gets that day’s tasks back, and tasks added since then are removed. The Agent list isn’t touched.'))return;
    restoreBtn.disabled=true; setSyncStatus('restoring…');
    try{
      const c=syncState.cfg, now=Date.now(); let n=0;
      for(const ws of ['personal','work','school']){
        const p=c[ws]; if(!validProfile(p)||!hostedIs(p.url))continue;
        const doc=await syncRpc(p,'sync_history_get',{p_sync_key:await syncRowKey(p),p_day:day});
        if(!doc)continue;
        const plain=syncIsSealed(doc)?await syncOpen(p.syncKey,doc):doc;
        const r=hostedRestorePlan(state.tasks,state.tombstones,ws,Array.isArray(plain&&plain.tasks)?plain.tasks:[],now);
        state.tasks=r.tasks; state.tombstones=r.tombstones; n++;
      }
      if(!n)throw new Error('no copy of that day');
      rebuildSnap(); store.save(currentDoc()); renderActive(); syncNow();
      setSyncStatus('restored to '+hostedDayLabel(day)+'; your other devices follow on their next sync');
    }catch(e){ setSyncStatus('couldn’t restore: '+e.message,true); }
    finally{ restoreBtn.disabled=false; }
  });
  early.addEventListener('change',function(){
    const d=window.desktop; if(d&&d.updateSetEarly)d.updateSetEarly(early.checked).then(function(v){ early.checked=!!v; }).catch(function(){});
  });
  ownBtn.addEventListener('click',function(){
    // the same sync key, a different project: Save & sync uploads this device's lists there
    $('syncManual').open=true; $('syncFirstSteps').hidden=false;
    $('syncUrl').value=''; $('syncAnonKey').value='';
    $('syncUrl').focus();
    setSyncStatus('follow the steps below, then Save & sync. Your other devices follow on their next sync.');
  });
  backBtn.addEventListener('click',async function(){
    if(!confirm('Sync through the Romulus server instead?\n\nThis device starts fresh there with a new sync key, encrypted, and uploads its lists. Your other devices keep using your own project until you pair them again.'))return;
    backBtn.disabled=true; setSyncStatus('moving to the Romulus server…');
    try{
      clearInterval(syncState.pollTimer); clearTimeout(syncState.pushTimer);
      const prev=syncState.cfg; syncState.cfg=null;
      try{ await hostedStart(); }catch(e){ syncState.cfg=prev; throw e; }
      syncState.docs={}; syncFillForm(); render(); startSyncLoop(); draw();
      setSyncStatus('syncing through the Romulus server');
    }catch(e){ setSyncStatus('couldn’t move: '+e.message,true); }
    finally{ backBtn.disabled=false; }
  });
  delBtn.addEventListener('click',async function(){
    if(!confirm('Delete your synced data from the Romulus server?\n\nYour lists, photos and files there are deleted for good, and a $5 plan is cancelled. Sync turns off on this device; the lists stay on it.\n\nTurn sync off on your other devices first, or they will upload their copy again.'))return;
    delBtn.disabled=true; setSyncStatus('deleting your synced data…');
    try{
      const out=await hostedDeleteAll();
      $('syncOffBtn').click(); // sync off here, and no starting on the Romulus server by itself again
      setSyncStatus(out.cancelled?'deleted from the Romulus server. Your lists are still on this device.':'deleted from the Romulus server, but the $5 plan couldn’t be cancelled from here: cancel it from your Stripe receipt email.',!out.cancelled);
    }catch(e){ setSyncStatus('couldn’t delete: '+e.message,true); }
    finally{ delBtn.disabled=false; draw(); }
  });
  // Turn off, or Save & sync on another project: no starting on the Romulus server by itself again
  $('syncOffBtn').addEventListener('click',function(){ hostedSetOptOut(true); setTimeout(draw,0); });
  $('syncSaveBtn').addEventListener('click',function(){ setTimeout(draw,0); }); // the opt-out is set by Save & sync itself, once the switch happened (settings.js)
  $('syncSection').addEventListener('toggle',function(){ if(this.open)draw(); });
  window.hostedDraw=draw; // Save & sync redraws this once its switch is done (settings.js)
  if(hostedServer())SYNC_REFUSED.full='sync paused: your free online space is full. Your lists are safe on this device. Settings → Device sync has the options.';
}

if(typeof module!=='undefined')module.exports={hostedMarkerKeys,hostedPlanPitch,hostedPlanText,hostedRestorePlan,hostedDayLabel,hostedIs,hostedMb,hostedInStore,hostedCanPay,hostedDeleteBody};
