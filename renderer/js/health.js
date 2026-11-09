/* Health: tasks with a goal tick themselves off from the phone's health store, which is Health Connect on Android
   (HealthPlugin.kt) and Apple Health on an iPhone (HealthPlugin.swift): both read-only, both the "Health" plugin.
   A goal is a hashtag, "Walk #steps 8000", "Gym #exercise 30" (minutes, or "1h"), "Bed early #sleep 7h30" (hours),
   or plain words, "Walk 8,000 steps", "Sleep 7 hours", "Work out 30 min". It's ticked off once that day's total gets
   there: the day the task is due, or today when it has no date. Agent tasks never are, and one he unticked by hand
   stays unticked for that day.
   The phone keeps one line per day in state.health:
     {days: {'YYYY-MM-DD': {steps, exerciseMin, sleepMin, at, from}}}   a kind he didn't allow is left out, not 0
   from: {steps|exercise|sleep: ['Garmin Connect', ...]}, the apps and devices that wrote that number (Samsung Health,
   Fitbit, Garmin, Oura, Strava and the rest all feed Health Connect or Apple Health, so the phone reads them there).
   Sleep counts toward the morning it ended. The days sync through their own row next to the personal list
   (syncKey+':health') so the computer can tick tasks off and show them too. That row always goes up sealed
   (sync-crypto.js), whether or not the lists themselves are end-to-end encrypted, so the server never holds a
   health number it can read. They are never put in front of any AI.
   The Health tab shows today's numbers, the goals and how far along each is, and, everywhere, the Food plan: his
   per-day macros (calories, protein, carbs, fat) for a week, two weeks, a month or until he changes it, which the
   Agent builds grocery orders to add up to (agent/grocery.js macroBrief, groceries skill). It's kept on this device
   and in the agent list's ':macros' sync row, so the computer that runs the Agent sees it.
   His weight sits with the Food plan: typed there, or the newest weigh-in the phone's health store has (when he
   allowed that read). It rides in the same ':macros' row as {weight: {lb, at, from}}, and unlike the daily totals
   the Agent does see it, on meal-plan and grocery runs, so "1 g of protein per pound" works the number out.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists
   them. The parts without page globals are also loaded by test/health.test.js. */
'use strict';

const HEALTH_KEEP_DAYS=60;
const HEALTH_FIELD={steps:'steps',exercise:'exerciseMin',sleep:'sleepMin'};
const HEALTH_WORD=/^(steps|exercise|workout|sleep)$/i;
const HEALTH_GOAL=/(^|\s)#(steps|exercise|workout|sleep)\s+(\d+(?:\.\d+)?)\s*(k|h|hrs?|hours?|m|mins?|minutes?)?(?:\s*(\d{1,2})\s*m?(?:ins?)?)?(?=\s|$|[,.;:!?])/i;

