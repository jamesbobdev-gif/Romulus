/* Health: tasks that check themselves off from Health Connect.
   "Walk #steps 8000", "Gym #exercise 30" (minutes, or "1h"), "Bed early #sleep 7h30" (hours) are ticked off
   once that day's total gets there: the day the task is due, or today when it has no date. Agent tasks never are.
   The phone reads the totals (HealthPlugin.kt, read only) and keeps one line per day in state.health:
     {days: {'YYYY-MM-DD': {steps, exerciseMin, sleepMin, at}}}   a kind he didn't allow is left out, not 0
   Sleep counts toward the morning it ended. The days sync through their own row next to the personal list
   (syncKey+':health') so the computer can tick tasks off too, but only when the lists are end-to-end
   encrypted; otherwise they stay on the phone. They are never put in front of any AI.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists
   them. The parts without page globals are also loaded by test/health.test.js. */
'use strict';

const HEALTH_KEEP_DAYS=60;
const HEALTH_FIELD={steps:'steps',exercise:'exerciseMin',sleep:'sleepMin'};
const HEALTH_WORD=/^(steps|exercise|workout|sleep)$/i;
const HEALTH_GOAL=/(^|\s)#(steps|exercise|workout|sleep)\s+(\d+(?:\.\d+)?)\s*(k|h|hrs?|hours?|m|mins?|minutes?)?(?:\s*(\d{1,2})\s*m?(?:ins?)?)?(?=\s|$|[,.;:!?])/i;

// → {kind:'steps'|'exercise'|'sleep', target} (steps, or minutes), or null when the title has no goal
function healthGoal(title){
  const m=HEALTH_GOAL.exec(String(title||'')); if(!m)return null;
  const word=m[2].toLowerCase(), kind=word==='workout'?'exercise':word;
  const n=+m[3], unit=(m[4]||'').toLowerCase(), hours=/^h/.test(unit), mins=/^m/.test(unit);
  const extra=m[5]&&hours?+m[5]:0;
  let target;
  if(kind==='steps'){ if(hours||mins)return null; target=unit==='k'?n*1000:n; }
  else if(unit==='k')return null;
  else if(kind==='exercise')target=hours?n*60+extra:n;   // a bare number is minutes
  else target=mins?n:n*60+extra;                         // a bare number is hours
  target=Math.round(target);
  return target>0?{kind:kind,target:target}:null;
}
// "#steps 8000" is a goal, not a tag (tagFromWords in quick-add.js skips it)
function isHealthWord(word,rest){ return HEALTH_WORD.test(word)&&/^\s+\d/.test(rest||''); }

function healthMet(goal,day){
  const v=day&&day[HEALTH_FIELD[goal.kind]];
  return typeof v==='number'&&v>=goal.target;
}
function healthFmtMin(m){ const h=Math.floor(m/60), r=m%60; return h&&r?h+'h '+r+'m':h?h+'h':r+'m'; }
function healthSay(goal,day){
  const v=day[HEALTH_FIELD[goal.kind]];
  if(goal.kind==='steps')return v.toLocaleString('en-US')+' steps';
  return healthFmtMin(v)+(goal.kind==='sleep'?' of sleep':' of exercise');
}

function normHealth(raw){
  const r=raw||{}, days={};
  const src=r.days&&typeof r.days==='object'?r.days:{};
  Object.keys(src).forEach(function(k){
    const d=src[k]; if(!/^\d{4}-\d{2}-\d{2}$/.test(k)||!d||typeof d!=='object')return;
    const o={at:+d.at||0};
    Object.keys(HEALTH_FIELD).forEach(function(kind){ const f=HEALTH_FIELD[kind]; if(isFinite(d[f])&&d[f]!==null&&d[f]>=0)o[f]=Math.round(+d[f]); });
    days[k]=o;
  });
  return {days:days};
}
function healthYmd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function healthCutoff(now){ const d=new Date(now||Date.now()); d.setHours(0,0,0,0); d.setDate(d.getDate()-HEALTH_KEEP_DAYS); return healthYmd(d); }
function healthPrune(h,now){ const cut=healthCutoff(now); Object.keys(h.days).forEach(function(k){ if(k<cut)delete h.days[k]; }); return h; }

