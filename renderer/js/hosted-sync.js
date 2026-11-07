/* Romulus sync: the project an official build ships with (window.ROMULUS_PAIR, renderer/js/pair-server.js) is
   where a new install syncs from the first start, so nobody has to make a Supabase project to get their phone
   and computer talking. Each install gets its own random sync key and its lists go up end-to-end encrypted
   (sync-crypto.js): the database holds them only under a lookup id made from the key, sealed, and every table
   is closed to the app's key (row-level security, no policies); lists are reached only through functions that
   need the key. So one person's lists can't be found, read or changed by another, or read by whoever runs it.
   Each account has free_quota_bytes there (supabase/migrations/20261106_sync_paid_plan.sql). Past that, it can
   pay for a plan (Stripe: ROMULUS_PAIR.paySolo for the individual plan, $3 a month; .pay for the family/group
   plan, $5 for up to 5 people; 20261114_sync_solo_plan.sql) or move to a Supabase project of its own; this file
   shows that choice in Settings → Device sync. Loads after settings.js and pair-server.js, before init.js uses it. */
'use strict';

const HOSTED_OFF_KEY='tasks.syncHostedOff'; // he turned sync off or chose his own project: no auto start again
const HOSTED_SIDE_ROWS={personal:[':ideas',':hours',':devices'],agent:[':prefs',':locked',':routing',':standing'],work:[],school:[]};
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
/* How the plans are offered (pure, for tests): the individual plan first, then the family/group plan, which is
   the same for up to 5 people for $2 more, so side by side it's plainly the better deal. Family and history come
   before storage in the words, since people can picture sharing lists with a partner or undoing a bad day, not
   600 MB. h.paySolo (repository variable PAY_SOLO_URL) is the individual plan's link: without it only the
   family/group plan is offered, as before. h.trialDays (PAY_TRIAL_DAYS) says the Stripe links start with that
   many free days; only then does it say so. */
function hostedPlanPitch(h){
  const days=Math.max(0,Math.floor(Number(h&&h.trialDays)||0));
  const perks='undo a bad day with 30 days of history, get new versions early, and have 600 MB for photos and files instead of 50 MB';
  if(!(h&&h.paySolo))return {
    solo:null,
    family:{
      button:days?'Try the family/group plan free for '+days+' days':'Family/Group plan: $5 a month for up to 5 people',
      year:'Pay yearly: 2 months free',
      pitch:'The family/group plan: share Romulus with up to 4 more people, with a family list you all keep together (groceries, chores, a trip) and private lists of your own, and '+perks+'.'+(days?' Free for '+days+' days, then $5 a month. Cancel before the trial ends and you pay nothing.':'')
    }
  };
  return {
    solo:{
      button:days?'Individual: free for '+days+' days, then $3 a month':'Individual: $3 a month',
      year:'$30 a year: 2 months free',
      pitch:'Just you: '+perks+'.'
    },
    family:{
      button:days?'Family/Group: free for '+days+' days, then $5 a month':'Family/Group: $5 a month for up to 5 people',
      year:'$50 a year: 2 months free',
      pitch:'Everything in Individual for up to 5 people, plus a family list you all keep together (groceries, chores, a trip) and to-dos you send each other. $2 more a month than going alone.'+(days?' Cancel before the trial ends and you pay nothing.':'')
    }
  };
}
function hostedPlanText(u,hasPay,hasSolo){
  if(!u)return {line:'',full:false};
  const used=Number(u.used_bytes)||0, quota=Number(u.quota_bytes)||0;
  const paid=!!u.paid_until;
  const full=u.refused==='full'||(quota>0&&used>=quota*0.9);
  let line='Using '+hostedMb(used)+' of '+hostedMb(quota)+(paid?', paid until '+new Date(u.paid_until).toLocaleDateString(undefined,{month:'short',day:'numeric'})+'.':' free.');
  if(full&&!paid)line+=' Your lists have nearly outgrown the free space. '+(hasPay?'Keep syncing here '+(hasSolo?'from $3':'for $5')+' a month ('+hostedMb(u.paid_quota_bytes)+'), or move':'Move')+' to a Supabase project of your own: free up to 500 MB, or Pro at $25 a month.';
  return {line:line,full:full&&!paid};
}

/* Someone who just got the plan sees fireworks once, on the device they were on the free space with. What this
   device last saw is kept (HOSTED_SEEN_KEY: 'free' or 'paid'); only free → paid celebrates, so a new device of
   someone already paying, or a restart, doesn't set them off again. Pure, for tests. */