// → {kind:'steps'|'exercise'|'sleep', target} (steps, or minutes), or null when the title has no goal
function healthGoal(title){
  const m=HEALTH_GOAL.exec(String(title||'')); if(!m)return healthGoalWords(title);
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
// the same goal in plain words: "Walk 8,000 steps" / "10k steps", "Sleep 7 hours" / "8h of sleep", "Work out 30 min" /
// "45 minutes of yoga". Within what a day can hold, so "Plan the 3 steps" and "Book a 30 min meeting" aren't goals.
const HEALTH_EX='work ?out|exercise|training|train|gym|cardio|run|jog|walk|hike|yoga|swim|bike|cycle|lift|hiit|pilates|stretch';
const HEALTH_H='h|hr|hrs|hours?';
function healthGoalWords(title){
  const s=String(title||'').toLowerCase().replace(/[’']/g,'');
  let m=s.match(/(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?\s*k|\d+)\s*steps?\b/);
  if(m){
    const v=m[1].replace(/[,\s]/g,'');
    const n=/k$/.test(v)?parseFloat(v)*1000:parseFloat(v);
    if(n>=100&&n<=100000)return {kind:'steps',target:Math.round(n)};
  }
  m=s.match(new RegExp('\\bsleep\\b[^\\d]{0,12}(\\d+(?:\\.\\d+)?)\\s*(?:'+HEALTH_H+')\\b'))||
    s.match(new RegExp('(\\d+(?:\\.\\d+)?)\\s*(?:'+HEALTH_H+')\\s+(?:of\\s+)?sleep\\b'));
  if(m){ const h=parseFloat(m[1]); if(h>=1&&h<=14)return {kind:'sleep',target:Math.round(h*60)}; }
  const unit='(min|mins|minutes?|'+HEALTH_H+')';
  m=s.match(new RegExp('\\b(?:'+HEALTH_EX+')\\b[^\\d]{0,12}(\\d+(?:\\.\\d+)?)\\s*'+unit+'\\b'))||
    s.match(new RegExp('(\\d+(?:\\.\\d+)?)\\s*'+unit+'\\s+(?:of\\s+)?(?:'+HEALTH_EX+')\\b'));
  if(m){
    const v=parseFloat(m[1]), min=/^h/.test(m[2])?v*60:v;
    if(min>=5&&min<=600)return {kind:'exercise',target:Math.round(min)};
  }
  return null;
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
    const from=healthFrom(d.from); if(from)o.from=from;
    days[k]=o;
  });
  return {days:days};
}
// what the phone said fed each number → {steps?, exercise?, sleep?: [names]}, or null when it said nothing.
// At most 6 names a kind, 40 characters each, no repeats.
function healthFrom(raw){
  if(!raw||typeof raw!=='object')return null;
  const out={};
  Object.keys(HEALTH_FIELD).forEach(function(kind){
    if(!Array.isArray(raw[kind]))return;
    const names=[];
    raw[kind].forEach(function(n){ const s=String(n==null?'':n).replace(/\s+/g,' ').trim().slice(0,40); if(s&&names.indexOf(s)===-1&&names.length<6)names.push(s); });
    if(names.length)out[kind]=names;
  });
  return Object.keys(out).length?out:null;
}
// every app behind a day's numbers, once each: ['Samsung Health', 'Garmin Connect']
function healthFromAll(day){
  const all=[];
  if(day&&day.from)Object.keys(HEALTH_FIELD).forEach(function(kind){ (day.from[kind]||[]).forEach(function(n){ if(all.indexOf(n)===-1)all.push(n); }); });
  return all;
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
  const canon=function(h){ return JSON.stringify(Object.keys(h.days).sort().map(function(k){ const d=h.days[k]; return [k,d.at,d.steps,d.exerciseMin,d.sleepMin,d.from||null]; })); };
  return {merged:merged,changedLocal:canon(merged)!==canon(local),changedRemote:canon(merged)!==canon(healthPrune(remote,now))};
}

// The tasks to tick off now: not done, not the Agent's, with a goal the day's total has reached, and not one this
// already ticked off for that day (skip: task id → day; unticking it by hand keeps it unticked). → [{task, goal, day, said}]
function healthDue(tasks,health,today,wsOf,skip){
  const out=[];
  tasks.forEach(function(t){
    if(t.done||(wsOf&&wsOf(t)==='agent'))return;
    const goal=healthGoal(t.title); if(!goal)return;
    const d=t.due||today; if(d>today)return;
    if(skip&&skip[t.id]===d)return;
    const day=health.days[d]; if(!healthMet(goal,day))return;
    out.push({task:t,goal:goal,day:d,said:healthSay(goal,day)});
  });
  return out;
}

/* ── the Food plan (pure, for tests) ── */
const MACRO_KEYS=['kcal','protein','carbs','fat'];
const MACRO_SPANS=[['week','a week',7],['2weeks','2 weeks',14],['month','a month',30],['open','until you change it',0]];
// the day a plan started on, plus its span → the last day it covers ('YYYY-MM-DD'), or null for an open-ended plan
function macroPlanUntil(span,fromYmd){
  const sp=MACRO_SPANS.find(function(x){ return x[0]===span; });
  if(!sp||!sp[2])return null;
  const d=new Date(fromYmd+'T12:00:00'); d.setDate(d.getDate()+sp[2]-1);
  return healthYmd(d);
}
// what's saved → a plan with at least one target, or null. {kcal, protein, carbs, fat (per day), span, from, until, at}
function macroPlanClean(p){
  if(!p||typeof p!=='object')return null;
  const out={};
  MACRO_KEYS.forEach(function(k){ const n=Math.round(Number(p[k])); if(n>0&&n<20000)out[k]=n; });
  if(!Object.keys(out).length)return null;
  out.span=MACRO_SPANS.some(function(x){ return x[0]===p.span; })?p.span:'open';
  out.from=/^\d{4}-\d{2}-\d{2}$/.test(p.from)?p.from:null;
  out.until=/^\d{4}-\d{2}-\d{2}$/.test(p.until)?p.until:null;
  out.at=Number(p.at)>0?Number(p.at):0;
  if(p.source&&String(p.source).trim())out.source=String(p.source).replace(/\s+/g,' ').trim().slice(0,120); // the Agent task that set it
  return out;
}
// days a plan still covers, counting today: null for open-ended, 0 or less once it's over
function macroPlanDaysLeft(p,todayYmd){
  if(!p||!p.until)return null;
  return Math.round((new Date(p.until+'T12:00:00')-new Date(todayYmd+'T12:00:00'))/864e5)+1;
}
// an Agent answer's `macros` on top of the plan he has → the plan to save (cleaned), or null.
// keep: only the numbers it gives change, and a plan still running keeps its span and dates; without a running
// plan it starts today, until he changes it. Otherwise it's a whole new plan from today.
function macroPlanMerge(old,m,todayYmd,now){
  if(!m||typeof m!=='object')return null;
  const live=old&&(macroPlanDaysLeft(old,todayYmd)==null||macroPlanDaysLeft(old,todayYmd)>0)?old:null;
  const next={at:now||Date.now(),source:m.source||''};
  if(m.keep&&live){
    MACRO_KEYS.forEach(function(k){ next[k]=m[k]>0?m[k]:live[k]; });
    const sameSpan=!m.span||m.span===live.span;
    next.span=sameSpan?live.span:m.span;
    const c=macroPlanClean(next); if(!c)return null;
    const keepDates=sameSpan&&!!live.from;
    c.from=keepDates?live.from:todayYmd; c.until=keepDates?live.until:macroPlanUntil(c.span,c.from);
    return c;
  }
  MACRO_KEYS.forEach(function(k){ next[k]=m[k]; });
  next.span=m.span||(m.keep?'open':'week');
  const c=macroPlanClean(next); if(!c)return null;
  c.from=todayYmd; c.until=macroPlanUntil(c.span,c.from);
  return c;
}
// one quiet line: "2,100 kcal · 160 g protein · 200 g carbs · 65 g fat a day · 13 days left (ends Nov 20)"
function macroPlanSay(p,todayYmd){
  if(!p)return '';
  const bits=[];
  if(p.kcal)bits.push(p.kcal.toLocaleString('en-US')+' kcal');
  if(p.protein)bits.push(p.protein+' g protein');
  if(p.carbs)bits.push(p.carbs+' g carbs');
  if(p.fat)bits.push(p.fat+' g fat');
  let s=bits.join(' · ')+' a day';
  const left=macroPlanDaysLeft(p,todayYmd);
  if(left==null)s+=' · until you change it';
  else{
    const end=new Date(p.until+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});
    s+=left<=0?' · ended '+end:' · '+(left===1?'last day today':left+' days left')+' (ends '+end+')';
  }
  return s;
}

