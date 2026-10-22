/* First launch, and the Agent tab before anything is connected.
   - The welcome card (once, ever): three things to set up and four things worth knowing.
   - The Agent tab on this computer works without device sync (the agent runs here); what it does need
     is an AI. With none connected its empty state becomes "Pick an AI", and once tasks are waiting a
     nudge says they can't run yet. Sync is offered as "also on your phone".
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';
const WELCOME_KEY='tasks.welcomed.v1';
const isDesktopApp=!!(window.desktop&&window.desktop.aiStatus);

// open ⚙ Settings with one group expanded and one panel in view
function openSettingsAt(groupId,panelId){
  setSettingsOpen(true);
  const g=groupId&&$(groupId); if(g&&'open' in g)g.open=true;
  const p=panelId&&$(panelId); if(p&&'open' in p)p.open=true;
  requestAnimationFrame(function(){ const n=p||g; if(n)n.scrollIntoView({block:'start',behavior:'smooth'}); });
}

/* ── welcome card ── */
(function(){
  let seen=true; try{ seen=!!localStorage.getItem(WELCOME_KEY); }catch(e){}
  const card=$('welcomeCard'); if(!card)return;
  if(seen)return;
  if(!isDesktopApp){ // phone: the AI lives on the computer; the tray tip doesn't apply
    $('welcomeAiBtn').hidden=true; $('welcomeSyncBtn').textContent='Sync with my computer';
    $('welcomeTrayTip').textContent='Home-screen widgets show your list and let you add to it; the Agent runs on your computer and syncs here.';
  }
  card.hidden=false;
  const done=function(){ try{ localStorage.setItem(WELCOME_KEY,String(Date.now())); }catch(e){} card.hidden=true; };
  $('welcomeTasksBtn').addEventListener('click',done);
  $('welcomeAiBtn').addEventListener('click',function(){ done(); switchTab('agent'); openSettingsAt('agentGroup','aiSection'); });
  $('welcomeSyncBtn').addEventListener('click',function(){ done(); openSettingsAt(null,'syncSection'); });
})();

/* ── Agent tab: an AI, or not yet ── */
// wiring.js keeps window.agentAiReady current (any cloud AI switched on and able to run); the local model counts too
function anyAiReady(){
  return !!window.agentAiReady||!!(typeof localStat!=='undefined'&&localStat&&localStat.configured&&localStat.online);
}
// called from lists.js render(): onAgent = the Agent tab is showing, tasks = its tasks, es = the empty-state line
function drawAgentSetup(onAgent,tasks,es){
  const card=$('agentSetupCard'), nudge=$('agentNudge'), hint=$('agentSyncHint');
  if(!card)return;
  const show=onAgent&&isDesktopApp;
  const ready=anyAiReady(), known=window.agentAiReady!==undefined; // undefined: status not back yet, say nothing
  const none=show&&known&&!ready;
  card.hidden=!(none&&tasks.length===0);
  if(!card.hidden)es.hidden=true;
  const waiting=tasks.filter(function(t){ return !t.done&&(t.status||'queued')==='queued'; }).length;
  nudge.hidden=!(none&&waiting>0);
  if(!nudge.hidden)$('agentNudgeText').textContent=(waiting===1?'1 task is':waiting+' tasks are')+' waiting, but no AI is connected to do them.';
  hint.hidden=!(show&&known&&ready&&!agentConfigured());
}
if(isDesktopApp){
  $('agentSetupBtn').addEventListener('click',function(){ openSettingsAt('agentGroup','aiSection'); });
  $('agentNudgeBtn').addEventListener('click',function(){ openSettingsAt('agentGroup','aiSection'); });
  $('agentSyncLink').addEventListener('click',function(e){ e.preventDefault(); openSettingsAt(null,'syncSection'); });
}
