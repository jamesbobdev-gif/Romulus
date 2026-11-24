/* Asked this already: "can I get groceries" typed on Tuesday, when "Get groceries" went in on Sunday, points
   back at Sunday's task (task-actions.js addTask offers "Open it" or "Add anyway") instead of making a second one.
   Same tab only: a "Get groceries" to-do on his list is a different thing from the Agent's order.
   How far back counts:
     - not done yet: made in the last 7 days (a week's worth of the same errand)
     - done: finished in the last 2 days (he may want the answer again, not a new run)
     - both have dates more than 6 days apart: different ones (rent on the 1st vs rent next month)
   One of the page scripts in renderer/js; also loaded by test/same-ask.test.js. */
'use strict';

const SAME_OPEN_DAYS=7, SAME_DONE_DAYS=2, SAME_DUE_GAP=6;
// the asking words around a request, not what is asked for
const SAME_FILLER=new Set(('a an the some my me our us i you we it this that these those to for of on in at with and or please pls '+
  'can could would will should may might do does did is are am be been get got getting gets grab buy buying bought order ordering ordered '+
  'need needs want wants wanna gotta have has had go going make let lets help remind tell show find look up out '+
  'today tonight tomorrow week weekend now soon again any how what when where which who why if just also new next this').split(' '));

function sameWords(title){
  const s=String(title||'').toLowerCase()
    .replace(/(^|\s)#(legion|research)\b/g,' ')
    .replace(/^\s*(deep research|legion|research legion)\s*[:\-–]?\s*/,'')
    .replace(/['’]s\b/g,'').replace(/['’]/g,'').replace(/[^a-z0-9]+/g,' ');
  const out=new Set();
  s.split(' ').forEach(function(w){
    if(!w||SAME_FILLER.has(w))return;
    // groceries / grocery, eggs / egg, flights / flight
    if(w.length>4&&/ies$/.test(w))w=w.slice(0,-3)+'y';
    else if(w.length>3&&/[^s]s$/.test(w))w=w.slice(0,-1);
    if(!SAME_FILLER.has(w))out.add(w);
  });
  return out;
}
// the same ask: the same words once the asking is taken out, or one is the other with one word more
function sameAsk(a,b){
  const A=sameWords(a), B=sameWords(b);
  if(!A.size||!B.size)return false;
  let both=0; A.forEach(function(w){ if(B.has(w))both++; });
  const small=Math.min(A.size,B.size), big=Math.max(A.size,B.size);
  if(both===small&&big-small<=1)return true;
  return both/(A.size+B.size-both)>=0.75;
}
function sameDayGap(a,b){ return Math.abs(Date.parse(a+'T00:00:00')-Date.parse(b+'T00:00:00'))/864e5; }
/* the task he already has for this, or null. o: {title, ws, due, now} */
function findSameAsk(tasks,o){
  const now=o.now||Date.now(), day=864e5;
  let best=null;
  (tasks||[]).forEach(function(t){
    if(!t||!t.title)return;
    const w=t.ws==='work'?'work':t.ws==='agent'?'agent':t.ws==='school'?'school':'personal';
    if(w!==o.ws)return;
    if(t.done){ if(!(t.doneAt&&now-t.doneAt<=SAME_DONE_DAYS*day))return; }
    else if(!(t.created&&now-t.created<=SAME_OPEN_DAYS*day))return;
    if(o.due&&t.due&&sameDayGap(o.due,t.due)>SAME_DUE_GAP)return;
    if(!sameAsk(o.title,t.title))return;
    // the one still open wins, then the newest
    if(!best||(best.done&&!t.done)||(best.done===t.done&&(t.created||0)>(best.created||0)))best=t;
  });
  return best;
}
// "earlier today" / "yesterday" / "on Tuesday", for the notice
function sameWhen(ms,now){
  now=now||Date.now();
  const d0=new Date(now); d0.setHours(0,0,0,0);
  const days=Math.round((d0-new Date(ms).setHours(0,0,0,0))/864e5);
  if(days<=0)return 'earlier today';
  if(days===1)return 'yesterday';
  return 'on '+new Date(ms).toLocaleDateString(undefined,{weekday:'long'});
}

if(typeof module!=='undefined'&&module.exports)module.exports={findSameAsk:findSameAsk,sameAsk:sameAsk,sameWords:sameWords,sameWhen:sameWhen};
