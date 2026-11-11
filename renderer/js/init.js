/* Start-up: load the tasks, first render, start syncing. Loads last.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── init ── */
// a working task this computer may put back in the queue at start-up: unclaimed, claimed here, or left for 3 hours
function claimIsMine(t,host){
  if(!t.claimedBy||!host)return true;
  if(String(t.claimedBy).split('@').slice(1).join('@')===host)return true;
  return !!t.claimedAt&&Date.now()-t.claimedAt>3*60*60*1000;
}
$('stamp').textContent=new Date().toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});
$('stamp').addEventListener('click',function(){ switchTab('calendar'); });
store.load().then(async function(data){
  // desktop: the sync settings come from config.json (sync.js started reading them; nothing is kept in localStorage)
  if(syncState.ready){ try{ await syncState.ready; }catch(e){} }
  // a new install syncs through the Romulus server from the start, encrypted (hosted-sync.js)
  if(typeof hostedAutoStart==='function'){ try{ await hostedAutoStart(); }catch(e){} }
  // this computer's name: a run another computer claimed ('relay@lupa-…') isn't this one's to put back in the queue
  let host=null; if(window.desktop&&window.desktop.hostName){ try{ host=await window.desktop.hostName(); }catch(e){} }
  if(data&&Array.isArray(data.tasks)){
    state.tasks=data.tasks.map(function(t){
      const out={
        id:t.id||uid(), title:String(t.title||''), done:!!t.done, due:t.due||null, dueTime:t.dueTime||null, tag:t.tag||null, ws:taskWs(t), pin:t.pin!=null?t.pin:null, googleEventId:t.googleEventId||null,
        // which calendar the event lives on, and a to-do pulled from a calendar (main/gcal-sync.js): dropping these
        // made every restart create the events again and push pulled to-dos back onto the calendar
        calRef:t.calRef||null, fromCal:t.fromCal||null,
        created:t.created||Date.now(),
        doneAt:t.done&&t.doneAt?t.doneAt:undefined, // when it was ticked (year-review.js)
        updatedAt:t.updatedAt||t.created||Date.now(),
        // backward-compatible: existing subs without a 'due' field get null
        subs:Array.isArray(t.subs)?t.subs.map(function(s){
          return {id:s.id||uid(),title:String(s.title||''),done:!!s.done,due:s.due||null};
        }):[]
      };
      if(t.recur&&t.recur.every&&out.ws!=='agent'){ out.recur=t.recur; if(t.recurNext)out.recurNext=t.recurNext; } // repeating to-do (recur.js)
      if(Array.isArray(t.images)&&t.images.length)out.images=t.images.slice(0,12); // context screenshots on a task
      if(out.ws==='school'){ out.kind=schoolKind(t); out.notes=t.notes||null; if(t.site)out.site=String(t.site); } // the school site it came from (agent/course-sites.js)
      if(out.ws==='agent'){ if(t.fromWs)out.fromWs=t.fromWs; if(t.kind)out.kind=t.kind; if(t.notes)out.notes=t.notes; if(Array.isArray(t.list)&&t.list.length)out.list=normList(t.list); }
      if(out.ws==='agent'){ out.status=t.status||'queued'; out.note=t.note||null; out.reply=t.reply||null; out.replyImages=Array.isArray(t.replyImages)?t.replyImages:null; out.waitUntil=t.waitUntil||null; if(t.runFrom&&(out.status==='working'||out.status==='queued'))out.runFrom=t.runFrom; out.useInbox=t.useInbox?true:null; out.options=Array.isArray(t.options)?t.options:null; if(t.routeAsk&&!t.lane)out.routeAsk=true; if(t.parked&&out.status==='needs-you')out.parked=true;
        if(out.status==='needs-you'&&t.stuck&&typeof t.stuck==='object'){ out.stuck={reason:String(t.stuck.reason||''),fix:String(t.stuck.fix||'')}; if(t.stuck.verify)out.stuck.verify=true; }
        if(out.status==='needs-you'&&t.shot)out.shot=t.shot;
        if(out.status==='suggested'&&(t.suggest==='look-ahead'||t.suggest==='email'||t.suggest==='bill'||t.suggest==='charge'))out.suggest=t.suggest; // a card on the Human tab (lists.js drawSuggestions)
        // what a waiting answer brought: its order cards (and his picks on them), tap questions, and ◉ Watch's page
        if(out.status==='needs-you'){
          if(Array.isArray(t.cart)&&t.cart.length){ out.cart=t.cart; if(Array.isArray(t.cartOff))out.cartOff=t.cartOff; if(t.cartPick&&typeof t.cartPick==='object')out.cartPick=t.cartPick; }
          if(Array.isArray(t.ask)&&t.ask.length)out.ask=t.ask;
          if(t.seats&&Array.isArray(t.seats.rows))out.seats=t.seats;
          if(t.showtimes&&Array.isArray(t.showtimes.days))out.showtimes=t.showtimes;
          if(t.theaters&&Array.isArray(t.theaters.theaters))out.theaters=t.theaters;
          if(t.page)out.page=t.page;
        }
        if(Array.isArray(t.cards)&&t.cards.length)out.cards=t.cards; // small cards to look at (his grocery list)
        if(t.lastOrder&&Array.isArray(t.lastOrder.items))out.lastOrder=t.lastOrder; // what he got, for "what's on my list?"
        out.history=Array.isArray(t.history)?t.history:(t.note?[{who:'claude',text:t.note,at:t.updatedAt||Date.now()}]:[]);
        out.repeat=t.repeat&&t.repeat.every?t.repeat:null; out.nextRun=t.nextRun||null; out.repeatDue=!!t.repeatDue;
        if(t.trigger&&t.trigger.kind)out.trigger=t.trigger; if(t.triggered&&t.triggered.what)out.triggered=t.triggered; // starts when… (triggers.js)
        if(Array.isArray(t.goalPlan)&&t.goalPlan.length)out.goalPlan=t.goalPlan; if(t.goalStarted)out.goalStarted=true; if(t.goalDone)out.goalDone=true; // goals.js
        if(t.goalId){ out.goalId=t.goalId; out.goalStep=t.goalStep||null; if(t.goalWait)out.goalWait=true; }
        // lane = which worker gets it ('claude' here, 'local' = the mini PC); a worker claims a task before starting
        if(t.lane==='claude'||t.lane==='local')out.lane=t.lane; if((PINNED_CLOUDS.indexOf(t.cloud)!==-1||t.cloud==='claude')&&out.lane==='claude')out.cloud=t.cloud; if(t.claimedBy){ out.claimedBy=t.claimedBy; out.claimedAt=t.claimedAt||null; }
        // this computer runs the Claude lane: its own run cut off by a restart goes back in the queue
        // (the desktop also coordinates the mini PC lane, so its interrupted runs go back too)
        // only its own runs, or one nobody has touched for 3 hours: a computer opening at 19:53 put the mini PC's six running tasks back to queued
        if(window.desktop&&out.status==='working'&&(out.lane!=='local'||window.desktop.localStatus)&&claimIsMine(out,host))out.status='queued'; }
      return out;
    });
    state.tombstones=Array.isArray(data.tombstones)?data.tombstones:[];
  }
  state.ideas=normIdeas(data&&data.ideas);
  state.hours=normHours(data&&data.hours);
  state.health=normHealth(data&&data.health); // daily health totals (health.js)
  rebuildSnap();
  if(spawnMissedRecurs())persist();
  if(sweepSchool())persist(); // assignments two days past their deadline come off (school-overdue.js)
  if(state.activeTab==='list')render(); else switchTab(state.activeTab); // To do, unless it's switched off in Settings > Tabs (tab-picker.js)
  reviewBannerCheck(); // January and February: last year's review (year-review-view.js)
  holoBackToSchool(); // undo the School → Holo auto-move
  startSyncLoop();
  setTimeout(runDueRepeats,10*1000);
}).catch(function(e){
  // the tasks file is there but couldn't be read: show the page, but never save over the file (core.js persist)
  state.loadFailed=String((e&&e.message)||e||'unknown error');
  render();
  voiceToast('Couldn’t read your tasks: '+state.loadFailed+'. Nothing is saved until Romulus is restarted.',true);
});
