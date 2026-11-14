/* Tasks added from outside the app (main/outside-adds.js: Claude Desktop, through agent/tasks-mcp.js). Each comes
   as {file, title, list, due, time, notes, from} and goes on the list it names like a task typed there: the Agent
   list queues it for the Agent, with a line in its conversation saying where it came from. Then the file is
   reported done. Settings → Agent & AI → Add from Claude Desktop: the status line and Set up / Remove.
   The task's shape sits above the DOM code and is also loaded by test/outside-adds.test.js.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';
const OUTSIDE_WS={todo:'personal',agent:'agent',work:'work',school:'school'};
// one dropped item → the task for its list, or null when it isn't one. o.uid / o.now for tests
function outsideTask(p,o){
  o=o||{}; const now=o.now||Date.now(), mk=o.uid||uid;
  if(!p||typeof p!=='object')return null;
  const title=String(p.title||'').replace(/\s+/g,' ').trim().slice(0,200); if(!title)return null;
  const ws=OUTSIDE_WS[p.list]||'personal';
  const due=/^\d{4}-\d{2}-\d{2}$/.test(String(p.due||''))?String(p.due):null;
  const t={id:mk(),title:title,done:false,due:due,dueTime:due&&/^([01]\d|2[0-3]):[0-5]\d$/.test(String(p.time||''))?String(p.time):null,tag:null,ws:ws,subs:[],googleEventId:null,created:now};
  const notes=String(p.notes||'').trim().slice(0,2000);
  if(notes&&(ws==='agent'||ws==='school'))t.notes=notes; // the other lists keep no notes
  if(ws==='school')t.kind='regular';
  if(ws==='agent'){ t.status='queued'; t.note=null; t.history=[{who:'sys',text:'Added from '+String(p.from||'another app').slice(0,60),at:now}]; }
  return t;
}
if(typeof module!=='undefined'&&module.exports)module.exports={outsideTask,OUTSIDE_WS};

if(typeof window!=='undefined'&&window.desktop&&window.desktop.onOutsideTasks){
  const seen={}; // files already put on the list, until the desktop takes them away
  const take=function(items){
    let added=0, last=null;
    (items||[]).forEach(function(p){
      if(!p||!p.file||seen[p.file])return;
      seen[p.file]=1;
      const t=outsideTask(p);
      if(t){ state.tasks.push(t); added++; last=t; }
      window.desktop.outsideDone(p.file).catch(function(){});
    });
    if(!added)return;
    touch();
    const from=String((items.find(function(p){ return p&&p.from; })||{}).from||'another app').slice(0,60);
    voiceToast(added===1?'Added from '+from+': '+last.title+(last.ws==='agent'?' (for the Agent)':''):added+' tasks added from '+from+'.',false);
  };
  window.desktop.onOutsideTasks(take);
  window.desktop.outsidePending().then(take).catch(function(){});

  /* Settings → Agent & AI → Add from Claude Desktop */
  const sec=$('mcpSection');
  if(sec){
    sec.hidden=false;
    const say=function(m,isErr){ const n=$('mcpStatus'); n.textContent=m||''; n.style.color=isErr?'var(--late)':'var(--muted)'; };
    const draw=function(st){
      $('mcpSetupBtn').textContent=st.on?'Set up again':'Set up';
      $('mcpRemoveBtn').hidden=!st.on;
      say(!st.installed?'Claude Desktop isn’t installed on this computer.':st.on?'On. Ask Claude Desktop to add something to your Romulus list.':'Off.');
    };
    const load=function(){ window.desktop.mcpStatus().then(draw).catch(function(){ say('could not check',true); }); };
    $('mcpSetupBtn').addEventListener('click',async function(){
      const b=this; b.disabled=true; say('setting up…');
      try{ const r=await window.desktop.mcpSetup(); draw(r.status); if(r.ok)say('Done. Restart Claude Desktop, then ask it to add a task to Romulus.'); else say(r.error||'didn’t work',true); }
      catch(e){ say('didn’t work: '+e.message,true); }
      b.disabled=false;
    });
    $('mcpRemoveBtn').addEventListener('click',async function(){
      const b=this; b.disabled=true;
      try{ const r=await window.desktop.mcpRemove(); draw(r.status); if(r.ok)say('Removed. Restart Claude Desktop.'); else say(r.error||'didn’t work',true); }
      catch(e){ say('didn’t work: '+e.message,true); }
      b.disabled=false;
    });
    load();
  }
}
