/* Standing jobs (agent/jobs.js): the first task after a calendar or mailbox is connected. With the Agent list
   still empty, connect-accounts.js calls jobsOfferAfterConnect() once and the setup task goes in the queue; the
   Agent tab's empty state has a button for it any time. The run's suggestions show in that task's conversation
   (jobsBox, from lists.js), one Start button each: Start makes the job an Agent task with a repeat and queues its
   first run (agent-results.js runs the schedule from then on). Desktop only: the Agent runs here.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';
const JOBS_OFFERED_KEY='agent.jobs.offered.v1';
const JOBS_TITLE='Suggest jobs from my calendar and inbox';
let jobsAccounts=null; // what's connected, for the empty state: null = not looked yet; {any, mail}
const jobsDesktop=function(){ return !!(window.desktop&&window.desktop.onAgentResults&&window.desktop.calOverview); };
const jobsSetupHere=function(){ return state.tasks.find(function(t){ return t.jobsSetup&&taskWs(t)==='agent'&&!t.done; })||null; };
// the setup task (agent/jobs.js setupTask, the same shape): an inbox run when a mailbox is connected, on the cloud lane
function jobsSetupTask(mail){
  const now=Date.now();
  return {id:uid(),title:JOBS_TITLE,done:false,due:null,dueTime:null,tag:null,ws:'agent',subs:[],googleEventId:null,created:now,
    status:'queued',note:null,reply:null,options:null,jobsSetup:true,useInbox:mail?true:null,lane:'claude',routedLane:'claude',laneOk:true,
    history:[{who:'sys',text:'The Agent looks at your calendar and inbox and suggests a few jobs it could do for you on a schedule. Nothing starts until you press Start on one.',at:now}]};
}
// the Agent task a Start makes (agent/jobs.js jobTask): queued now, then on its schedule
function jobsTaskFor(setup,j){
  const now=Date.now(), repeat={every:j.every,at:j.at||'08:00',day:j.every==='week'?(j.day==null?1:j.day):null};
  return {id:uid(),title:j.title,done:false,due:null,dueTime:null,tag:setup.tag||null,ws:'agent',subs:[],googleEventId:null,created:now,
    status:'queued',note:null,reply:null,options:null,repeat:repeat,nextRun:nextRepeatAt(repeat,now),
    notes:j.why?'Why the Agent suggested it: '+j.why:null,
    history:[{who:'sys',text:'Started from the Agent’s suggestions: runs now, then '+repeatText(repeat).toLowerCase()+'.',at:now}]};
}
// a calendar or mailbox is connected? (and is one of them mail: Gmail ticked on a Google account, or Outlook)
async function jobsLookAccounts(){
  if(!jobsDesktop())return (jobsAccounts={any:false,mail:false});
  try{
    const o=await window.desktop.calOverview(false);
    const a=(o&&o.accounts||[]).filter(function(x){ return !x.broken; });
    jobsAccounts={any:a.length>0,mail:a.some(function(x){ return !!x.gmail||x.provider==='microsoft'; })};
  }catch(e){ jobsAccounts={any:false,mail:false}; }
  return jobsAccounts;
}
// queue the setup task: from a connect (once), or the empty state's button
async function jobsStart(from){
  if(jobsSetupHere()){ voiceToast('The Agent is already on it: see the Agent tab.'); return false; }
  const acc=await jobsLookAccounts();
  if(!acc.any){ voiceToast('Connect a calendar or email account first (Settings → Calendars & email).',true); return false; }
  state.tasks.push(jobsSetupTask(acc.mail)); touch();
  try{ localStorage.setItem(JOBS_OFFERED_KEY,String(Date.now())); }catch(e){}
  voiceToast(from==='connect'?'The Agent will look at your calendar and inbox and suggest a few jobs it could take on.':'Queued: the Agent will suggest a few jobs.');
  return true;
}
// connect-accounts.js: a calendar or mailbox was just connected. Only where the Agent runs, with an AI ready, an empty Agent list, and once
function jobsOfferAfterConnect(){
  if(!jobsDesktop())return;
  if(typeof anyAiReady==='function'&&!anyAiReady())return;
  if(state.tasks.some(function(t){ return taskWs(t)==='agent'; }))return;
  let did=null; try{ did=localStorage.getItem(JOBS_OFFERED_KEY); }catch(e){}
  if(did)return;
  jobsAccounts=null; jobsStart('connect');
}
// the Agent tab's empty state (lists.js render): "Suggest jobs from my calendar and inbox", when something is connected
function drawJobsOffer(show){
  const box=$('agentJobsOffer'); if(!box)return;
  const ok=show&&jobsDesktop()&&(typeof anyAiReady!=='function'||anyAiReady());
  if(!ok){ box.hidden=true; return; }
  if(jobsAccounts===null){ jobsAccounts={any:false,mail:false,looking:true}; jobsLookAccounts().then(function(){ if(typeof render==='function')render(); }); }
  box.hidden=!jobsAccounts.any;
}
// in the setup task's conversation: the jobs a run proposed (agent-results.js puts h.jobs on its answer), a Start each
function jobsBox(t,h){
  const box=el('div','conv-opts goal-plan');
  h.jobs.forEach(function(j,i){
    const row=el('div','goal-step');
    row.appendChild(el('div',null,(i+1)+'. '+j.title+' — '+repeatText({every:j.every,at:j.at,day:j.day})));
    if(j.why)row.appendChild(el('div','goal-needs',j.why));
    if((h.jobsStarted||[]).indexOf(i)!==-1)row.appendChild(el('div','goal-hint','Started.'));
    else{
      const r=el('div','conv-pref-btns'), b=el('button','ghost mono','Start');
      b.addEventListener('click',function(e){ e.stopPropagation(); jobsStartOne(t,h,i); });
      r.appendChild(b); row.appendChild(r);
    }
    box.appendChild(row);
  });
  box.appendChild(el('div','goal-total','Each one you start becomes an Agent task of its own, on that schedule: change or stop it there. Or reply with what you’d rather it did.'));
  return box;
}
function jobsStartOne(t,h,i){
  const j=h.jobs[i]; if(!j||(h.jobsStarted||[]).indexOf(i)!==-1)return;
  const task=jobsTaskFor(t,j);
  state.tasks.push(task); h.jobsStarted=(h.jobsStarted||[]).concat([i]);
  agentSay(t,'sys','Started: '+j.title+' ('+repeatText(task.repeat).toLowerCase()+')');
  buzz('tap'); touch();
}
if(typeof document!=='undefined'&&$('agentJobsBtn'))$('agentJobsBtn').addEventListener('click',function(){ jobsStart('button'); });