/* ── his weight (pure, for tests) ── */
const KG_LB=2.20462;
// what's saved → {lb (one decimal), at, from} or null. lb within what a person weighs
function weightClean(w){
  if(!w||typeof w!=='object')return null;
  const lb=Math.round(Number(w.lb)*10)/10;
  if(!(lb>=50&&lb<=900))return null;
  const out={lb:lb,at:Number(w.at)>0?Number(w.at):0};
  if(w.from&&String(w.from).trim())out.from=String(w.from).replace(/\s+/g,' ').trim().slice(0,40);
  return out;
}
// the phone's answer ({kg, at, from}) → a weight, or null; from says which store fed it
function weightFromStore(r,store){
  if(!r||typeof r!=='object'||!(Number(r.kg)>0))return null;
  const app=r.from&&String(r.from).trim();
  return weightClean({lb:Number(r.kg)*KG_LB,at:r.at,from:app&&app!=='This phone'?app:store});
}
// the newer of two (null when neither)
function weightNewer(a,b){ a=weightClean(a); b=weightClean(b); return !a?b:!b?a:(b.at>a.at?b:a); }
// "182 lb, from Withings, Nov 9"
function weightSay(w){
  if(!w)return '';
  return (w.lb%1?w.lb.toFixed(1):String(w.lb))+' lb'+(w.from==='typed in'?', typed in':w.from?', from '+w.from:'')+(w.at?', '+new Date(w.at).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'');
}
// the ':macros' row's text: the plan (or nothing) and his weight
function macroRowText(plan,weight){
  const w=weightClean(weight);
  if(!plan&&!w)return '';
  return JSON.stringify(Object.assign({},plan||{},w?{weight:w}:{}));
}

if(typeof module!=='undefined'&&module.exports){
  module.exports={healthProfileOf:healthProfileOf,healthGoal:healthGoal,healthFrom:healthFrom,healthFromAll:healthFromAll,healthGoalWords:healthGoalWords,isHealthWord:isHealthWord,healthMet:healthMet,healthSay:healthSay,normHealth:normHealth,
    healthMergeDocs:healthMergeDocs,healthDue:healthDue,healthCutoff:healthCutoff,
    macroPlanClean:macroPlanClean,macroPlanUntil:macroPlanUntil,macroPlanDaysLeft:macroPlanDaysLeft,macroPlanSay:macroPlanSay,macroPlanMerge:macroPlanMerge,
    weightClean:weightClean,weightFromStore:weightFromStore,weightNewer:weightNewer,weightSay:weightSay,macroRowText:macroRowText};
}