// each day: the newer reading wins. → {merged, changedLocal, changedRemote}
function healthMergeDocs(local,remoteDoc,now){
  const remote=normHealth(remoteDoc), days={};
  Object.keys(local.days).concat(Object.keys(remote.days)).forEach(function(k){
    const a=local.days[k], b=remote.days[k];
    days[k]=!a?b:!b?a:((b.at||0)>(a.at||0)?b:a);
  });
  const merged=healthPrune({days:days},now);
  const canon=function(h){ return JSON.stringify(Object.keys(h.days).sort().map(function(k){ const d=h.days[k]; return [k,d.at,d.steps,d.exerciseMin,d.sleepMin]; })); };
  return {merged:merged,changedLocal:canon(merged)!==canon(local),changedRemote:canon(merged)!==canon(healthPrune(remote,now))};
}

// The tasks to tick off now: not done, not the Agent's, with a goal the day's total has reached.
// → [{task, goal, day, said}]
function healthDue(tasks,health,today,wsOf){
  const out=[];
  tasks.forEach(function(t){
    if(t.done||(wsOf&&wsOf(t)==='agent'))return;
    const goal=healthGoal(t.title); if(!goal)return;
    const d=t.due||today; if(d>today)return;
    const day=health.days[d]; if(!healthMet(goal,day))return;
    out.push({task:t,goal:goal,day:d,said:healthSay(goal,day)});
  });
  return out;
}

if(typeof module!=='undefined'&&module.exports){
  module.exports={healthGoal:healthGoal,isHealthWord:isHealthWord,healthMet:healthMet,healthSay:healthSay,normHealth:normHealth,
    healthMergeDocs:healthMergeDocs,healthDue:healthDue,healthCutoff:healthCutoff};
}

/* ── the page: sync row, the phone's reads, ticking tasks off, Settings → Health ── */
// end-to-end encrypted lists only: health totals never go up in the clear
function healthProfile(){
  const p=syncState.cfg&&syncState.cfg.personal;
  if(!validProfile(p))return null;
  const hp={url:p.url,key:p.key,syncKey:p.syncKey+':health'};
  return syncV2(hp)?hp:null;
}
function healthDoc(){ return {v:1,days:state.health.days}; }
function mergeHealth(remoteDoc){
  const r=healthMergeDocs(state.health,remoteDoc);
  state.health=r.merged;
  return {changedLocal:r.changedLocal,changedRemote:r.changedRemote};
}

function healthAutoCheck(){
  const due=healthDue(state.tasks.slice(),state.health,healthYmd(new Date()),taskWs);
  if(!due.length)return 0;
  due.forEach(function(x){ setDone(x.task,true); });
  touch();
  voiceToast(due.length===1?'Checked off "'+due[0].task.title+'": '+due[0].said+'.':'Checked off '+due.length+' tasks from your health totals.');
  return due.length;
}

const healthCap=function(){ const cap=window.Capacitor; return cap&&typeof cap.nativePromise==='function'&&cap.isPluginAvailable&&cap.isPluginAvailable('Health')?cap:null; };
const HEALTH_ON_KEY='tasks.health.on';
function healthOn(){ try{ return localStorage.getItem(HEALTH_ON_KEY)==='1'; }catch(e){ return false; } }
function healthSetOn(v){ try{ if(v)localStorage.setItem(HEALTH_ON_KEY,'1'); else localStorage.removeItem(HEALTH_ON_KEY); }catch(e){} }
const healthRun={last:0,busy:false,noRowUntil:0}; // noRowUntil: sync.js waits after the database refused the :health row

