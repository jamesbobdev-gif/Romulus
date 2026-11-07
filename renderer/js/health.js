/* The Health tab. Everywhere: the Food plan, his per-day macros (calories, protein, carbs, fat) for a week, two
   weeks, a month or until he changes it; the Agent builds grocery orders to add up to it (agent/grocery.js
   macroBrief, groceries skill). It's kept on this device and in the agent list's ':macros' sync row, so the
   computer that runs the Agent sees it.
   On the phone: a to-do that names a goal checks itself off once Apple Health (iPhone) or Health Connect
   (Android) shows it was met. "Walk 8,000 steps" / "10k steps", "Sleep 7 hours" / "8h of sleep", "Work out 30 min"
   / "45 minutes of yoga". Only to-dos due today or with no date; the Agent's tasks never. The numbers come from
   mobile/health-phone.js and stay on the phone: nothing here saves, syncs or sends them, and only the tick reaches
   the other devices.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

const HEALTH_EX='work ?out|exercise|training|train|gym|cardio|run|jog|walk|hike|yoga|swim|bike|cycle|lift|hiit|pilates|stretch';
const HEALTH_H='h|hr|hrs|hours?';
/* {kind:'steps'|'sleep'|'exercise', target} (steps, or minutes) from a to-do's title, or null */
function healthGoal(title){
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
function healthValue(kind,d){ return !d?null:kind==='steps'?d.steps:kind==='sleep'?d.sleepMin:d.exerciseMin; }
function healthSay(kind,v){
  if(kind==='steps')return Number(v).toLocaleString('en-US')+' steps today';
  const h=Math.floor(v/60), mn=v%60, dur=(h?h+'h ':'')+(mn||!h?mn+'m':'').trim();
  return kind==='sleep'?dur.trim()+' of sleep last night':dur.trim()+' of exercise today';
}
/* the to-dos to tick off: open, not the Agent's, due today or undated, a goal the phone's health data shows as met,
   and not one already ticked off by this today (unticking it by hand keeps it unticked) */
function healthToTick(tasks,d,skip,wsOf){
  if(!d||!d.date)return [];
  const out=[];
  (tasks||[]).forEach(function(t){
    if(t.done||wsOf(t)==='agent'||(t.due&&t.due!==d.date)||(skip&&skip[t.id]===d.date))return;
    const g=healthGoal(t.title), v=g&&healthValue(g.kind,d);
    if(g&&v!=null&&v>=g.target)out.push({id:t.id,kind:g.kind,value:v});
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
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
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
if(typeof module!=='undefined'&&module.exports){ module.exports={healthGoal:healthGoal,healthToTick:healthToTick,healthSay:healthSay,macroPlanClean:macroPlanClean,macroPlanUntil:macroPlanUntil,macroPlanDaysLeft:macroPlanDaysLeft,macroPlanSay:macroPlanSay}; }

/* the Health tab: the Food plan everywhere; on the phone also connect, today's numbers, and the goal to-dos with
   how far along each is */
let healthUi=null, healthSetPlan=null; // healthSetPlan: an Agent answer's `macros` → the Food plan (agent-results.js)
function renderHealth(){ if(healthUi)healthUi.draw(); }

if(typeof window!=='undefined'&&typeof document!=='undefined'&&document.getElementById('healthView')){
  const view=$('healthView');
  const MACRO_KEY='health.macros.v1'; // this device's copy of the plan
  let phone=null; // the phone's part of the page (below), when this is a phone with a health store
  let plan=null, planSync={loadedAt:undefined,pulled:false,msg:''}, planEdit=false;
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
      let remote=null; try{ remote=macroPlanClean(JSON.parse(r.doc&&r.doc.text||'null')); }catch(e){}
      const ra=remote?remote.at:(r.doc?r.doc.clearedAt||0:0);
      if(ra>(plan?plan.at:0)&&!planEdit){ plan=remote; keepLocal(); }
      planSync.msg='';
    }catch(e){ planSync.msg='not synced yet ('+e.message+')'; }
  };
  const pushPlan=async function(){
    const p=macrosProfile();
    if(!p){ planSync.msg='kept on this device: turn sync on so the Agent’s computer sees it'; return; }
    const doc=plan?{v:1,text:JSON.stringify(plan)}:{v:1,text:'',clearedAt:Date.now()};
    try{
      for(let i=0;i<3;i++){
        if(!planSync.pulled||i){ const r=await syncPullRow(p); planSync.loadedAt=r.updatedAt; planSync.pulled=true; }
        if(await syncPushCas(p,doc,planSync.loadedAt)){ planSync.msg='saved'; break; } // false: changed elsewhere meanwhile, and his Save wins
        // no row, and the server won't make one: it doesn't know ':macros' yet (supabase/migrations/20261115_sync_macros_key.sql)
        if(!planSync.loadedAt&&!(await syncPullRow(p)).updatedAt){ planSync.msg='saved here only: the sync server needs one update before the Agent’s computer can see it (paste supabase/migrations/20261115_sync_macros_key.sql into its SQL Editor and press Run)'; break; }
        if(i===2)planSync.msg='couldn’t save: it kept changing elsewhere';
      }
    }catch(e){ planSync.msg='saved here; not synced yet ('+e.message+')'; }
  };
  const today=function(){ return phone&&phone.date()||formatDate(new Date()); };
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
      const next={span:spanSel.value,at:Date.now()};
      MACRO_KEYS.forEach(function(k){ next[k]=inputs[k].value; });
      const c=macroPlanClean(next);
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
    if(phone)phone.top(view);
    view.appendChild(drawPlan());
    if(phone)phone.goals(view);
    else view.appendChild(el('p','settings-hint','Steps, sleep and exercise show here on your phone.'));
  };
  // the Agent wrote a meal plan (agent/skills/meal-plan.md, `macros`): its targets become the plan, from today
  healthSetPlan=function(m,source){
    const c=macroPlanClean(Object.assign({},m,{at:Date.now(),source:source||''}));
    if(!c)return '';
    c.from=today(); c.until=macroPlanUntil(c.span,c.from);
    plan=c; planEdit=false; keepLocal();
    pushPlan().then(function(){ if(state.activeTab==='health')draw(); });
    if(state.activeTab==='health')draw();
    return macroPlanSay(c,c.from);
  };
  healthUi={draw:draw,setPhone:function(p){ phone=p; }};
  // the synced copy, once sync has started; and again each time the tab opens
  setTimeout(async function(){ await pullPlan(); if(state.activeTab==='health')draw(); },6000);
  $('tabHealth').addEventListener('click',function(){ if(planSync.pulled)pullPlan().then(function(){ if(state.activeTab==='health'&&!planEdit)draw(); }); });
}

/* the phone's part: connect, today's numbers, and the goal to-dos with how far along each is */
if(typeof window!=='undefined'&&window.phoneHealth&&healthUi){
  const hApi=window.phoneHealth, APP=hApi.app||'Health Connect'; // "Apple Health" on an iPhone
  const AUTO_KEY='tasks.healthAuto.v1'; // task id → the day this ticked it off
  let last=null, st=null, msg='';
  const draw=function(){ healthUi.draw(); };
  const on=function(){ const g=st&&st.granted; return !!(st&&st.sdk==='ready'&&g&&(g.steps||g.sleep||g.exercise)); };
  const auto=function(){ try{ return JSON.parse(localStorage.getItem(AUTO_KEY)||'{}')||{}; }catch(e){ return {}; } };
  const dur=function(v){ return healthSay('exercise',v).split(' of ')[0]; };
  const fmt=function(kind,v){ return v==null?'–':kind==='steps'?Number(v).toLocaleString('en-US'):dur(v); };
  const top=function(view){
    const head=el('div','health-head');
    const btn=el('button','btn-accent',st&&st.sdk==='install'?'Get Health Connect':'Connect '+APP);
    btn.hidden=on()||!!(st&&st.sdk==='none');
    btn.addEventListener('click',async function(){
      btn.disabled=true;
      try{ await hApi.connect(); }catch(e){ msg='Couldn’t open '+APP+'.'; }
      await refresh();
    });
    const mng=el('button','ghost mono','Manage'); mng.hidden=!on();
    mng.addEventListener('click',function(){ hApi.manage().catch(function(){ msg='Couldn’t open '+APP+'.'; draw(); }); });
    head.appendChild(btn); head.appendChild(mng);
    view.appendChild(head);
    const say=msg||(!st?'':st.sdk==='none'?APP+' isn’t available on this phone.':st.sdk==='install'?'Install or update Health Connect first.':!on()?'Not connected.':'');
    if(say)view.appendChild(el('p','settings-hint',say));
    if(on()){
      const g=st.granted, tiles=el('div','health-tiles');
      [['Steps today','steps',last&&last.steps,g.steps],['Sleep last night','sleep',last&&last.sleepMin,g.sleep],['Exercise today','exercise',last&&last.exerciseMin,g.exercise]].forEach(function(x){
        const c=el('div','health-tile');
        c.appendChild(el('div','health-tile-k',x[0]));
        c.appendChild(el('div','health-tile-v',x[3]?fmt(x[1],x[2]):'–'));
        if(!x[3])c.appendChild(el('div','health-tile-s','not allowed'));
        tiles.appendChild(c);
      });
      view.appendChild(tiles);
      // Apple Health never says which reads were allowed: a type said no to simply comes back empty
      if(hApi.ios&&last&&(last.steps==null||last.sleepMin==null||last.exerciseMin==null))
        view.appendChild(el('p','settings-hint','A blank number means nothing logged yet, or not allowed: the Health app, Sharing, Apps, Romulus.'));
    }
  };
  const goals=function(view){
    const today=last&&last.date||formatDate(new Date());
    const goals=state.tasks.filter(function(t){
      return taskWs(t)!=='agent'&&(!t.due||t.due===today)&&(!t.done||(t.doneAt&&formatDate(new Date(t.doneAt))===today))&&healthGoal(t.title);
    });
    view.appendChild(el('h3','settings-subhead','Goals'));
    if(!goals.length){ view.appendChild(el('p','settings-hint','Add a to-do like “Walk 8,000 steps” and it ticks itself off.')); return; }
    const ul=el('div','health-goals');
    goals.forEach(function(t){
      const gl=healthGoal(t.title), v=last?(gl.kind==='steps'?last.steps:gl.kind==='sleep'?last.sleepMin:last.exerciseMin):null;
      const row=el('div','health-goal'+(t.done?' done':''));
      row.appendChild(el('span','health-goal-t',t.title));
      row.appendChild(el('span','mono health-goal-v',t.done?'Done':fmt(gl.kind,v)+' / '+fmt(gl.kind,gl.target)));
      const bar=el('div','health-bar'), fill=el('div','health-fill');
      fill.style.width=(t.done?100:Math.min(100,Math.round(100*(v||0)/gl.target)))+'%';
      bar.appendChild(fill); row.appendChild(bar);
      ul.appendChild(row);
    });
    view.appendChild(ul);
  };
  const tick=async function(){
    if(!on()||document.hidden)return;
    try{ last=await hApi.today(); }catch(e){ return; }
    const skip=auto(), hits=healthToTick(state.tasks,last,skip,taskWs);
    hits.forEach(function(h){
      const t=state.tasks.find(function(x){ return x.id===h.id; });
      if(!t||t.done)return;
      setDone(t,true);
      skip[h.id]=last.date;
      voiceToast('Checked off “'+t.title+'”: '+healthSay(h.kind,h.value));
    });
    Object.keys(skip).forEach(function(id){ if(skip[id]!==last.date)delete skip[id]; }); // only today's count
    try{ localStorage.setItem(AUTO_KEY,JSON.stringify(skip)); }catch(e){}
    if(hits.length)touch();
    else if(state.activeTab==='health')draw();
  };
  const refresh=async function(){
    try{ st=await hApi.status(); msg=''; }catch(e){ msg='Couldn’t reach '+APP+'.'; }
    await tick();
    if(state.activeTab==='health')draw();
  };
  healthUi.setPhone({top:top,goals:goals,date:function(){ return last&&last.date||null; }});
  document.addEventListener('visibilitychange',function(){ if(!document.hidden)refresh(); }); // back from the permission sheet, or a new day
  setTimeout(refresh,8000); // after the tasks have loaded
  setInterval(tick,10*60*1000);
}