/* ── the page: sync row, the phone's reads, ticking tasks off, Settings → Health, the Health tab ── */
// health totals never go up in the clear: the row is sealed with the personal list's key under its lookup id
// even when the lists are plain, which is also where it sits once they are encrypted. A device that can't
// encrypt keeps them to itself
function healthProfileOf(p,cryptoOk){
  return p&&p.url&&p.key&&p.syncKey&&cryptoOk?{url:p.url,key:p.key,syncKey:p.syncKey+':health',v2:true}:null;
}
function healthProfile(){
  const p=syncState.cfg&&syncState.cfg.personal;
  return validProfile(p)?healthProfileOf(p,syncCryptoOk()):null;
}
function healthDoc(){ return {v:1,days:state.health.days}; }
function mergeHealth(remoteDoc){
  const r=healthMergeDocs(state.health,remoteDoc);
  state.health=r.merged;
  return {changedLocal:r.changedLocal,changedRemote:r.changedRemote};
}

const HEALTH_AUTO_KEY='tasks.healthAuto.v1'; // task id → the day this ticked it off, so an untick by hand holds for that day
function healthAutoSkip(){ try{ return JSON.parse(localStorage.getItem(HEALTH_AUTO_KEY)||'{}')||{}; }catch(e){ return {}; } }
function healthAutoCheck(){
  const skip=healthAutoSkip(), cut=healthCutoff();
  Object.keys(skip).forEach(function(id){ if(typeof skip[id]!=='string'||skip[id]<cut)delete skip[id]; });
  const due=healthDue(state.tasks.slice(),state.health,healthYmd(new Date()),taskWs,skip);
  if(!due.length)return 0;
  due.forEach(function(x){ setDone(x.task,true); skip[x.task.id]=x.day; });
  try{ localStorage.setItem(HEALTH_AUTO_KEY,JSON.stringify(skip)); }catch(e){}
  touch();
  voiceToast(due.length===1?'Checked off "'+due[0].task.title+'": '+due[0].said+'.':'Checked off '+due.length+' tasks from your health totals.');
  return due.length;
}

const healthCap=function(){ const cap=window.Capacitor; return cap&&typeof cap.nativePromise==='function'&&cap.isPluginAvailable&&cap.isPluginAvailable('Health')?cap:null; };
// which store this phone has: Apple Health on an iPhone, Health Connect on Android
function healthIos(){ const cap=window.Capacitor; return !!(cap&&typeof cap.getPlatform==='function'&&cap.getPlatform()==='ios'); }
function healthStoreName(){ return healthIos()?'Apple Health':'Health Connect'; }
const HEALTH_ON_KEY='tasks.health.on';
function healthOn(){ try{ return localStorage.getItem(HEALTH_ON_KEY)==='1'; }catch(e){ return false; } }
function healthSetOn(v){ try{ if(v)localStorage.setItem(HEALTH_ON_KEY,'1'); else localStorage.removeItem(HEALTH_ON_KEY); }catch(e){} }
const healthRun={last:0,busy:false,noRowUntil:0}; // noRowUntil: sync.js waits after the database refused the :health row

// his weight on this device; the Health tab syncs it with the Food plan (healthWeightChanged)
const WEIGHT_KEY='health.weight.v1';
let healthWeightChanged=null, healthStatus=null; // healthStatus: the plugin's last status() (weight: may it read weight)
function healthWeight(){ try{ return weightClean(JSON.parse(localStorage.getItem(WEIGHT_KEY)||'null')); }catch(e){ return null; } }
function healthWeightKeep(w){ try{ if(w)localStorage.setItem(WEIGHT_KEY,JSON.stringify(w)); else localStorage.removeItem(WEIGHT_KEY); }catch(e){} }

