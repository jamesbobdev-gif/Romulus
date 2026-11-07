/* Health goals (Android): a to-do that names a goal checks itself off once Health Connect shows it was met.
   "Walk 8,000 steps" / "10k steps", "Sleep 7 hours" / "8h of sleep", "Work out 30 min" / "45 minutes of yoga".
   Only to-dos due today or with no date; the Agent's tasks never. The numbers come from mobile/health-phone.js
   and stay on the phone: nothing here saves, syncs or sends them, and only the tick reaches the other devices.
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
/* the to-dos to tick off: open, not the Agent's, due today or undated, a goal Health Connect shows as met,
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
if(typeof module!=='undefined'&&module.exports){ module.exports={healthGoal:healthGoal,healthToTick:healthToTick,healthSay:healthSay}; }

/* the Health tab (phone only): connect, today's numbers, and the goal to-dos with how far along each is */
let healthUi=null;
function renderHealth(){ if(healthUi)healthUi.draw(); }

if(typeof window!=='undefined'&&window.phoneHealth&&typeof document!=='undefined'&&document.getElementById('healthView')){
  const hApi=window.phoneHealth;
  const AUTO_KEY='tasks.healthAuto.v1'; // task id → the day this ticked it off
  const view=$('healthView');
  let last=null, st=null, msg='';
  const on=function(){ const g=st&&st.granted; return !!(st&&st.sdk==='ready'&&g&&(g.steps||g.sleep||g.exercise)); };
  const auto=function(){ try{ return JSON.parse(localStorage.getItem(AUTO_KEY)||'{}')||{}; }catch(e){ return {}; } };
  const dur=function(v){ return healthSay('exercise',v).split(' of ')[0]; };
  const fmt=function(kind,v){ return v==null?'–':kind==='steps'?Number(v).toLocaleString('en-US'):dur(v); };
  const draw=function(){
    view.innerHTML='';
    const head=el('div','health-head');
    const btn=el('button','btn-accent',st&&st.sdk==='install'?'Get Health Connect':'Connect Health Connect');
    btn.hidden=on()||!!(st&&st.sdk==='none');
    btn.addEventListener('click',async function(){
      btn.disabled=true;
      try{ await hApi.connect(); }catch(e){ msg='Couldn’t open Health Connect.'; }
      await refresh();
    });
    const mng=el('button','ghost mono','Manage'); mng.hidden=!on();
    mng.addEventListener('click',function(){ hApi.manage().catch(function(){ msg='Couldn’t open Health Connect.'; draw(); }); });
    head.appendChild(btn); head.appendChild(mng);
    view.appendChild(head);
    const say=msg||(!st?'':st.sdk==='none'?'Health Connect isn’t available on this phone.':st.sdk==='install'?'Install or update Health Connect first.':!on()?'Not connected.':'');
    if(say)view.appendChild(el('p','settings-hint',say));
    if(on()){
      const g=st.granted, tiles=el('div','hours-totals');
      [['Steps today','steps',last&&last.steps,g.steps],['Sleep last night','sleep',last&&last.sleepMin,g.sleep],['Exercise today','exercise',last&&last.exerciseMin,g.exercise]].forEach(function(x){
        const c=el('div','hours-total');
        c.appendChild(el('div','hours-total-k',x[0]));
        c.appendChild(el('div','hours-total-v',x[3]?fmt(x[1],x[2]):'–'));
        if(!x[3])c.appendChild(el('div','hours-total-split','not allowed'));
        tiles.appendChild(c);
      });
      view.appendChild(tiles);
    }
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
    try{ st=await hApi.status(); msg=''; }catch(e){ msg='Couldn’t reach Health Connect.'; }
    await tick();
    if(state.activeTab==='health')draw();
  };
  healthUi={draw:draw};
  $('tabHealth').dataset.na='';
  if(typeof tabsPicksDraw==='function')tabsPicksDraw();
  tabsApply();
  document.addEventListener('visibilitychange',function(){ if(!document.hidden)refresh(); }); // back from Health Connect, or a new day
  setTimeout(refresh,8000); // after the tasks have loaded
  setInterval(tick,10*60*1000);
}
