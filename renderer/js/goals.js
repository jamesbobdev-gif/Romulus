/* Goals (agent/goals.js): "Goal: …" Agent tasks are planned first, then run as a chain of step tasks.
   The plan comes back on the goal's conversation (planBox, from lists.js) with a Start button; Start makes
   the step tasks (goalId, goalStep), the first queued and the rest waiting their turn (goalWait). The
   desktop app moves the chain along: when a step is finished (its answer said nothing is left, or he checked
   it off), the next one is queued; a step that needs him waits. The goal task itself shows "3 of 5".
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

const GOAL_TAG=/(^|\s)#goal\b/i, GOAL_LEAD=/^\s*goal\s*[:\-–]\s*/i;
function isGoalTask(t){ return !!t&&taskWs(t)==='agent'&&(GOAL_TAG.test(String(t.title||''))||GOAL_LEAD.test(String(t.title||''))); }
const goalTopic=function(t){ return String(t.title||'').replace(GOAL_TAG,' ').replace(GOAL_LEAD,'').replace(/\s+/g,' ').trim(); };
const goalSteps=function(goal){ return state.tasks.filter(function(t){ return t.goalId===goal.id&&taskWs(t)==='agent'; }).sort(function(a,b){ return (a.goalStep||0)-(b.goalStep||0); }); };
const stepFinished=function(t){ return !!t.done||(t.status==='done'&&!t.goalWait); };
const stepBusy=function(t){ return !t.done&&['queued','working','needs-you'].indexOf(t.status)!==-1; };
function goalProgress(goal){
  const steps=goalSteps(goal), fin=steps.filter(stepFinished).length, going=steps.find(stepBusy)||null;
  return {total:steps.length,finished:fin,busy:going,next:!going?(steps.find(function(t){ return t.goalWait&&!t.done; })||null):null,all:steps.length>0&&fin===steps.length};
}
function goalSummary(plan){
  const total=plan.reduce(function(n,s){ return n+(s.minutes||0); },0);
  return 'About '+total+' minutes of Agent time across '+plan.length+' step'+(plan.length>1?'s':'')+'.';
}
// Start: the plan becomes step tasks; the goal watches them
function startGoal(goal,plan){
  const now=Date.now(), n=plan.length, topic=goalTopic(goal);
  plan.forEach(function(s,i){
    state.tasks.push({id:uid(),title:s.title,done:false,due:null,dueTime:null,tag:goal.tag||null,ws:'agent',subs:[],googleEventId:null,created:now+i,
      status:i===0?'queued':'done',goalWait:i===0?undefined:true,goalId:goal.id,goalStep:i+1,note:null,reply:null,options:null,
      notes:'Step '+(i+1)+' of '+n+' toward his goal: "'+topic+'".'+(s.why?' '+s.why:'')+(i>0?'\nEarlier steps: '+plan.slice(0,i).map(function(x,j){ return (j+1)+'. '+x.title; }).join('; ')+'.':'')+(goal.notes?'\n\nHis instructions for the whole goal:\n'+String(goal.notes).slice(0,1500):''),
      history:[{who:'sys',text:'Step '+(i+1)+' of '+n+' of the goal "'+topic+'"'+(i===0?'':' — waits for step '+i),at:now+i}]});
  });
  goal.goalStarted=true; goal.goalPlan=plan; goal.status='done'; goal.done=false; goal.reply=null; delete goal.goalDone;
  agentSay(goal,'sys','Started: '+n+' steps, one after another. Step 1 is queued.');
  touch();
}
// in the goal's conversation: the plan a run proposed (agent-results.js puts h.plan on its answer)
function planBox(t,h){
  const box=el('div','conv-opts goal-plan');
  h.plan.forEach(function(s,i){
    const row=el('div','goal-step',(i+1)+'. '+s.title+(s.why?' — '+s.why:'')+' (≈'+s.minutes+' min)');
    if(s.needs)row.appendChild(el('div','goal-needs','needs: '+s.needs));
    box.appendChild(row);
  });
  box.appendChild(el('div','goal-total',goalSummary(h.plan)));
  const started=t.goalStarted&&t.goalPlan===h.plan||(t.goalStarted&&h.planStarted);
  if(started||h.planStarted)box.appendChild(el('div',null,'Started.'));
  else if(t.goalStarted)box.appendChild(el('div',null,'An earlier plan was started instead.'));
  else{
    const row=el('div','conv-pref-btns');
    const go=el('button','ghost mono','Start these steps');
    go.addEventListener('click',function(e){ e.stopPropagation(); h.planStarted=true; startGoal(t,h.plan); render(); });
    row.appendChild(go); row.appendChild(el('span','goal-hint','or reply with changes and it plans again'));
    box.appendChild(row);
  }
  return box;
}
// the chain moves along on the desktop (the device that runs the Agent): the next step is queued when the
// one before is finished; a goal whose steps are all finished says so once
function advanceGoals(){
  if(!window.desktop||!window.desktop.onAgentResults)return;
  let changed=false;
  state.tasks.forEach(function(goal){
    if(!isGoalTask(goal)||!goal.goalStarted||goal.done)return;
    const p=goalProgress(goal);
    if(p.next){ const s=p.next; delete s.goalWait; s.status='queued'; s.done=false; agentSay(s,'sys','Its turn: step '+s.goalStep+' of '+p.total); agentSay(goal,'sys','Step '+s.goalStep+' of '+p.total+' queued'); changed=true; }
    else if(p.all&&!goal.goalDone){ goal.goalDone=true; goal.status='done'; agentSay(goal,'sys','All '+p.total+' steps are finished. Check the goal off when you’re happy with it.'); voiceToast('Goal finished: '+goalTopic(goal),true); changed=true; }
  });
  if(changed)touch();
}
if(window.desktop&&window.desktop.onAgentResults)setInterval(advanceGoals,30*1000);