// the phone: today and the days before it from the health store into state.health, then tick off what's reached
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
      const from=healthFrom(d.from); if(from)next.from=from;
      const same=Object.keys(HEALTH_FIELD).every(function(kind){ const f=HEALTH_FIELD[kind]; return prev[f]===next[f]; })&&
        JSON.stringify(prev.from||null)===JSON.stringify(next.from||null);
      if(!same){ state.health.days[d.date]=next; changed=true; }
    });
    healthRun.last=now;
    if(changed){ healthPrune(state.health); persist(); }
    // a newer weigh-in than the one kept (or typed) becomes his weight
    const w=weightFromStore(r&&r.weight,healthStoreName()), had=healthWeight();
    if(w&&(!had||w.at>had.at)){ healthWeightKeep(w); if(healthWeightChanged)healthWeightChanged(); }
    if(!healthAutoCheck()&&state.activeTab==='health')renderHealth(); // a tick redraws through touch()
    healthDraw();
    return true;
  }finally{ healthRun.busy=false; }
}
// the store's own permission sheet, then the last 30 days. → the plugin's status, or null without a store
async function healthConnect(){
  const cap=healthCap(); if(!cap)return null;
  const s=await cap.nativePromise('Health','connect',{});
  healthStatus=s;
  if(s&&(s.steps||s.exercise||s.sleep)){ healthSetOn(true); await healthRead(30); }
  else healthSetOn(false);
  return s;
}

