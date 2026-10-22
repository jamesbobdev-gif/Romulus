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
        if(!t.lane){ t.lane=lane; if(reasons[id])agentSay(t,'sys','Routed → '+(lane==='local'?'The local model':'Claude')+' ('+reasons[id]+')'); }
        changed=true;
      }
      // the AI the runner is asking now: the pill shows it, and the task stays with it from here on
      // Claude taking over doesn't pin the task to Claude (only his pick on the pill does), so with "Save Claude for last" his next reply tries the others first
      if(t&&p&&p.cloud&&t.lane!=='local'&&t.status==='working'&&t.cloud!==p.cloud){ if(p.cloud!=='claude')t.cloud=p.cloud; else delete t.cloud; changed=true; }
      if(t&&p&&p.limitMs)runLimit[id]=Date.now()+p.limitMs; // a grocery run gets 40 min, not 15: the watchdog waits for it
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
        agentSay(t,'sys','No routing rule matched: waiting for you to pick Claude or the local model');
        changed=true;
      }
    });
    if(changed)touch();
  });
  // an AI's key expired or its sign-in ran out: a to-do on his Human list says to reconnect it (one per AI)
  if(window.desktop.onAgentReconnect)window.desktop.onAgentReconnect(function(p){
    const title=String((p&&p.title)||''); if(!title)return;
    const prefix=title.slice(0,title.indexOf(':')+1);
    if(state.tasks.some(function(t){ return !t.done&&taskWs(t)==='personal'&&t.title.startsWith(prefix); }))return;
    state.tasks.push({id:uid(),title:title,done:false,due:null,dueTime:null,tag:null,ws:'personal',subs:[],googleEventId:null,created:Date.now()});
    voiceToast(title,true); touch();
  });
  // it answered again: that to-do is done
  if(window.desktop.onAgentReconnected)window.desktop.onAgentReconnected(function(p){
    const prefix=String((p&&p.prefix)||''); if(!prefix)return;
    let changed=false;
    state.tasks.forEach(function(t){ if(!t.done&&taskWs(t)==='personal'&&t.title.startsWith(prefix)){ t.done=true; changed=true; } });
    if(changed)touch();
  });
  // what the mini PC's model (or Claude) is doing right now: shown live in that task's box, without re-rendering.
  // Claude's also carry its checklist and which of his mid-run messages it has taken
  if(window.desktop.onAgentLive)window.desktop.onAgentLive(function(p){
    if(!p||!p.id)return;
    const first=!liveText[p.id]&&!!p.text;
    liveText[p.id]=String(p.text||'');
    let redraw=first; // Claude's step box appears with its first step
    if(Array.isArray(p.plan)){
      livePlan[p.id]=p.plan;
      const pl=document.querySelector('.agent-plan[data-id="'+p.id+'"]');
      if(pl)fillPlan(pl,p.plan);
    }
    if(Array.isArray(p.heard)&&p.heard.length!==(liveHeard[p.id]||[]).length){ liveHeard[p.id]=p.heard; redraw=true; }
    const box=document.querySelector('.agent-live[data-id="'+p.id+'"]');
    if(box&&!redraw){ const stick=box.scrollTop+box.clientHeight>=box.scrollHeight-8; box.textContent=liveText[p.id]; if(stick)box.scrollTop=box.scrollHeight; }
    else if(redraw&&typeof render==='function')render();
  });
  // Claude is out of usage: these wait (no failure) until the reset, then run by themselves
  if(window.desktop.onAgentWaiting)window.desktop.onAgentWaiting(function(info){
    let changed=false;
    (info.ids||[]).forEach(function(id){
      const t=state.tasks.find(function(x){ return x.id===id; });
      if(!t||taskWs(t)!=='agent'||t.done)return;
      if(t.status!=='queued'||t.waitUntil!==info.until){ t.status='queued'; t.waitUntil=info.until; changed=true; }
      // the computer slept mid-run: it starts over now (no failure, same AI)
      if(info.slept){ delete t.runFrom; delete liveText[t.id]; if(typeof livePlan!=='undefined')delete livePlan[t.id];
        agentSay(t,'sys','Your computer went to sleep while it worked: starting again now it’s awake'); changed=true; }
    });
    if(changed)touch();
  });
  window.desktop.onAgentResults(function(updates){
    const prefLines=[];
    updates.forEach(function(u){
      const t=state.tasks.find(function(x){ return x.id===u.id; });
      // only answer tasks still waiting on this run (not ones the user moved, finished or deleted meanwhile).
      // Queued counts too: a reply sent mid-run from a device without this fix puts it back in the queue,
      // and dropping the answer then threw away a whole run (10+ minutes on the mini PC)
      if(!t||taskWs(t)!=='agent'||t.done||(t.status!=='working'&&!(t.status==='queued'&&t.runFrom)))return; // switching AI clears runFrom
      // an answer only counts from the lane that holds the task (he may have switched it meanwhile)
      if((t.lane==='local')!==(u.lane==='local'))return;
      // the mini PC failed (not reachable, crashed): the cloud AIs take it from here, with his reply still on it
      if(u.handoff){
        t.lane='claude'; delete t.cloud; delete t.claimedBy; delete t.claimedAt; delete t.runFrom; delete liveText[t.id];
        t.status='queued'; t.waitUntil=null; t.stuck=null; t.shot=null;
        agentSay(t,'sys','The local model couldn’t finish ('+String(u.handoff).slice(0,160)+'): passing it to the next AI');
        return;
      }
      if(u.lane!=='local'){ const via=u.via||'claude'; if(via!=='claude')t.cloud=via; else if(t.cloud!=='claude')delete t.cloud; } // whoever answered: its pill, which it keeps (Claude only when he picked it)
      // what he wrote while it worked: the run never saw it, so it goes next, with this answer before it.
      // Claude takes his messages mid-run (agent/run-live.js): the ones it took (u.heard) are done with
      const heard=Array.isArray(u.heard)?u.heard:[];
      (t.history||[]).forEach(function(h){ if(h.who==='you'&&heard.indexOf(h.at)!==-1)h.heard=true; });
      delete livePlan[t.id]; delete liveHeard[t.id];
      const late=t.runFrom?(t.history||[]).filter(function(h){ return h.who==='you'&&h.at>t.runFrom&&!h.heard; }):[];
      const lateReply=late.length?late.map(function(h){ return h.text; }).join('\n'):(t.status==='queued'?t.reply:null);
      const lateImages=late.length?[].concat.apply([],late.map(function(h){ return Array.isArray(h.images)?h.images:[]; })):(t.status==='queued'?t.replyImages:null);
      // what it did on the way (the mini PC's live log), kept to read afterwards
      const thoughts=String(u.thoughts||liveText[t.id]||'').trim().slice(-6000);
      delete liveText[t.id]; delete t.runFrom;
      // "done" = finished: the task stays in the Agent tab until the user checks it off himself
      const reviewNote=t.note; // the order's review ("total … Reply yes"), for its total once it's placed
      t.status=u.status; t.done=false; t.note=u.note||null; delete t.parked;
      if(u.financeSeen)t.financeSeen=true; // The local model read his Finance for it: it never goes to a cloud AI (agent/routing.js) // a fresh answer needs a fresh look
      // it stopped for something in its way: why, what to do, and what its browser showed
      t.stuck=u.stuck&&(u.stuck.reason||u.stuck.fix)?{reason:String(u.stuck.reason||''),fix:String(u.stuck.fix||'')}:null;
      t.shot=u.shot&&/^https:\/\//i.test(String(u.shot))?String(u.shot):null;
      t.page=u.page&&/^https:\/\//i.test(String(u.page))?String(u.page):null; // ◉ Watch opens it
      t.reply=null; t.replyImages=null; t.repeatDue=false; t.waitUntil=null;
      if('options' in u)t.options=u.options;
      // questions to tap through, and an order to deselect from: each answer brings its own (or none)
      t.ask=Array.isArray(u.ask)&&u.ask.length?u.ask:null; if(typeof askDrafts!=='undefined')delete askDrafts[t.id];
      // the order went through (it marked what was bought): its cards are his last order, pictures and all
      // and an order placed after his yes (Amazon): done, and its cart gone
      if((u.list&&Array.isArray(u.list.bought)&&u.list.bought.length)||(u.status==='done'&&Array.isArray(t.cart)&&t.cart.length&&!(Array.isArray(u.cart)&&u.cart.length)))keepLastOrder(t,(u.note||'')+'\n'+(reviewNote||''));
      t.cart=Array.isArray(u.cart)&&u.cart.length?u.cart:null; delete t.cartOff;
      t.seats=u.seats&&Array.isArray(u.seats.rows)?u.seats:null; if(typeof seatDrafts!=='undefined')delete seatDrafts[t.id]; // seat-map.js: its pick, fresh each answer
      t.showtimes=u.showtimes&&Array.isArray(u.showtimes.days)?u.showtimes:null; if(typeof showDay!=='undefined')delete showDay[t.id]; // seat-map.js: days and times to tap
      t.theaters=u.theaters&&Array.isArray(u.theaters.theaters)?u.theaters:null; if(typeof theaterPick!=='undefined')delete theaterPick[t.id]; // seat-map.js: the theaters on a map
      // just to look at (his grocery list): small cards. They stay up when an answer brings none ("add hummus"),
      // with what it added or removed on the list
      if(Array.isArray(u.cards)&&u.cards.length)t.cards=u.cards;
      else if(Array.isArray(t.cards)&&t.cards.length&&!t.cart&&u.list)t.cards=listCardsChanged(t.cards,u.list);
      // suggestions for the week start unselected: he taps the ones he wants
      if(t.cart){ const sg=t.cart.filter(function(it){ return it.suggested; }).map(function(it){ return it.name; }); if(sg.length)t.cartOff=sg; }
      if(u.list)applyListUpdate(t,u.list); // grocery-list.js: what it bought, added or removed
      (Array.isArray(u.asks)?u.asks:[]).forEach(function(q){ agentSay(t,'sys','The local model asked Claude: '+q); });
      const extra=Array.isArray(u.options)&&u.options.length?{options:u.options.map(function(o){ return o.label; })}:{};
      if(u.lane==='local')extra.lane='local';
      if(['gemini','openai','openrouter','xai','groq','cloudflare','nvidia'].indexOf(u.via)!==-1)extra.via=u.via; // agent-chat.js PINNED_CLOUDS
      if(u.lane!=='local'&&typeof u.model==='string'&&u.model)extra.model=u.model.slice(0,80); // which model wrote it (lists.js shows it by the name)
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
      if(Array.isArray(u.pref))u.pref.forEach(function(l){ if(l)prefLines.push(l); }); // a setup saves several at once
      else if(u.pref)prefLines.push(u.pref);
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
// watchdog: a run is killed after 15 min (40 for groceries), so "working" 2 min past that means it was cut off — queue it again
if(window.desktop&&window.desktop.onAgentResults){
  setInterval(function(){
    let changed=false; const cutoff=Date.now()-17*60*1000;
    state.tasks.forEach(function(t){
      const cut=t.lane==='local'?Date.now()-45*60*1000:cutoff; // the mini PC is slow: give it longer
      if(runLimit[t.id]&&Date.now()<runLimit[t.id]+2*60*1000)return; // its run still has time (the runner said how long)
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