const HOSTED_SEEN_KEY='tasks.hostedPlanSeen';
// which plan sync_usage says covers the account (pure, for tests): 'solo', 'family', or null on the free space.
// A server from before the individual plan says nothing about the plan, so a paid account there is family.
function hostedPlanOf(u){ return u&&u.paid_until?(u.plan==='solo'?'solo':'family'):null; }
function hostedPlanName(plan){ return plan==='solo'?'individual plan':'family/group plan'; }
function hostedJustPaid(seen,paid){ return !!paid&&seen==='free'; }
/* The "Your plan" box in Settings, whatever someone is on (pure, for tests). status: 'free', 'solo' (pays for the
   individual plan), 'payer' (pays for the family plan), 'member' (on someone else's family plan) or 'own' (their
   own Supabase project); u = sync_usage's
   row, for the sizes. */
function hostedMyPlanText(status,u){
  const freeMb=hostedMb(u&&!u.paid_until&&u.quota_bytes||5*1024*1024), paidMb=hostedMb(u&&u.paid_quota_bytes||600*1024*1024);
  if(status==='member')return {title:'Family/Group plan',text:'Shared with you by someone in your family/group: '+paidMb+', 30 days of history.'};
  if(status==='payer')return {title:'Family/Group plan',text:paidMb+', 30 days of history, up to 4 more people. Thank you.'};
  if(status==='solo')return {title:'Individual plan',text:paidMb+', 30 days of history, just you. Thank you.'};
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
const HOSTED_FAMILY_WHY={not_paid:'only the person paying for the plan can invite',solo:'the individual plan is for one person; move to the family/group plan under Settings → Device sync to invite',family_full:'the plan already covers 4 more people',bad:'that didn’t work',rate:'too many tries from this network; try again in an hour',no_code:'that code isn’t right, or it’s over 2 days old',no_account:'sync hasn’t started on this device yet; try again in a minute',own:'that’s your own code: give it to the person you want on your plan'};

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
      setMyPlan(validProfile(p)?'own':null,null);
      if(typeof familyDraw==='function')familyDraw('');
      info.textContent=validProfile(p)?'Your lists sync through your own Supabase project.':'Sync is off on this device.';
      return;
    }
    info.textContent='End-to-end encrypted on the Romulus server.';
    let u=null; try{ u=(await syncRpc(p,'sync_usage',{p_sync_key:await syncRowKey(p)}))[0]; }catch(e){}
    if(syncState.cfg!==c)return;
    const canPay=hostedCanPay(h);
    const t=hostedPlanText(u,canPay,!!h.paySolo);
    if(t.line)info.textContent+=' '+t.line;
    const paid=!!(u&&u.paid_until), plan=hostedPlanOf(u);
    setMyPlan(u?(paid?(plan==='solo'?'solo':'payer'):'free'):null,u);
    if(u)hostedNoteSeen(paid,plan);
    // the plans are on offer the whole time someone is on the free space, not only once it's nearly full
    planBox.hidden=!u||paid;
    const words=hostedPlanPitch(h);
    soloBox.hidden=!(canPay&&words.solo);
    if(words.solo){ $('hostedSoloPitch').textContent=words.solo.pitch; paySoloBtn.textContent=words.solo.button; paySoloYearBtn.textContent=words.solo.year; paySoloYearBtn.hidden=!h.paySoloYear; }
    $('hostedFamilyLabel').hidden=soloBox.hidden;
    $('hostedPitch').textContent=words.family.pitch; payBtn.textContent=words.family.button; payYearBtn.textContent=words.family.year;
    payBtn.hidden=!canPay;
    payYearBtn.hidden=!(canPay&&h.payYear);
    // at 90% of the free space the two ways on sit side by side: pay for more, or move to a project of one's own
    planOwnBtn.hidden=!t.full;
    drawFamily(p,c);
    drawHistory(p,c,paid);
    drawEarly(paid);
    drawSupporters(p,c);
  };
  const myPlan=$('hostedMyPlan'), myPlanTitle=$('hostedMyPlanTitle'), myPlanInfo=$('hostedMyPlanInfo');
  // null: nothing known (sync off, or the server didn't answer), so the box stays out of the way
  function setMyPlan(status,u){
    myPlan.hidden=!status;
    // on the individual plan, the family/group plan is right there: the same for up to 5 people, $2 more
    const h=hostedServer();
    upBox.hidden=!(status==='solo'&&hostedCanPay(h)&&h.pay);
    if(!upBox.hidden)upYearBtn.hidden=!h.payYear;
    if(!status)return;
    const w=hostedMyPlanText(status,u); myPlanTitle.textContent=w.title; myPlanInfo.textContent=w.text;
    nameRow.hidden=!(status==='payer'||status==='solo'); // both pay, both may be on the thanks list
    if(!nameRow.hidden)drawName();
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
  const planBox=$('hostedPlan'), payYearBtn=$('hostedPayYearBtn'), joinBtn=$('hostedJoinBtn'), planOwnBtn=$('hostedPlanOwnBtn');
  const soloBox=$('hostedSoloBox'), paySoloBtn=$('hostedPaySoloBtn'), paySoloYearBtn=$('hostedPaySoloYearBtn');
  const upBox=$('hostedUpgrade'), upBtn=$('hostedUpgradeBtn'), upYearBtn=$('hostedUpgradeYearBtn');
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
    if(role==='member'){ famInfo.textContent=''; setMyPlan('member',null); return; }
    if(role!=='payer')return;
    const members=rows.filter(function(r){ return r.member; });
    famInfo.textContent=members.length?members.length+' of 4 spots used.':'';
    members.forEach(function(m,i){
      const row=document.createElement('div'); row.className='settings-row'; row.style.alignItems='center';
      const s=document.createElement('span'); s.className='settings-hint'; s.style.margin='0';
      s.textContent='Person '+(i+1)+(m.since?', joined '+new Date(m.since).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'');
      const b=document.createElement('button'); b.className='ghost mono'; b.textContent='Take off';
      b.addEventListener('click',async function(){
        const shared=typeof familyConfigured==='function'&&familyConfigured();
        if(!confirm('Take this person off your plan? They go back to the free space and the shared lists leave their app; nothing of their own is deleted.'+(shared?'\n\nThe family list moves to a new key their devices don’t get, so nothing new reaches them. What they already synced stays on their devices: that can’t be taken back.':'')))return;
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
  // free → paid on this device: fireworks, and Settings opened on the plan so it's plain what they have now
  function hostedNoteSeen(paid,plan){
    let seen=null; try{ seen=localStorage.getItem(HOSTED_SEEN_KEY); }catch(e){}
    try{ localStorage.setItem(HOSTED_SEEN_KEY,paid?'paid':'free'); }catch(e){}
    if(!hostedJustPaid(seen,paid))return;
    hostedFireworks('Welcome to the '+hostedPlanName(plan));
    setSyncStatus('you’re on the '+hostedPlanName(plan)+' now. Thank you.');
    // Device sync opened, drawn with the plan, and "Your plan: Family" scrolled into view
    if(typeof openSettingsAt==='function')openSettingsAt(null,'syncSection');
    Promise.resolve(draw()).then(function(){ if(!myPlan.hidden)myPlan.scrollIntoView({block:'center',behavior:'smooth'}); }).catch(function(){});
  }
  // after a pay link opens, look every 20 seconds for 15 minutes for the payment to land (Stripe's webhook):
  // want is the plan that link sells, so a move from one plan to the other is seen too
  let watchTimer=null;
  function watchForPlan(want){
    clearInterval(watchTimer);
    const until=Date.now()+15*60*1000;
    watchTimer=setInterval(async function(){
      const p=syncState.cfg&&syncState.cfg.personal;
      if(Date.now()>until||!validProfile(p)||!hostedIs(p.url)){ clearInterval(watchTimer); return; }
      let u=null; try{ u=(await syncRpc(p,'sync_usage',{p_sync_key:await syncRowKey(p)}))[0]; }catch(e){ return; }
      if(hostedPlanOf(u)===want){ clearInterval(watchTimer); setSyncStatus('you’re on the '+hostedPlanName(want)+' now. Thank you.'); draw(); }
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
    if(u)hostedNoteSeen(!!u.paid_until,hostedPlanOf(u));
  };
  setTimeout(lookForPlan,8000);
  setInterval(lookForPlan,5*60*1000);
  const openPay=async function(link,want){
    const h=hostedServer(), p=syncState.cfg&&syncState.cfg.personal; if(!hostedCanPay(h)||!link||!validProfile(p))return;
    // the link carries the account id, a hash of the key's lookup id: Stripe never sees the key
    const acct=await hostedAccountId(await syncRowKey(p));
    openOutside(link+(link.indexOf('?')===-1?'?':'&')+'client_reference_id='+acct);
    setSyncStatus('once the payment goes through, the plan turns on within a minute');
    watchForPlan(want);
  };
  payBtn.addEventListener('click',function(){ const h=hostedServer(); openPay(h&&h.pay,'family'); });
  payYearBtn.addEventListener('click',function(){ const h=hostedServer(); openPay(h&&h.payYear,'family'); });
  paySoloBtn.addEventListener('click',function(){ const h=hostedServer(); openPay(h&&h.paySolo,'solo'); });
  paySoloYearBtn.addEventListener('click',function(){ const h=hostedServer(); openPay(h&&h.paySoloYear,'solo'); });
  upBtn.addEventListener('click',function(){ const h=hostedServer(); openPay(h&&h.pay,'family'); });
  upYearBtn.addEventListener('click',function(){ const h=hostedServer(); openPay(h&&h.payYear,'family'); });
  planOwnBtn.addEventListener('click',function(){ ownBtn.click(); });
  joinBtn.addEventListener('click',async function(){
    const code=prompt('The group code someone with the family/group plan gave you:');
    if(!code||!code.trim())return;
    const k=await rowKey(); if(!k)return;
    try{
      // a code with the family key in it also opens the shared lists (family.js); a server without that
      // migration yet only knows the plain join
      let r;
      try{ r=await famJoin(k.p,code.trim()); }
      catch(e){ if(!/HTTP 404/.test(e.message))throw e; r={why:await syncRpc(k.p,'sync_family_join',{p_sync_key:k.rk,p_code:famCodeSplit(code).server})||null,lists:false}; }
      if(r.why)setSyncStatus('couldn’t join: '+(HOSTED_FAMILY_WHY[r.why]||r.why),true);
      else setSyncStatus(r.lists?'you’re on the family/group plan now. The Group tab has the shared lists.':'you’re on the family/group plan now. For the shared lists, ask for a new code: this one is from an older version.');
    }catch(e){ setSyncStatus('couldn’t join: '+e.message,true); }
    draw();
  });
  inviteBtn.addEventListener('click',async function(){
    const k=await rowKey(); if(!k)return;
    try{
      let r;
      try{ r=await famInvite(k.p); }
      catch(e){ if(!/HTTP 404/.test(e.message))throw e; r=(await syncRpc(k.p,'sync_family_invite',{p_sync_key:k.rk}))[0]||{}; r.old=true; }
      if(r.why){ setSyncStatus('couldn’t make a code: '+(HOSTED_FAMILY_WHY[r.why]||r.why),true); return; }
      famInfo.textContent='Code for them: '+r.code+'. They enter it under I have a group code. It adds one person and stops working after 2 days'+(r.old?'; making another code cancels this one.':'. Once they’re in, you share lists and send each other to-dos on the Group tab.');
      setSyncStatus('group code made');
    }catch(e){ setSyncStatus('couldn’t make a code: '+e.message,true); }
  });
  leaveBtn.addEventListener('click',async function(){
    const shared=typeof familyConfigured==='function'&&familyConfigured();
    if(!confirm('Leave the family/group plan? You go back to the free space, and the group’s shared lists leave this app. Your own lists aren’t touched.'+(shared?'\n\nThe family list leaves this device too; everyone else keeps it.':'')))return;
    const k=await rowKey(); if(!k)return;
    try{
      await syncRpc(k.p,'sync_family_remove',{p_sync_key:k.rk,p_member:null});
      famForget();
      if(shared)await familyDropHere();
      setSyncStatus('you left the family/group plan');
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
    if(!confirm('Delete your synced data from the Romulus server?\n\nYour lists, photos and files there are deleted for good, and a paid plan is cancelled. Sync turns off on this device; the lists stay on it.\n\nTurn sync off on your other devices first, or they will upload their copy again.'))return;
    delBtn.disabled=true; setSyncStatus('deleting your synced data…');
    try{
      const out=await hostedDeleteAll();
      $('syncOffBtn').click(); // sync off here, and no starting on the Romulus server by itself again
      setSyncStatus(out.cancelled?'deleted from the Romulus server. Your lists are still on this device.':'deleted from the Romulus server, but the paid plan couldn’t be cancelled from here: cancel it from your Stripe receipt email.',!out.cancelled);
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

if(typeof module!=='undefined')module.exports={hostedJustPaid,hostedMyPlanText,hostedPlanOf,hostedPlanName,hostedMarkerKeys,hostedSealMarkers,hostedPlanPitch,hostedPlanText,hostedRestorePlan,hostedDayLabel,hostedIs,hostedMb,hostedInStore,hostedCanPay,hostedDeleteBody};