// Settings → Health's one line: today so far
function healthDraw(){
  const box=$('healthToday'); if(!box)return;
  const t=state.health.days[healthYmd(new Date())];
  if(!t){ box.textContent=''; return; }
  const parts=[];
  if(typeof t.steps==='number')parts.push(t.steps.toLocaleString('en-US')+' steps');
  if(typeof t.exerciseMin==='number')parts.push(healthFmtMin(t.exerciseMin)+' exercise');
  if(typeof t.sleepMin==='number')parts.push(healthFmtMin(t.sleepMin)+' sleep');
  const from=healthFromAll(t);
  box.textContent=parts.length?'Today so far: '+parts.join(' · ')+(from.length?', from '+from.join(', '):'')+(t.at?' (read '+new Date(t.at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})+')':''):'';
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
  const on=$('healthOn'), manage=$('healthManage'), STORE=healthStoreName();
  $('healthOnText').textContent='Read steps, exercise and sleep from '+STORE;
  manage.textContent=healthIos()?'The Health app':'Health Connect settings';
  function show(s){
    on.checked=healthOn()&&!!(s&&s.granted);
    manage.hidden=!(s&&s.available==='yes'&&(s.steps||s.exercise||s.sleep));
    if(!s)return say('');
    if(s.available==='no')return say(STORE+' isn’t available on this phone.');
    if(s.available==='install')return say('Health Connect needs installing or updating from Google Play.');
    if(!healthOn())return say('');
    if(!s.granted){
      const some=['steps','exercise','sleep'].filter(function(k){ return s[k]; });
      return say(some.length?'Reading '+some.join(' and ')+' only. Allow the rest in '+STORE+'.':'Romulus isn’t allowed to read '+STORE+'.');
    }
    say((healthProfile()?'Reading steps, exercise and sleep. Your computer sees the daily totals, encrypted.':'Reading steps, exercise and sleep. They stay on this phone until sync is on.')+
      (healthIos()?' A number that stays blank wasn’t allowed: the Health app, Sharing, Apps, Romulus.':''));
  }
  function refresh(){ cap.nativePromise('Health','status',{}).then(function(s){ healthStatus=s; show(s); }).catch(function(){ show(null); }); }
  on.addEventListener('change',async function(){
    const want=this.checked; this.disabled=true;
    try{
      if(!want){ healthSetOn(false); show(await cap.nativePromise('Health','status',{})); if(state.activeTab==='health')renderHealth(); return; }
      say('Reading the last 30 days…');
      show(await healthConnect());
      if(state.activeTab==='health')renderHealth();
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

/* the Health tab: today's numbers and the goals (from the phone's totals, synced to a computer), and the Food plan */
let healthUi=null, healthSetPlan=null; // healthSetPlan: an Agent answer's `macros` → the Food plan (agent-results.js)
function renderHealth(){ if(healthUi)healthUi.draw(); }

if(typeof window!=='undefined'&&typeof document!=='undefined'&&document.getElementById('healthView')){
  const view=$('healthView');
  const MACRO_KEY='health.macros.v1'; // this device's copy of the plan
  let plan=null, planSync={loadedAt:undefined,pulled:false,msg:''}, planEdit=false, msg='';
  try{ plan=macroPlanClean(JSON.parse(localStorage.getItem(MACRO_KEY)||'null')); }catch(e){ plan=null; }
  const macrosProfile=function(){ // the agent list's ':macros' row: the Agent's computer reads it before a grocery run
    const a=typeof syncState!=='undefined'&&syncState.cfg&&syncState.cfg.agent;
    return typeof validProfile==='function'&&validProfile(a)?{url:a.url,key:a.key,syncKey:a.syncKey+':macros',v2:a.v2}:null;
  };
  const keepLocal=function(){ try{ if(plan)localStorage.setItem(MACRO_KEY,JSON.stringify(plan)); else localStorage.removeItem(MACRO_KEY); }catch(e){} };
  // the synced copy: another device's newer plan wins over this device's
  const pullPlan=async function(){
    const p=macrosProfile(); if(!p)return;
    try{
      const r=await syncPullRow(p); planSync.loadedAt=r.updatedAt; planSync.pulled=true;
      let raw=null; try{ raw=JSON.parse(r.doc&&r.doc.text||'null'); }catch(e){}
      const remote=macroPlanClean(raw);
      const ra=remote?remote.at:(r.doc?r.doc.clearedAt||0:0);
      if(ra>(plan?plan.at:0)&&!planEdit){ plan=remote; keepLocal(); }
      // his weight: the newer of this device's and the synced one; push back when this device's is newer
      const mine=healthWeight(), w=weightNewer(mine,raw&&raw.weight);
      if(w&&(!mine||w.at>mine.at))healthWeightKeep(w);
      if(w&&!(raw&&weightClean(raw.weight)&&weightClean(raw.weight).at>=w.at))setTimeout(function(){ pushPlan(); },0);
      planSync.msg='';
    }catch(e){ planSync.msg='not synced yet ('+e.message+')'; }
  };
  const pushPlan=async function(){
    const p=macrosProfile();
    if(!p){ planSync.msg='kept on this device: turn sync on so the Agent’s computer sees it'; return; }
    const text=macroRowText(plan,healthWeight());
    const doc=plan?{v:1,text:text}:{v:1,text:text,clearedAt:Date.now()};
    try{
      for(let i=0;i<3;i++){
        if(!planSync.pulled||i){ const r=await syncPullRow(p); planSync.loadedAt=r.updatedAt; planSync.pulled=true; }
        if(await syncPushCas(p,doc,planSync.loadedAt)){ planSync.msg='saved'; break; } // false: changed elsewhere meanwhile, and his Save wins
        // no row, and the server won't make one: it doesn't know ':macros' yet (supabase/migrations/20261117_sync_macros_key.sql)
        if(!planSync.loadedAt&&!(await syncPullRow(p)).updatedAt){ planSync.msg='saved here only: the sync server needs one update before the Agent’s computer can see it (paste supabase/migrations/20261117_sync_macros_key.sql into its SQL Editor and press Run)'; break; }
        if(i===2)planSync.msg='couldn’t save: it kept changing elsewhere';
      }
    }catch(e){ planSync.msg='saved here; not synced yet ('+e.message+')'; }
  };
  const today=function(){ return healthYmd(new Date()); };
  const fmt=function(kind,v){ return typeof v!=='number'?'–':kind==='steps'?v.toLocaleString('en-US'):healthFmtMin(v); };
  // today's numbers: on the phone with Connect or Manage above them; on a computer what the phone synced
  const drawNumbers=function(){
    const cap=healthCap(), t=state.health.days[today()]||null, wrap=el('div','health-numbers');
    if(cap){
      const head=el('div','health-head');
      if(!healthOn()){
        const btn=el('button','btn-accent','Connect '+healthStoreName());
        btn.addEventListener('click',async function(){
          btn.disabled=true; msg='';
          try{ const s=await healthConnect(); if(s&&!(s.steps||s.exercise||s.sleep))msg=s.available==='no'?healthStoreName()+' isn’t available on this phone.':s.available==='install'?'Install or update Health Connect from Google Play, then try again.':'Romulus isn’t allowed to read '+healthStoreName()+'.'; }
          catch(e){ msg=(e&&e.message)||'didn’t work'; }
          draw();
        });
        head.appendChild(btn);
      } else {
        const mng=el('button','ghost mono','Manage'); mng.title=healthIos()?'The Health app: Sharing, Apps, Romulus':'Health Connect’s settings for Romulus';
        mng.addEventListener('click',function(){ cap.nativePromise('Health','openSettings',{}).catch(function(){}); });
        head.appendChild(mng);
      }
      wrap.appendChild(head);
      if(msg)wrap.appendChild(el('p','settings-hint',msg));
      else if(!healthOn())wrap.appendChild(el('p','settings-hint','Not connected. Once connected, the daily totals of steps, exercise and sleep reach your computer too, encrypted.'));
    }
    if(t||(cap&&healthOn())){
      const tiles=el('div','health-tiles');
      [['Steps today','steps',t&&t.steps],['Exercise today','exercise',t&&t.exerciseMin],['Sleep last night','sleep',t&&t.sleepMin]].forEach(function(x){
        const c=el('div','health-tile');
        c.appendChild(el('div','health-tile-k',x[0]));
        c.appendChild(el('div','health-tile-v',fmt(x[1],x[2])));
        // which apps wrote it: the phone itself, a watch, Samsung Health, Garmin, Oura...
        const from=t&&t.from&&t.from[x[1]];
        if(from&&from.length&&typeof x[2]==='number'){ const s=el('div','health-tile-s',from.join(', ')); s.title='From '+from.join(', '); c.appendChild(s); }
        tiles.appendChild(c);
      });
      wrap.appendChild(tiles);
      // Apple Health never says which reads were allowed: a kind said no to simply comes back empty
      if(cap&&healthIos()&&(!t||typeof t.steps!=='number'||typeof t.exerciseMin!=='number'||typeof t.sleepMin!=='number'))
        wrap.appendChild(el('p','settings-hint','A blank number means nothing logged yet, or not allowed: the Health app, Sharing, Apps, Romulus.'));
    }
    return wrap;
  };
  // the goal to-dos due today or undated, ticked today or still open, with how far along each is
  const drawGoals=function(){
    const wrap=el('div','health-goals-sec'), tk=today();
    const goals=state.tasks.filter(function(t){
      return taskWs(t)!=='agent'&&(!t.due||t.due===tk)&&(!t.done||(t.doneAt&&healthYmd(new Date(t.doneAt))===tk))&&healthGoal(t.title);
    });
    if(!goals.length)return wrap;
    wrap.appendChild(el('h3','settings-subhead','Goals'));
    const ul=el('div','health-goals'), day=state.health.days[tk]||{};
    goals.forEach(function(t){
      const gl=healthGoal(t.title), v=day[HEALTH_FIELD[gl.kind]];
      const row=el('div','health-goal'+(t.done?' done':''));
      row.appendChild(el('span','health-goal-t',t.title));
      row.appendChild(el('span','mono health-goal-v',t.done?'Done':fmt(gl.kind,v)+' / '+fmt(gl.kind,gl.target)));
      const bar=el('div','health-bar'), fill=el('div','health-fill');
      fill.style.width=(t.done?100:Math.min(100,Math.round(100*(typeof v==='number'?v:0)/gl.target)))+'%';
      bar.appendChild(fill); row.appendChild(bar);
      ul.appendChild(row);
    });
    wrap.appendChild(ul);
    return wrap;
  };
  const drawPlan=function(){
    const card=el('div','health-plan');
    const head=el('div','health-plan-head');
    head.appendChild(el('h3','settings-subhead','Food plan'));
    const spanSel=el('select','health-plan-span'); spanSel.setAttribute('aria-label','How long the plan runs');
    MACRO_SPANS.forEach(function(x){ const o=el('option',null,x[0]==='open'?'Until you change it':'For '+x[1]); o.value=x[0]; spanSel.appendChild(o); });
    spanSel.value=plan?plan.span:'week';
    head.appendChild(spanSel);
    card.appendChild(head);
    const row=el('div','health-plan-row'), inputs={};
    [['kcal','Calories','kcal'],['protein','Protein','g'],['carbs','Carbs','g'],['fat','Fat','g']].forEach(function(x){
      const f=el('label','health-plan-field');
      f.appendChild(el('span','health-tile-k',x[1]));
      const inp=document.createElement('input'); inp.type='number'; inp.min='0'; inp.step='1'; inp.inputMode='numeric'; inp.placeholder='–';
      inp.value=plan&&plan[x[0]]?plan[x[0]]:''; inputs[x[0]]=inp;
      inp.addEventListener('input',function(){ planEdit=true; });
      f.appendChild(inp); f.appendChild(el('span','health-plan-unit',x[2]+' a day'));
      row.appendChild(f);
    });
    card.appendChild(row);
    // his weight: typed here, or the phone's newest weigh-in; the Agent uses it for per-pound targets
    const w=healthWeight(), wrow=el('div','health-plan-row health-weight-row');
    const wf=el('label','health-plan-field');
    wf.appendChild(el('span','health-tile-k','Weight'));
    const winp=document.createElement('input'); winp.type='number'; winp.min='50'; winp.max='900'; winp.step='0.1'; winp.inputMode='decimal'; winp.placeholder='–';
    winp.value=w?String(w.lb):''; winp.addEventListener('input',function(){ planEdit=true; });
    wf.appendChild(winp); wf.appendChild(el('span','health-plan-unit','lb'));
    wrow.appendChild(wf);
    const wsay=el('span','settings-hint health-weight-say',w?weightSay(w)+'. The Agent uses it for targets like 1 g of protein per pound.':'Type it, or let your phone fill it in. The Agent uses it for targets like 1 g of protein per pound.');
    wrow.appendChild(wsay);
    // a phone that's connected but wasn't allowed to read weight (connected before weight was asked for)
    const hcap=healthCap();
    if(hcap&&healthOn()&&healthStatus&&healthStatus.available==='yes'&&!healthStatus.weight){
      const allow=el('button','ghost mono','Read it from '+healthStoreName());
      allow.addEventListener('click',async function(){ allow.disabled=true; try{ await healthConnect(); }catch(e){} draw(); });
      wrow.appendChild(allow);
    }
    card.appendChild(wrow);
    const say=el('p','settings-hint health-plan-say');
    say.textContent=plan?macroPlanSay(plan,today())+'. The Agent buys your groceries to add up to this, for you alone.'
      :'Set what you want to eat a day and the Agent buys groceries that add up to it (the 2-week order, or when you ask).';
    card.appendChild(say);
    if(plan&&plan.source)card.appendChild(el('p','settings-hint health-plan-src','Set by the Agent from “'+plan.source+'”. Change the numbers here, or ask it for changes on that task.'));
    const foot=el('div','health-plan-foot');
    const st=el('span','settings-hint health-plan-st',planSync.msg); foot.appendChild(st);
    const save=el('button','btn-accent','Save plan'); foot.appendChild(save);
    const stop=el('button','ghost mono','Stop'); stop.hidden=!plan; stop.title='Drop the plan: orders go back to your usual list'; foot.appendChild(stop);
    card.appendChild(foot);
    save.addEventListener('click',async function(){
      // the weight he typed, when it differs from the kept one
      const typed=winp.value.trim()?weightClean({lb:winp.value,at:Date.now(),from:'typed in'}):null;
      if(winp.value.trim()&&!typed){ planSync.msg='that weight doesn’t look right (pounds)'; st.textContent=planSync.msg; return; }
      const wNow=healthWeight(), wChanged=typed&&(!wNow||wNow.lb!==typed.lb);
      if(wChanged)healthWeightKeep(typed);
      const next={span:spanSel.value,at:Date.now()};
      MACRO_KEYS.forEach(function(k){ next[k]=inputs[k].value; });
      const c=macroPlanClean(next);
      if(!c&&wChanged){ planEdit=false; save.disabled=true; planSync.msg='saving…'; st.textContent=planSync.msg; await pushPlan(); draw(); return; }
      if(!c){ planSync.msg='give at least one number'; st.textContent=planSync.msg; return; }
      const t=today();
      c.from=plan&&plan.span===c.span&&plan.from&&macroPlanDaysLeft(plan,t)>0?plan.from:t; // the same span again keeps its dates
      c.until=macroPlanUntil(c.span,c.from);
      plan=c; planEdit=false; keepLocal();
      save.disabled=true; planSync.msg='saving…'; st.textContent=planSync.msg;
      await pushPlan(); if(typeof buzz==='function')buzz('send'); draw();
    });
    stop.addEventListener('click',async function(){
      plan=null; planEdit=false; keepLocal();
      stop.disabled=true; await pushPlan(); draw();
    });
    return card;
  };
  const draw=function(){
    view.innerHTML='';
    view.appendChild(drawNumbers());
    view.appendChild(drawPlan());
    view.appendChild(drawGoals());
  };
  // the Agent wrote a meal plan (agent/skills/meal-plan.md, `macros`): its targets become the plan, from today;
  // with keep ("1 g of protein per pound") only those numbers change and the rest of the plan stays
  healthSetPlan=function(m,source){
    const c=macroPlanMerge(plan,Object.assign({},m,{source:source||''}),today());
    if(!c)return '';
    plan=c; planEdit=false; keepLocal();
    pushPlan().then(function(){ if(state.activeTab==='health')draw(); });
    if(state.activeTab==='health')draw();
    return macroPlanSay(c,today());
  };
  healthUi={draw:draw};
  // the phone read a newer weigh-in: sync it, and show it unless he's mid-edit
  healthWeightChanged=function(){ pushPlan().then(function(){ if(state.activeTab==='health'&&!planEdit)draw(); }); };
  // the synced copy, once sync has started; and again each time the tab opens
  setTimeout(async function(){ await pullPlan(); if(state.activeTab==='health')draw(); },6000);
  $('tabHealth').addEventListener('click',function(){ if(planSync.pulled)pullPlan().then(function(){ if(state.activeTab==='health'&&!planEdit)draw(); }); });
}
