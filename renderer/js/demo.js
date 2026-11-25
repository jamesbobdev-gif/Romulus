/* Examples to try things on: the welcome card's "Show me with examples" puts a few made-up to-dos on the To do
   list, each one showing a thing the list does (tick off, steps, a repeat with its run, a time, a tag, a goal
   that ticks itself). Nothing needs an account, an AI or sync. A bar above the list says they are examples and
   takes them all away again in one click; their ids start with 'demo-', which is how they are found (and
   'r-demo-' for the copies the repeating one makes).
   They are ordinary to-dos, never Agent tasks, so nothing runs because of them.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists
   them. The part without page globals is also loaded by test/demo.test.js. */
'use strict';

const DEMO_ID='demo-';
// the examples, and the next copies the repeating one makes when it is ticked off (recur.js: 'r-' + series + date)
function isDemoTask(t){ return !!(t&&typeof t.id==='string'&&(t.id.indexOf(DEMO_ID)===0||t.id.indexOf('r-'+DEMO_ID)===0)); }
function demoYmd(now,plusDays){
  const d=new Date(now); d.setHours(0,0,0,0); d.setDate(d.getDate()+(plusDays||0));
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
// the example to-dos, dated from today
function demoTasks(now){
  now=now||Date.now();
  const today=demoYmd(now,0);
  const t=function(n,title,o){
    return Object.assign({id:DEMO_ID+n,title:title,done:false,due:null,dueTime:null,tag:null,ws:'personal',pin:null,subs:[],
      googleEventId:null,created:now-n,updatedAt:now},o||{});
  };
  const sub=function(id,title,done){ return {id:DEMO_ID+id,title:title,done:!!done,due:null}; };
  return [
    t(1,'Tick me off: tap the circle',{due:today}),
    t(2,'Plan the weekend trip (open me for the steps)',{due:demoYmd(now,3),tag:'trip',
      subs:[sub('2a','Book the campsite',true),sub('2b','Check the car'),sub('2c','Pack')]}),
    t(3,'Water the plants (repeats daily, counts your run)',{due:today,recur:{every:'day',dom:Number(today.slice(8)),series:DEMO_ID+'3',streak:4,best:4}}),
    t(4,'Call the dentist',{due:demoYmd(now,1),dueTime:'09:30',tag:'calls'}),
    t(5,'Walk 8,000 steps (ticks itself from your phone)',{due:today}),
    t(6,'Drag me up to reorder the list',{}),
    t(7,'Install Romulus',{done:true,doneAt:now,due:today})
  ];
}

if(typeof module!=='undefined'&&module.exports){ module.exports={demoTasks:demoTasks,isDemoTask:isDemoTask}; }

/* ── the page ── */
function demoDraw(){
  const bar=typeof document!=='undefined'&&document.getElementById('demoBar'); if(!bar)return;
  bar.hidden=!state.tasks.some(isDemoTask);
}
if(typeof document!=='undefined')(function(){
  const bar=$('demoBar'); if(!bar)return;
  const add=$('welcomeDemoBtn');
  if(add)add.addEventListener('click',function(){
    const have={}; state.tasks.forEach(function(t){ have[t.id]=1; });
    const gone={}; demoTasks().forEach(function(t){ gone[t.id]=1; });
    // taken away before and asked for again: the old deletions would remove them on the next sync
    state.tombstones=state.tombstones.filter(function(x){ return !gone[x.id]; });
    demoTasks().forEach(function(t){ if(!have[t.id])state.tasks.push(t); });
    if(state.activeTab!=='list')switchTab('list');
    touch(); window.scrollTo(0,0);
  });
  $('demoRemoveBtn').addEventListener('click',function(){
    const now=Date.now();
    state.tasks.filter(isDemoTask).forEach(function(t){ state.expanded.delete(t.id); state.tombstones.push({id:t.id,deletedAt:now}); });
    state.tasks=state.tasks.filter(function(t){ return !isDemoTask(t); });
    touch();
  });
})();
