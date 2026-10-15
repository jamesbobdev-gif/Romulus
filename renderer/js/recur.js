/* Repeating to-dos: tick one off and the next copy appears with the next due date.
   (Agent tasks have their own schedule, t.repeat, in agent-chat.js; this is t.recur, for the other lists.)
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them.
   Also loaded by test/recur.test.js, so the date maths here uses no page globals. */
'use strict';

const RECUR_OPTIONS=[['','Doesn’t repeat'],['day','Every day'],['weekday','Weekdays'],['week','Every week'],['2week','Every 2 weeks'],['month','Every month'],['year','Every year']];
const RECUR_CHIPS={day:'daily',weekday:'weekdays',week:'weekly','2week':'every 2 wks',month:'monthly',year:'yearly'};

function recurYmd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function recurDate(s){ const p=s.split('-').map(Number); return new Date(p[0],p[1]-1,p[2]); }
// one step of the rule; months and years keep the anchor day (the 31st stays the 31st, or the month's last day)
function recurStep(r,d){
  const n=new Date(d.getTime());
  if(r.every==='day')n.setDate(n.getDate()+1);
  else if(r.every==='weekday'){ do n.setDate(n.getDate()+1); while(n.getDay()===0||n.getDay()===6); }
  else if(r.every==='week')n.setDate(n.getDate()+7);
  else if(r.every==='2week')n.setDate(n.getDate()+14);
  else if(r.every==='month'||r.every==='year'){
    const dom=r.dom||d.getDate();
    const y=n.getFullYear()+(r.every==='year'?1:0), m=n.getMonth()+(r.every==='month'?1:0);
    const last=new Date(y,m+1,0).getDate();
    return new Date(y,m,Math.min(dom,last));
  }
  else return null;
  return n;
}
// The next due date after finishing one due on `due`: the first step of the rule that is after both
// that due date and today, so a task ticked off late doesn't come back already overdue.
function nextRecurDue(r,due,today){
  if(!r||!RECUR_CHIPS[r.every])return null;
  const end=recurDate(today);
  let d=recurStep(r,recurDate(due||today));
  for(let i=0;d&&d<=end&&i<5000;i++)d=recurStep(r,d);
  return d?recurYmd(d):null;
}
// The copy's id comes from the series and its date, so two devices that both make the next copy
// (one ticked it off, the other heard about it through sync) make the same task, and sync keeps one.
function recurCopyId(r,seriesFallback,nextDue){ return 'r-'+(r.series||seriesFallback)+'-'+nextDue; }

if(typeof module!=='undefined'&&module.exports){ module.exports={nextRecurDue:nextRecurDue,recurCopyId:recurCopyId}; }
else {
  // make the next copy of a ticked-off repeating task (once: recurNext remembers it)
  window.spawnRecur=function(t){
    if(!t||!t.recur||!t.done||t.recurNext||taskWs(t)==='agent')return false;
    const nextDue=nextRecurDue(t.recur,t.due,recurYmd(new Date()));
    if(!nextDue)return false;
    const id=recurCopyId(t.recur,t.id,nextDue);
    t.recurNext=id;
    if(state.tasks.some(function(x){ return x.id===id; }))return true;
    const c={id:id,title:t.title,done:false,due:nextDue,dueTime:t.dueTime||null,tag:t.tag||null,ws:taskWs(t),pin:null,
      subs:(t.subs||[]).map(function(s){ return {id:uid(),title:s.title,done:false,due:null}; }),
      googleEventId:null,created:Date.now(),recur:Object.assign({},t.recur,{series:t.recur.series||t.id})};
    if(t.calRef)c.calRef=t.calRef;
    if(t.kind)c.kind=t.kind;
    if(t.notes)c.notes=t.notes;
    state.tasks.push(c);
    return true;
  };
  // re-opening a ticked-off repeating task takes back the copy it made, if that copy hasn't been touched
  window.unspawnRecur=function(t){
    if(!t||!t.recurNext)return;
    const c=state.tasks.find(function(x){ return x.id===t.recurNext; });
    delete t.recurNext;
    if(!c||c.done)return;
    state.tasks=state.tasks.filter(function(x){ return x!==c; });
    state.expanded.delete(c.id);
    state.tombstones.push({id:c.id,deletedAt:Date.now()});
  };
  // repeating tasks ticked off somewhere that doesn't make copies (Claude's task tools, an older phone build)
  window.spawnMissedRecurs=function(){
    let n=0;
    state.tasks.slice().forEach(function(t){ if(t.recur&&t.done&&!t.recurNext&&spawnRecur(t))n++; });
    return n;
  };
}
