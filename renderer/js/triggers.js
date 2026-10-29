/* Triggers: an Agent task that starts when something happens (agent/triggers.js): an email about X arrives,
   a calendar event is N hours away, a web page says Y. The "Starts when" row in the task panel (lists.js)
   sets t.trigger; the desktop app looks every few minutes (main/triggers.js) and what fired is queued here
   with t.triggered, the way a repeat's scheduled round is. An armed task shows as "watching".
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

const TRIGGER_LABELS={mail:'email',calendar:'calendar',page:'web page'};
const TRIGGER_HINTS={mail:'e.g. Acmebank statement · a reply from the landlord',calendar:'e.g. dentist · flight to Denver',page:'e.g. the price is under $40 · says In Stock'};
function triggerText(tr){
  if(!tr||!tr.kind)return '';
  const what=String(tr.what||'');
  if(tr.kind==='mail')return 'when an email arrives: '+what;
  if(tr.kind==='calendar')return (tr.before?tr.before+' h before':'at')+' a calendar event: '+what;
  return 'when '+String(tr.url||'').replace(/^https?:\/\/(www\.)?/,'').slice(0,60)+' says: '+what;
}
const triggerArmed=function(t){ return taskWs(t)==='agent'&&!t.done&&!!(t.trigger&&t.trigger.kind)&&['queued','working','needs-you'].indexOf(t.status)===-1; };
let triggerChecked=0; // when the desktop last looked (shown in the panel)

if(window.desktop&&window.desktop.triggersTick){
  const trTick=async function(){
    if(!state.tasks.some(triggerArmed))return;
    try{
      const r=await window.desktop.triggersTick();
      if(r&&r.checked)triggerChecked=r.checked;
      if(!r||!Array.isArray(r.fired)||!r.fired.length)return;
      let changed=false;
      r.fired.forEach(function(f){
        const t=state.tasks.find(function(x){ return x.id===f.id; });
        if(!t||!triggerArmed(t))return;
        t.triggered={kind:f.kind,what:String(f.what||'').slice(0,300),link:f.link||null,at:Date.now()};
        t.done=false; t.status='queued'; t.repeatDue=true; t.reply=null;
        agentSay(t,'sys','Triggered: '+t.triggered.what);
        voiceToast('Started: '+t.title,true);
        changed=true;
      });
      if(changed)touch();
    }catch(e){}
  };
  // 90 s after start (sync has loaded the lists by then), then every 5 minutes; an unchanged mailbox costs one tiny call
  setTimeout(trTick,90*1000); setInterval(trTick,5*60*1000);
}
