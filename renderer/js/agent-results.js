/* Agent runner results from the desktop main process (Claude and the mini PC).
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── agent runner results (desktop only: main.js runs Claude, we apply + sync) ── */
if(window.desktop&&window.desktop.onAgentResults){
  window.desktop.onAgentWorking(function(p){
    // a plain list = Claude's run; {ids, lane:'local'} = the mini PC's
    const ids=Array.isArray(p)?p:(p&&p.ids)||[], lane=Array.isArray(p)?'claude':(p&&p.lane)||'claude';
    const reasons=(p&&p.reasons)||{};
    let changed=false;
    ids.forEach(function(id){
      const t=state.tasks.find(function(x){ return x.id===id; });
      if(t&&taskWs(t)==='agent'&&!t.done&&t.status==='queued'){
        t.status='working'; t.runFrom=Date.now(); // what he writes after this, the run can't see: it goes next
        if(!t.lane){ t.lane=lane; if(reasons[id])agentSay(t,'sys','Routed → '+(lane==='local'?'mini PC':'Claude')+' ('+reasons[id]+')'); }
        changed=true;
      }
      // the AI the runner is asking now: the pill shows it, and the task stays with it from here on
      if(t&&p&&p.cloud&&t.lane!=='local'&&t.status==='working'&&t.cloud!==p.cloud){ t.cloud=p.cloud; changed=true; }
    });
    if(changed)touch();
  });
  // no routing rule matched and his default is "ask me": the task waits for him to pick
  if(window.desktop.onRouteAsk)window.desktop.onRouteAsk(function(ids){
    let changed=false;
    ids.forEach(function(id){
      const t=state.tasks.find(function(x){ return x.id===id; });
      if(t&&taskWs(t)==='agent'&&!t.done&&t.status==='queued'&&!t.lane){
        t.status='needs-you'; t.routeAsk=true; t.note='Who should do this one? No routing rule matched.';
        agentSay(t,'sys','No routing rule matched: waiting for you to pick Claude or your mini PC');
        changed=true;
      }
    });
    if(changed)touch();
  });
  // what the mini PC's model is doing right now: shown live in that task's box, without re-rendering
  if(window.desktop.onAgentLive)window.desktop.onAgentLive(function(p){
    if(!p||!p.id)return;
    liveText[p.id]=String(p.text||'');
    const box=document.querySelector('.agent-live[data-id="'+p.id+'"]');
    if(box){ const stick=box.scrollTop+box.clientHeight>=box.scrollHeight-8; box.textContent=liveText[p.id]; if(stick)box.scrollTop=box.scrollHeight; }
  });
  // Claude is out of usage: these wait (no failure) until the reset, then run by themselves
  if(window.desktop.onAgentWaiting)window.desktop.onAgentWaiting(function(info){
    let changed=false;
    (info.ids||[]).forEach(function(id){
      const t=state.tasks.find(function(x){ return x.id===id; });
      if(!t||taskWs(t)!=='agent'||t.done)return;
      if(t.status!=='queued'||t.waitUntil!==info.until){ t.status='queued'; t.waitUntil=info.until; changed=true; }
    });
    if(changed)touch();
  });
  window.desktop.onAgentResults(function(updates){
    const prefLines=[];
    updates.forEach(function(u){
      const t=state.tasks.find(function(x){ return x.id===u.id; });
      // only answer tasks still waiting on this run (not ones James moved, finished or deleted meanwhile).
      // Queued counts too: a reply sent mid-run from a device without this fix puts it back in the queue,
      // and dropping the answer then threw away a whole run (10+ minutes on the mini PC)
      if(!t||taskWs(t)!=='agent'||t.done||(t.status!=='working'&&!(t.status==='queued'&&t.runFrom)))return; // switching AI clears runFrom
      // an answer only counts from the lane that holds the task (he may have switched it meanwhile)
      if((t.lane==='local')!==(u.lane==='local'))return;
      // the mini PC failed (not reachable, crashed): the cloud AIs take it from here, with his reply still on it
      if(u.handoff){
        t.lane='claude'; delete t.cloud; delete t.claimedBy; delete t.claimedAt; delete t.runFrom; delete liveText[t.id];
        t.status='queued'; t.waitUntil=null; t.stuck=null; t.shot=null;
        agentSay(t,'sys','Mini PC couldn’t finish ('+String(u.handoff).slice(0,160)+'): passing it to the next AI');
        return;
      }
      if(u.lane!=='local')t.cloud=u.via||'claude'; // whoever answered: its pill, which it keeps
      // what he wrote while it worked: the run never saw it, so it goes next, with this answer before it
      const late=t.runFrom?(t.history||[]).filter(function(h){ return h.who==='you'&&h.at>t.runFrom; }):[];
      const lateReply=late.length?late.map(function(h){ return h.text; }).join('\n'):(t.status==='queued'?t.reply:null);
      const lateImages=late.length?[].concat.apply([],late.map(function(h){ return Array.isArray(h.images)?h.images:[]; })):(t.status==='queued'?t.replyImages:null);
      // what it did on the way (the mini PC's live log), kept to read afterwards
      const thoughts=String(u.thoughts||liveText[t.id]||'').trim().slice(-6000);
      delete liveText[t.id]; delete t.runFrom;
      // "done" = finished: the task stays in the Agent tab until James checks it off himself
      t.status=u.status; t.done=false; t.note=u.note||null; delete t.parked; // a fresh answer needs a fresh look
      // it stopped for something in its way: why, what to do, and what its browser showed
      t.stuck=u.stuck&&(u.stuck.reason||u.stuck.fix)?{reason:String(u.stuck.reason||''),fix:String(u.stuck.fix||'')}:null;
      t.shot=u.shot&&/^https:\/\//i.test(String(u.shot))?String(u.shot):null;
      t.reply=null; t.replyImages=null; t.repeatDue=false; t.waitUntil=null;
      if('options' in u)t.options=u.options;
      (Array.isArray(u.asks)?u.asks:[]).forEach(function(q){ agentSay(t,'sys','Mini PC asked Claude: '+q); });
      const extra=Array.isArray(u.options)&&u.options.length?{options:u.options.map(function(o){ return o.label; })}:{};
      if(u.lane==='local')extra.lane='local';
      if(u.via==='gemini'||u.via==='openai'||u.via==='openrouter')extra.via=u.via;
      if(t.shot)extra.images=[t.shot];
      if(thoughts){
        extra.thoughts=thoughts;
        // only the newest few keep theirs: each is up to 6000 characters, synced with the task
        let kept=0; for(let i=(t.history||[]).length-1;i>=0;i--){ if(t.history[i].thoughts&&++kept>=3)delete t.history[i].thoughts; }
      }
      agentSay(t,'claude',u.note,Object.keys(extra).length?extra:null);
      if(lateReply){
        t.status='queued'; t.reply=lateReply; t.replyImages=lateImages&&lateImages.length?lateImages:null; t.stuck=null; t.shot=null;
        agentSay(t,'sys','You wrote while it was working: going again with that');
      }
      if(u.pref)prefLines.push(u.pref);
    });
    touch();
    if(prefLines.length)appendPrefs(prefLines);
  });
}
function fmtWhen(ms){
  if(!ms)return '';
  const d=new Date(ms), today=new Date(); today.setHours(0,0,0,0);
  const dd=new Date(d); dd.setHours(0,0,0,0);
  const diff=Math.round((dd-today)/864e5);
  const time=d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}).replace(' ','').toLowerCase();
  if(diff===0)return 'today '+time;
  if(diff===-1)return 'yesterday '+time;
  if(diff===1)return 'tomorrow '+time;
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' '+time;
}
// repeating agent tasks: when their time comes, put them back in Claude's queue (desktop only —
// it's the device that runs Claude). Missed runs while the computer was off happen once on start.
function runDueRepeats(){
  if(!window.desktop||!window.desktop.onAgentResults)return;
  let changed=false; const now=Date.now();
  state.tasks.forEach(function(t){
    if(taskWs(t)!=='agent'||!t.repeat||!t.nextRun||t.nextRun>now)return;
    t.nextRun=nextRepeatAt(t.repeat,now);
    changed=true;
    if(!t.done&&(t.status==='working'||t.status==='queued'))return; // a round is already going
    t.done=false; t.status='queued'; t.repeatDue=true; t.reply=null;
    agentSay(t,'sys','Scheduled run ('+repeatText(t.repeat)+')');
  });
  if(changed)touch();
}
if(window.desktop&&window.desktop.onAgentResults)setInterval(runDueRepeats,30*1000);
// is the mini PC reachable? (shown on its tasks; checked now and then while the app is open)
if(window.desktop&&window.desktop.localStatus){ setTimeout(refreshLocalStatus,3000); setInterval(refreshLocalStatus,60*1000); }
// watchdog: a run is killed after 15 min, so "working" for 17+ min means it was cut off — queue it again
if(window.desktop&&window.desktop.onAgentResults){
  setInterval(function(){
    let changed=false; const cutoff=Date.now()-17*60*1000;
    state.tasks.forEach(function(t){
      const cut=t.lane==='local'?Date.now()-45*60*1000:cutoff; // the mini PC is slow: give it longer
      if(taskWs(t)==='agent'&&!t.done&&t.status==='working'&&(t.lane!=='local'||window.desktop.localStatus)&&(t.updatedAt||0)<cut){ t.status='queued'; changed=true; }
    });
    if(changed)touch();
  },60*1000);
}
// New things Claude learned: "Section|text" goes under "## Section" (made if missing); a line that's
// already there (same words, any case) is skipped, so the memory doesn't fill with repeats
async function appendPrefs(lines){
  const p=prefsProfile(); if(!p)return;
  try{
   for(let attempt=0;attempt<4;attempt++){ // compare-and-swap: never overwrite a change made meanwhile
    const row=await syncPullRow(p), d=row.doc; let text=((d&&d.text)||'').replace(/\s+$/,'');
    const norm=function(x){ return String(x).toLowerCase().replace(/[^a-z0-9$]+/g,' ').trim(); };
    let changed=false;
    lines.forEach(function(l){
      const bar=String(l).indexOf('|');
      const section=bar>0?String(l).slice(0,bar).trim():'Other';
      const item=String(bar>0?String(l).slice(bar+1):l).replace(/^\s*-\s*/,'').trim();
      if(!item)return;
      if(text.split('\n').some(function(x){ return norm(x.replace(/^\s*-\s*/,''))===norm(item); }))return; // already known
      const rows=text?text.split('\n'):[];
      const h=rows.findIndex(function(x){ return /^##\s+/.test(x)&&norm(x.replace(/^##\s+/,''))===norm(section); });
      if(h<0){ rows.push('', '## '+section, '- '+item); }
      else { let end=h+1; while(end<rows.length&&!/^##\s+/.test(rows[end]))end++; while(end>h+1&&!rows[end-1].trim())end--; rows.splice(end,0,'- '+item); }
      text=rows.join('\n').replace(/^\n+/,''); changed=true;
    });
    if(!changed||await syncPushCas(p,{v:1,text:text},row.updatedAt))return;
   }
   console.error('prefs append: the list kept changing');
  }catch(e){ console.error('prefs append failed',e); }
}
