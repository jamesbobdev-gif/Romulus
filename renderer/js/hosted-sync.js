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
const HOSTED_SIDE_ROWS={personal:[':ideas',':hours',':kitchen',':devices'],agent:[':prefs',':locked',':routing',':standing'],work:[],school:[]};
function hostedServer(){ const p=typeof window!=='undefined'&&window.ROMULUS_PAIR; return p&&p.url&&p.key?p:null; }
function hostedTrim(u){ return String(u||'').trim().replace(/\/+$/,''); }
// a build from an app store (window.ROMULUS_STORE, set per Android flavor): the stores want their own billing for
// a subscription bought inside the app, so the paid plans aren't offered there. Paying on a computer still covers it.
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
/* {moved:'v2'} under every plain key of these lists on project p ({url,key}): a device paired later (or an older
   build) that looks there switches to the encrypted lists (syncAdoptV2), and the database refuses anything but
   that marker under those keys. Used for a fresh start here, and when the lists move to a project of one's own
   (settings.js), so moving never turns the encryption off. */
async function hostedSealMarkers(p,sk){
  for(const k of hostedMarkerKeys(sk)){
    // a side row the database doesn't know yet (an older setup.sql) can't be written in the clear either: only a list's own key has to take it
    if((await syncRpc(p,'sync_set',{p_sync_key:k,p_doc:{moved:'v2'}}))!==true&&k.indexOf(':')===-1){
      const why=await syncRefusal(Object.assign({syncKey:k,v2:false},p));
      throw new Error(why||'the sync server said no');
    }
  }
}
async function hostedStart(){
  const h=hostedServer();
  if(!h||!syncCryptoOk())return false;
  const sk=newSyncKey();
  await hostedSealMarkers({url:h.url,key:h.key},sk);
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
/* How the plans are offered (pure, for tests): the Group plan first, sharing before storage, since people can
   picture sharing lists with a partner, not 600 MB. With Personal links set (repository variables
   PAY_PERSONAL_URL / PAY_PERSONAL_YEAR_URL) there are two plans, Group $6 and Personal $4, close enough that
   Group is the plain pick; without them only Group is offered, at the $5 the existing links charge.
   h.trialDays (PAY_TRIAL_DAYS) says the Stripe links start with that many free days; only then does it say so.
   Nothing the app does needs a plan: grocery runs, the Agent, sync and the free group of two all stay free. */
function hostedPrices(h){
  return h&&h.payPersonal?{group:6,groupYear:60,personal:4,personalYear:40}:{group:5,groupYear:50,personal:null,personalYear:null};
}
function hostedPlanPitch(h){
  const days=Math.max(0,Math.floor(Number(h&&h.trialDays)||0)), pr=hostedPrices(h);
  let pitch='The Group plan: share lists and send each other to-dos with up to 4 more people, and each of them gets the paid space too. Everyone keeps their own private lists. You also get 30 days of history, new versions early, and 600 MB for photos and files instead of 50 MB.';
  if(pr.personal)pitch+=' Just you? The Personal plan is $'+pr.personal+' a month, with the same space and history.';
  const out=days?{
    button:'Try the Group plan free for '+days+' days',
    year:'Pay yearly: 2 months free',
    pitch:pitch+' Free for '+days+' days, then $'+pr.group+' a month. Cancel before the trial ends and you pay nothing.'
  }:{
    button:'Group plan: $'+pr.group+' a month for up to 5 people',
    year:'Pay yearly: 2 months free',
    pitch:pitch
  };
  out.personal=pr.personal?'Personal: $'+pr.personal+' a month':null;
  out.personalYear=pr.personal&&h.payPersonalYear?'Personal yearly: $'+pr.personalYear:null;
  return out;
}
function hostedPlanText(u,hasPay){
  if(!u)return {line:'',full:false};
  const used=Number(u.used_bytes)||0, quota=Number(u.quota_bytes)||0;
  const paid=!!u.paid_until;
  const full=u.refused==='full'||(quota>0&&used>=quota*0.9);
  let line='Using '+hostedMb(used)+' of '+hostedMb(quota)+(paid?', paid until '+new Date(u.paid_until).toLocaleDateString(undefined,{month:'short',day:'numeric'})+'.':' free.');
  if(full&&!paid)line+=' Your lists have nearly outgrown the free space. '+(hasPay?'Keep syncing here with a plan ('+hostedMb(u.paid_quota_bytes)+'), or move':'Move')+' to a Supabase project of your own: free up to 500 MB, or Pro at $25 a month.';
  return {line:line,full:full&&!paid};
}

/* Someone who just got the plan sees fireworks once, on the device they were on the free space with. What this
   device last saw is kept (HOSTED_SEEN_KEY: 'free' or 'paid'); only free → paid celebrates, so a new device of
   someone already paying, or a restart, doesn't set them off again. Pure, for tests. */
const HOSTED_SEEN_KEY='tasks.hostedPlanSeen';
function hostedJustPaid(seen,paid){ return !!paid&&seen==='free'; }
/* The "Your plan" box in Settings, whatever someone is on (pure, for tests). status: 'free', 'payer' (pays for
   the family plan), 'member' (on someone else's family plan) or 'own' (their own Supabase project); u = sync_usage's
   row, for the sizes. */
function hostedMyPlanText(status,u){
  const freeMb=hostedMb(u&&!u.paid_until&&u.quota_bytes||5*1024*1024), paidMb=hostedMb(u&&u.paid_quota_bytes||600*1024*1024);
  if(status==='member')return {title:'Group plan',text:'Covered by the person who runs your group: '+paidMb+', 30 days of history.'};
  if(status==='member-free')return {title:'Free group',text:'You share lists and send to-dos with your group. Your own space: '+freeMb+'.'};
  if(status==='payer')return {title:'Group plan',text:paidMb+', 30 days of history, up to 4 more people. Thank you.'};
  if(status==='personal')return {title:'Personal plan',text:paidMb+', 30 days of history. Thank you.'};
  if(status==='own')return {title:'Your own Supabase',text:'Your lists sync through your own Supabase project.'};
  return {title:'Free plan',text:freeMb+' of space.'};
}

/* Fireworks over the whole window for a few seconds: a canvas that takes no clicks and removes itself.
   Someone who asked their system for less motion gets the message without the bursts. */
function hostedFireworks(message){
  if(typeof document==='undefined'||!document.body)return;
  const still=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wrap=document.createElement('div');
  wrap.style.cssText='position:fixed;inset:0;z-index:100000;pointer-events:none;display:flex;align-items:center;justify-content:center';
  const cv=document.createElement('canvas'); cv.style.cssText='position:absolute;inset:0;width:100%;height:100%';
  const note=document.createElement('div');
  note.style.cssText='position:relative;padding:14px 22px;border-radius:12px;background:var(--surface,#fff);color:var(--ink,#111);box-shadow:0 8px 30px rgba(0,0,0,.25);font-size:18px;font-weight:600;opacity:0;transition:opacity .4s';
  note.textContent=message||'';
  wrap.appendChild(cv); if(message)wrap.appendChild(note); document.body.appendChild(wrap);
  requestAnimationFrame(function(){ note.style.opacity='1'; });
  const end=function(){ note.style.opacity='0'; setTimeout(function(){ wrap.remove(); },450); };
  if(still){ setTimeout(end,2600); return; }
  const dpr=window.devicePixelRatio||1, ctx=cv.getContext('2d');
  const W=window.innerWidth, H=window.innerHeight; cv.width=W*dpr; cv.height=H*dpr; ctx.scale(dpr,dpr);
  const accent=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()||'#2742C8';
  const colors=[accent,'#F5B82E','#E8505B','#3CC47C','#9B6CF0','#FFFFFF'];
  const rockets=[], sparks=[], t0=performance.now(), LAUNCH_MS=3200;
  let nextLaunch=0, last=t0;
  // steps are in 60-per-second units, so a 144 Hz screen or a busy one plays it at the same speed
  const frame=function(now){
    const t=now-t0, k=Math.min(4,Math.max(0,(now-last)/16.67)); last=now;
    if(t<LAUNCH_MS&&t>=nextLaunch){
      rockets.push({x:W*(0.15+Math.random()*0.7),y:H,vx:(Math.random()-0.5)*1.5,vy:-Math.sqrt(2*0.18*H*(0.5+Math.random()*0.3)),c:colors[Math.floor(Math.random()*colors.length)]});
      nextLaunch=t+220+Math.random()*260;
    }
    ctx.clearRect(0,0,W,H);
    for(let i=rockets.length-1;i>=0;i--){
      const r=rockets[i]; r.x+=r.vx*k; r.y+=r.vy*k; r.vy+=0.18*k;
      ctx.fillStyle=r.c; ctx.fillRect(r.x-1.5,r.y-1.5,3,3);
      if(r.vy>=-1){
        rockets.splice(i,1);
        const n=60+Math.floor(Math.random()*30);
        for(let j=0;j<n;j++){ const a=Math.PI*2*j/n, s=2+Math.random()*3.5; sparks.push({x:r.x,y:r.y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life:1,c:Math.random()<0.75?r.c:colors[Math.floor(Math.random()*colors.length)]}); }
      }
    }
    for(let i=sparks.length-1;i>=0;i--){
      const s=sparks[i]; const drag=Math.pow(0.97,k); s.x+=s.vx*k; s.y+=s.vy*k; s.vx*=drag; s.vy=s.vy*drag+0.06*k; s.life-=0.014*k;
      if(s.life<=0){ sparks.splice(i,1); continue; }
      ctx.globalAlpha=s.life; ctx.fillStyle=s.c; ctx.beginPath(); ctx.arc(s.x,s.y,2.5,0,Math.PI*2); ctx.fill();
    }
    ctx.globalAlpha=1;
    if(t<LAUNCH_MS||rockets.length||sparks.length)requestAnimationFrame(frame); else end();
  };
  requestAnimationFrame(frame);
}

/* Restore a list as it was at the end of a day (the paid plans' 30 days of history; the copies come from
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
const HOSTED_FAMILY_WHY={not_paid:'only the person paying for the plan can invite',family_full:'the plan already covers 4 more people',free_full:'a free group is you and one other person: the Group plan makes room for 4 more',member:'you’re in someone else’s group: only the person who runs it invites',owner:'you run a group of your own, and someone can’t be in two',bad:'that didn’t work',rate:'too many tries from this network; try again in an hour',no_code:'that code isn’t right, or it’s over 2 days old',no_account:'sync hasn’t started on this device yet; try again in a minute',own:'that’s your own code: give it to the person you want on your plan'};

/* Delete my account: everything this install's lists keep on the Romulus server goes (rows, photos and
   files, a paid plan), through supabase/functions/sync-delete. What it sends, pure for tests: every key the
   server could hold a row of these lists under (the plain keys, where the moved markers are, and the encrypted
   lookup ids) and the agent keys, whose hash names the storage folders. Only lists on the Romulus server.
   sealedKeyOf: the personal key's lookup id, where the health totals sit sealed even when the lists are plain. */
async function hostedDeleteBody(cfg,rowKeyOf,sealedKeyOf){
  const keys=[], agentKeys=[];
  for(const ws of ['personal','work','agent','school']){
    const p=cfg&&cfg[ws]; if(!p||!p.syncKey||!hostedIs(p.url))continue;
    [p.syncKey,await rowKeyOf(p)].forEach(function(k){ k=String(k||'').replace(/:.*$/,''); if(k&&keys.indexOf(k)===-1)keys.push(k); });
    if(ws==='agent'&&agentKeys.indexOf(p.syncKey)===-1)agentKeys.push(p.syncKey);
  }
  const me=cfg&&cfg.personal;
  if(sealedKeyOf&&me&&me.syncKey&&hostedIs(me.url)){ const k=String(await sealedKeyOf(me.syncKey)||''); if(k&&keys.indexOf(k)===-1)keys.push(k); }
  return {keys:keys,agentKeys:agentKeys};
}
/* Deleting the account takes three clicks on its button and a long number shown on screen typed back in, so it
   can't happen by a slip. A fresh 16-digit number each time; typed with or without spaces. */
function hostedDeleteCode(rand){
  const b=new Uint32Array(16);
  if(rand)rand(b); else (globalThis.crypto||require('crypto').webcrypto).getRandomValues(b);
  let s=''; for(let i=0;i<16;i++)s+=String(b[i]%10);
  if(s[0]==='0')s='7'+s.slice(1); // reads as a number, not a code with a leading zero someone drops
  return s;
}
function hostedDeleteCodeShown(code){ return String(code).replace(/(\d{4})(?=\d)/g,'$1 '); }
function hostedDeleteCodeMatches(code,typed){ return !!code&&String(typed||'').replace(/\D/g,'')===String(code); }
// what the box says at each click: 1 = first click done, 2 = second click done (number up)
function hostedDeleteStepText(step){
  if(step===1)return {text:'Step 1 of 3. This deletes your account on the Romulus server: your lists, photos and files there, your group (people on it lose the plan you pay for), and a paid plan is cancelled. It can’t be undone. Your lists stay on this device. Turn sync off on your other devices first, or they will upload their copy again.',button:'Delete my account (2 of 3)'};
  if(step===2)return {text:'Step 2 of 3. Type the number below, then click the button a last time.',button:'Delete my account forever (3 of 3)'};
  return {text:'',button:'Delete my account'};
}
async function hostedDeleteAll(){
  const h=hostedServer(); if(!h)throw new Error('this build has no Romulus server');
  const body=await hostedDeleteBody(syncState.cfg,syncRowKey,syncCryptoOk()?syncV2RowKey:null);
  if(!body.keys.length)throw new Error('nothing of yours is on the Romulus server');
  const res=await fetch(hostedTrim(h.url)+'/functions/v1/sync-delete',{method:'POST',headers:syncHeaders({key:h.key}),body:JSON.stringify(body)});
  let out=null; try{ out=await res.json(); }catch(e){}
  if(!res.ok||!out||!out.ok)throw new Error((out&&out.error)||('HTTP '+res.status));
  return out;
}

if(typeof document!=='undefined'&&document.getElementById('hostedBox')){
  const box=$('hostedBox'), info=$('hostedInfo'), payBtn=$('hostedPayBtn'), ownBtn=$('hostedOwnBtn'), backBtn=$('hostedBackBtn'), delBtn=$('hostedDeleteBtn');
  const draw=window.hostedDraw=async function(){
    const h=hostedServer(), c=syncState.cfg, p=c&&c.personal;
    if(!h){ box.hidden=true; return; }
    box.hidden=false;
    const on=validProfile(p)&&hostedIs(p.url);
    ownBtn.hidden=!on; backBtn.hidden=on; delBtn.hidden=!on;
    if(!on&&window.hostedDeleteReset)window.hostedDeleteReset();
    if(!on){
      planBox.hidden=famBox.hidden=histBox.hidden=earlyRow.hidden=supporters.hidden=true;
      setMyPlan(validProfile(p)?'own':null,null);
      info.textContent=validProfile(p)?'Your lists sync through your own Supabase project.':'Sync is off on this device.';
      return;
    }
    info.textContent='End-to-end encrypted on the Romulus server.';
    let u=null; try{ u=(await syncRpc(p,'sync_usage',{p_sync_key:await syncRowKey(p)}))[0]; }catch(e){}
    if(syncState.cfg!==c)return;
    lastUsage=u;
    const t=hostedPlanText(u,hostedCanPay(h));
    if(t.line)info.textContent+=' '+t.line;
    const paid=!!(u&&u.paid_until);
    setMyPlan(u?(paid?'payer':'free'):null,u);
    if(u)hostedNoteSeen(paid);
    // the plan is on offer the whole time someone is on the free space, not only once it's nearly full
    planBox.hidden=!u||paid;
    payBtn.hidden=!hostedCanPay(h);
    const words=hostedPlanPitch(h);
    $('hostedPitch').textContent=words.pitch; payBtn.textContent=words.button; payYearBtn.textContent=words.year;
    payYearBtn.hidden=!(hostedCanPay(h)&&h.payYear);
    payPersonalBtn.textContent=words.personal||''; payPersonalBtn.hidden=!(hostedCanPay(h)&&words.personal);
    payPersonalYearBtn.textContent=words.personalYear||''; payPersonalYearBtn.hidden=!(hostedCanPay(h)&&words.personalYear);
    // at 90% of the free space the two ways on sit side by side: pay for more, or move to a project of one's own
    planOwnBtn.hidden=!t.full;
    drawFamily(p,c);
    drawHistory(p,c,paid);
    drawEarly(paid);
    drawSupporters(p,c);
  };
  let lastUsage=null;
  const myPlan=$('hostedMyPlan'), myPlanTitle=$('hostedMyPlanTitle'), myPlanInfo=$('hostedMyPlanInfo');
  // null: nothing known (sync off, or the server didn't answer), so the box stays out of the way
  function setMyPlan(status,u){
    myPlan.hidden=!status; if(!status)return;
    const w=hostedMyPlanText(status,u); myPlanTitle.textContent=w.title; myPlanInfo.textContent=w.text;
    nameRow.hidden=status!=='payer';
    if(status==='payer')drawName();
  }
  // the name on the thanks list (sync_supporter_name_get/set in supabase/migrations/20261112_sync_supporter_name.sql)
  const nameRow=$('hostedNameRow'), nameIn=$('hostedNameIn'), nameBtn=$('hostedNameBtn');
  async function drawName(){
    const k=await rowKey(); if(!k)return;
    let n=null; try{ n=await syncRpc(k.p,'sync_supporter_name_get',{p_sync_key:k.rk}); }catch(e){ nameRow.hidden=true; return; } // server without it yet
    if(document.activeElement!==nameIn)nameIn.value=n||'';
  }
  nameBtn.addEventListener('click',async function(){
    const k=await rowKey(); if(!k)return;
    const name=nameIn.value.trim();
    nameBtn.disabled=true;
    try{
      const why=await syncRpc(k.p,'sync_supporter_name_set',{p_sync_key:k.rk,p_name:name});
      setSyncStatus(why?'couldn’t save the name: '+(why==='not_paid'?'only someone paying for the plan can be on the list':'that didn’t work'):(name?'your name is on the thanks list':'you’re off the thanks list'),!!why);
    }catch(e){ setSyncStatus('couldn’t save the name: '+e.message,true); }
    finally{ nameBtn.disabled=false; draw(); }
  });
  nameIn.addEventListener('keydown',function(e){ if(e.key==='Enter')nameBtn.click(); });
  const payPersonalBtn=$('hostedPayPersonalBtn'), payPersonalYearBtn=$('hostedPayPersonalYearBtn');
  const planBox=$('hostedPlan'), payYearBtn=$('hostedPayYearBtn'), joinBtn=$('hostedJoinBtn'), planOwnBtn=$('hostedPlanOwnBtn');
  const famBox=$('hostedFamily'), famInfo=$('hostedFamilyInfo'), famList=$('hostedFamilyList'), inviteBtn=$('hostedInviteBtn'), leaveBtn=$('hostedLeaveBtn');
  const histBox=$('hostedHistory'), histDay=$('hostedHistoryDay'), restoreBtn=$('hostedRestoreBtn');
  const earlyRow=$('hostedEarlyRow'), early=$('hostedEarly'), supporters=$('hostedSupporters');
  const rowKey=async function(){ const p=syncState.cfg&&syncState.cfg.personal; return validProfile(p)&&hostedIs(p.url)?{p:p,rk:await syncRowKey(p)}:null; };
  /* Who is in the group, like the Devices list: the owner sees everyone with a Remove button; a member sees the
     group and can leave. Names come from the Group tab (each person's own name, with their account id, in the
     shared lists). Removing someone, or someone leaving, moves the shared lists to a new key (famRotate). */
  async function drawFamily(p,c){
    let rows=null;
    try{ rows=await syncRpc(p,'sync_family_list2',{p_sync_key:await syncRowKey(p)}); }
    catch(e){ if(!/HTTP 404/.test(e.message)){ famBox.hidden=true; return; } }
    if(!rows){ // a server without 20261115_sync_group_plans.sql: the old list, where only someone paying starts a group
      try{ rows=(await syncRpc(p,'sync_family_list',{p_sync_key:await syncRowKey(p)})).map(function(r){ return Object.assign({},r,{role:r.role==='payer'?'owner':r.role,room:4,plan:'group'}); }); }
      catch(e){ famBox.hidden=true; return; }
    }
    if(syncState.cfg!==c)return;
    const role=rows[0]&&rows[0].role;
    if(typeof famNoteRoster==='function')famNoteRoster(rows);
    famBox.hidden=!role; leaveBtn.hidden=role!=='member';
    famList.textContent='';
    if(role==='member'){
      famInfo.textContent='You’re in '+famOwnerName()+'’s group.';
      setMyPlan(rows[0].plan==='group'?'member':'member-free',lastUsage);
      famPeopleRows(famList,famRosterPeople(),null);
      inviteBtn.hidden=true; return;
    }
    if(role!=='owner')return;
    const members=rows.filter(function(r){ return r.member; }), room=Number(rows[0].room)||1;
    if(rows[0].plan==='personal')setMyPlan('personal',lastUsage);
    inviteBtn.hidden=members.length>=room;
    famInfo.textContent=room>=4?members.length+' of 4 spots used.'
      :members.length?'A free group is you and one other person. The Group plan makes room for 4 more, and covers their space.'
      :'Start a group for free with one other person: shared lists, like groceries, and sending each other to-dos.';
    famPeopleRows(famList,members,function(m){ famRemoveMember(m); });
  }
  function famOwnerName(){
    const o=typeof fam!=='undefined'?fam.doc.people.find(function(x){ return x.owner; }):null;
    return o&&o.name?o.name:'someone';
  }
  // the people on the Group tab's shared lists, for a member's view
  function famRosterPeople(){
    if(typeof fam==='undefined')return [];
    return fam.doc.people.filter(function(x){ return x.name; }).map(function(x){ return {name:x.name,me:x.id===fam.me,owner:!!x.owner}; });
  }
  // rows like the Devices list: the name, a line under it, then the button
  function famPeopleRows(list,people,onRemove){
    people.forEach(function(m){
      const row=document.createElement('div'); row.style.cssText='display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--hairline)';
      const txt=document.createElement('div'); txt.style.cssText='flex:1;min-width:0';
      const nm=document.createElement('div'); nm.style.cssText='color:var(--ink)';
      nm.textContent=m.name||famNameOfAccount(m.member)||'Someone who hasn’t opened the Group tab yet';
      if(m.me){ const t=document.createElement('span'); t.className='mono'; t.style.cssText='margin-left:8px;font-size:11px;color:var(--accent)'; t.textContent='you'; nm.appendChild(t); }
      const sub=document.createElement('div'); sub.className='mono'; sub.style.cssText='font-size:11px;color:var(--muted);margin-top:2px';
      sub.textContent=[m.owner?'runs the group':null,m.since?'joined '+new Date(m.since).toLocaleDateString(undefined,{month:'short',day:'numeric'}):null,
        m.member&&!m.pub?'on an older version: needs a new code if you remove someone':null].filter(Boolean).join(' · ');
      txt.append(nm,sub); row.appendChild(txt);
      if(onRemove){ const b=document.createElement('button'); b.className='ghost mono danger'; b.textContent='Remove'; b.addEventListener('click',function(){ onRemove(m); }); row.appendChild(b); }
      list.appendChild(row);
    });
  }
  function famNameOfAccount(acct){
    if(typeof fam==='undefined'||!acct)return null;
    const x=fam.doc.people.find(function(p){ return p.acct===acct; });
    return x&&x.name||null;
  }
  async function famRemoveMember(m){
    const who=famNameOfAccount(m.member)||'this person';
    if(!confirm('Remove '+who+' from your group?\n\nThe shared lists move to a new key they never get, so they stop seeing them (what is already on their device stays there). Their own lists aren’t touched'+(lastUsage&&lastUsage.paid_until?', and they go back to the free space.':'.')))return;
    const k=await rowKey(); if(!k)return;
    try{
      await syncRpc(k.p,'sync_family_remove',{p_sync_key:k.rk,p_member:m.member});
      const r=typeof famRotate==='function'?await famRotate(k.p,{force:true}):null;
      setSyncStatus(who+' is off your group'+(r&&r.left&&r.left.length?'. These people run an older version and need a new code to keep the shared lists: '+r.left.join(', '):''));
    }catch(e){ setSyncStatus('couldn’t: '+e.message,true); }
    draw();
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
  // free → paid on this device: fireworks, and Settings opened on the plan so it's plain what they have now
  function hostedNoteSeen(paid){
    let seen=null; try{ seen=localStorage.getItem(HOSTED_SEEN_KEY); }catch(e){}
    try{ localStorage.setItem(HOSTED_SEEN_KEY,paid?'paid':'free'); }catch(e){}
    if(!hostedJustPaid(seen,paid))return;
    hostedFireworks('Thank you for joining');
    setSyncStatus('your plan is on now. Thank you.');
    // Device sync opened, drawn with the plan, and "Your plan: Family" scrolled into view
    if(typeof openSettingsAt==='function')openSettingsAt(null,'syncSection');
    Promise.resolve(draw()).then(function(){ if(!myPlan.hidden)myPlan.scrollIntoView({block:'center',behavior:'smooth'}); }).catch(function(){});
  }
  // after the pay link opens, look every 20 seconds for 15 minutes for the payment to land (Stripe's webhook)
  let watchTimer=null;
  function watchForPlan(){
    clearInterval(watchTimer);
    const until=Date.now()+15*60*1000;
    watchTimer=setInterval(async function(){
      const p=syncState.cfg&&syncState.cfg.personal;
      if(Date.now()>until||!validProfile(p)||!hostedIs(p.url)){ clearInterval(watchTimer); return; }
      let u=null; try{ u=(await syncRpc(p,'sync_usage',{p_sync_key:await syncRowKey(p)}))[0]; }catch(e){ return; }
      if(u&&u.paid_until){ clearInterval(watchTimer); draw(); }
    },20000);
  }
  /* A look a little after start, for a payment made while the app was closed, then every 5 minutes while this
     device is on the free space, for one made on another device or a pay link opened elsewhere. */
  const lookForPlan=async function(){
    const p=syncState.cfg&&syncState.cfg.personal;
    if(!hostedServer()||!validProfile(p)||!hostedIs(p.url))return;
    let seen=null; try{ seen=localStorage.getItem(HOSTED_SEEN_KEY); }catch(e){}
    if(seen==='paid')return;
    let u=null; try{ u=(await syncRpc(p,'sync_usage',{p_sync_key:await syncRowKey(p)}))[0]; }catch(e){ return; }
    if(u)hostedNoteSeen(!!u.paid_until);
  };
  setTimeout(lookForPlan,8000);
  setInterval(lookForPlan,5*60*1000);
  const openPay=async function(link){
    const h=hostedServer(), p=syncState.cfg&&syncState.cfg.personal; if(!hostedCanPay(h)||!link||!validProfile(p))return;
    // the link carries the account id, a hash of the key's lookup id: Stripe never sees the key
    const acct=await hostedAccountId(await syncRowKey(p));
    openOutside(link+(link.indexOf('?')===-1?'?':'&')+'client_reference_id='+acct);
    setSyncStatus('once the payment goes through, the plan turns on within a minute');
    watchForPlan();
  };
  payBtn.addEventListener('click',function(){ const h=hostedServer(); openPay(h&&h.pay); });
  payYearBtn.addEventListener('click',function(){ const h=hostedServer(); openPay(h&&h.payYear); });
  payPersonalBtn.addEventListener('click',function(){ const h=hostedServer(); openPay(h&&h.payPersonal); });
  payPersonalYearBtn.addEventListener('click',function(){ const h=hostedServer(); openPay(h&&h.payPersonalYear); });
  planOwnBtn.addEventListener('click',function(){ ownBtn.click(); });
  // the same invite and join as the Group tab's buttons (family.js)
  joinBtn.addEventListener('click',function(){ famJoinPrompt(joinBtn,draw); });
  inviteBtn.addEventListener('click',async function(){
    const r=await famInviteMake();
    if(!r.code){ setSyncStatus(r.say,true); return; }
    famInfo.textContent=r.say+' ';
    famInfo.appendChild(famCopyButton(r.share));
  });
  leaveBtn.addEventListener('click',async function(){ if(await famLeave())draw(); });
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
  const delBox=$('hostedDeleteBox'), delStep=$('hostedDeleteStep'), delCodeRow=$('hostedDeleteCodeRow'), delCode=$('hostedDeleteCode'), delIn=$('hostedDeleteIn');
  let delAt=0, delNum='', delTimer=null;
  function delSet(step){
    delAt=step; clearTimeout(delTimer);
    const w=hostedDeleteStepText(step);
    delBtn.textContent=w.button; delBtn.classList.toggle('armed',step>0);
    delBox.hidden=step===0; delStep.textContent=w.text;
    delCodeRow.hidden=step!==2;
    if(step===2){ delNum=hostedDeleteCode(); delCode.textContent=hostedDeleteCodeShown(delNum); delIn.value=''; delIn.focus(); }
    else delNum='';
    delBtn.disabled=step===2;
    if(step)delTimer=setTimeout(function(){ delSet(0); },5*60*1000); // left half done: back to the start
  }
  window.hostedDeleteReset=function(){ if(delAt)delSet(0); };
  delIn.addEventListener('input',function(){ if(delAt===2)delBtn.disabled=!hostedDeleteCodeMatches(delNum,delIn.value); });
  delIn.addEventListener('keydown',function(e){ if(e.key==='Enter'&&!delBtn.disabled)delBtn.click(); });
  $('hostedDeleteCancel').addEventListener('click',function(){ delSet(0); });
  delBtn.addEventListener('click',async function(){
    if(delAt<2){ delSet(delAt+1); return; }
    if(!hostedDeleteCodeMatches(delNum,delIn.value)){ delBtn.disabled=true; return; }
    delBtn.disabled=true; delIn.disabled=true; setSyncStatus('deleting your account…');
    try{
      const out=await hostedDeleteAll();
      $('syncOffBtn').click(); // sync off here, and no starting on the Romulus server by itself again
      setSyncStatus(out.cancelled?'account deleted from the Romulus server. Your lists are still on this device.':'account deleted from the Romulus server, but the plan couldn’t be cancelled from here: cancel it from your Stripe receipt email.',!out.cancelled);
    }catch(e){ setSyncStatus('couldn’t delete: '+e.message,true); }
    finally{ delIn.disabled=false; delSet(0); draw(); }
  });
  // Turn off, or Save & sync on another project: no starting on the Romulus server by itself again
  $('syncOffBtn').addEventListener('click',function(){ hostedSetOptOut(true); setTimeout(draw,0); });
  $('syncSaveBtn').addEventListener('click',function(){ setTimeout(draw,0); }); // the opt-out is set by Save & sync itself, once the switch happened (settings.js)
  $('syncSection').addEventListener('toggle',function(){ if(this.open)draw(); else window.hostedDeleteReset(); });
  window.hostedDraw=draw; // Save & sync redraws this once its switch is done (settings.js)
  if(hostedServer())SYNC_REFUSED.full='sync paused: your free online space is full. Your lists are safe on this device. Settings → Device sync has the options.';
}

if(typeof module!=='undefined')module.exports={hostedJustPaid,hostedMyPlanText,hostedMarkerKeys,hostedSealMarkers,hostedPlanPitch,hostedPlanText,hostedRestorePlan,hostedDayLabel,hostedIs,hostedMb,hostedInStore,hostedCanPay,hostedDeleteBody,hostedDeleteCode,hostedDeleteCodeShown,hostedDeleteCodeMatches,hostedDeleteStepText};