// the phone: today and the days before it from Health Connect into state.health, then tick off what's reached
async function healthRead(days){
  const cap=healthCap(); if(!cap||!healthOn()||healthRun.busy)return false;
  healthRun.busy=true;
  try{
    const r=await cap.nativePromise('Health','read',{days:days||7});
    const now=Date.now(); let changed=false;
    (r&&Array.isArray(r.days)?r.days:[]).forEach(function(d){
      if(!d||!/^\d{4}-\d{2}-\d{2}$/.test(d.date))return;
      const prev=state.health.days[d.date]||{}, next={at:now};
      Object.keys(HEALTH_FIELD).forEach(function(kind){ const f=HEALTH_FIELD[kind]; if(typeof d[f]==='number')next[f]=Math.round(d[f]); });
      const same=Object.keys(HEALTH_FIELD).every(function(kind){ const f=HEALTH_FIELD[kind]; return prev[f]===next[f]; });
      if(!same){ state.health.days[d.date]=next; changed=true; }
    });
    healthRun.last=now;
    if(changed){ healthPrune(state.health); persist(); }
    healthAutoCheck();
    healthDraw();
    return true;
  }finally{ healthRun.busy=false; }
}

function healthDraw(){
  const box=$('healthToday'); if(!box)return;
  const t=state.health.days[healthYmd(new Date())];
  if(!t){ box.textContent=''; return; }
  const parts=[];
  if(typeof t.steps==='number')parts.push(t.steps.toLocaleString('en-US')+' steps');
  if(typeof t.exerciseMin==='number')parts.push(healthFmtMin(t.exerciseMin)+' exercise');
  if(typeof t.sleepMin==='number')parts.push(healthFmtMin(t.sleepMin)+' sleep');
  box.textContent=parts.length?'Today so far: '+parts.join(' · ')+(t.at?' (read '+new Date(t.at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})+')':''):'';
}

if(typeof document!=='undefined')(function(){
  const sec=$('healthSection'); if(!sec)return;
  const cap=healthCap();
  const status=$('healthStatus');
  const say=function(s){ status.textContent=s||''; };
  if(!cap){
    // the computer: it only sees what the phone synced
    $('healthPhone').hidden=true; $('healthDesk').hidden=false;
    sec.addEventListener('toggle',function(){ if(sec.open)healthDraw(); });
    healthDraw();
    return;
  }
  $('healthPhone').hidden=false; $('healthDesk').hidden=true;
  const on=$('healthOn'), manage=$('healthManage');
  function show(s){
    on.checked=healthOn()&&!!(s&&s.granted);
    manage.hidden=!(s&&s.available==='yes'&&(s.steps||s.exercise||s.sleep));
    if(!s)return say('');
    if(s.available==='no')return say('Health Connect isn’t available on this phone.');
    if(s.available==='install')return say('Health Connect needs installing or updating from Google Play.');
    if(!healthOn())return say('');
    if(!s.granted){
      const some=['steps','exercise','sleep'].filter(function(k){ return s[k]; });
      return say(some.length?'Reading '+some.join(' and ')+' only. Allow the rest in Health Connect.':'Romulus isn’t allowed to read Health Connect.');
    }
    say(healthProfile()?'Reading steps, exercise and sleep. Your computer sees the daily totals, encrypted.':'Reading steps, exercise and sleep. They stay on this phone until your lists use end-to-end encryption.');
  }
  function refresh(){ cap.nativePromise('Health','status',{}).then(show).catch(function(){ show(null); }); }
  on.addEventListener('change',async function(){
    const want=this.checked; this.disabled=true;
    try{
      if(!want){ healthSetOn(false); show(await cap.nativePromise('Health','status',{})); return; }
      const s=await cap.nativePromise('Health','connect',{});
      if(s&&(s.steps||s.exercise||s.sleep)){ healthSetOn(true); show(s); say('Reading the last 30 days…'); await healthRead(30); show(s); }
      else { healthSetOn(false); show(s); }
    }catch(e){ healthSetOn(false); on.checked=false; say((e&&e.message)||'didn’t work'); }
    finally{ this.disabled=false; }
  });
  manage.addEventListener('click',function(){ cap.nativePromise('Health','openSettings',{}).catch(function(){}); });
  // coming back to the app is when new steps are likely; at most every 10 minutes, and every 30 while it's open
  const tick=function(){ if(healthOn()&&Date.now()-healthRun.last>10*60000)healthRead(7).catch(function(){}); };
  document.addEventListener('visibilitychange',function(){ if(!document.hidden){ refresh(); tick(); } });
  setTimeout(tick,6000); setInterval(tick,30*60000);
  refresh(); healthDraw();
})();
