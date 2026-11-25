/* The Home tab: message Romulus the way you'd text a person.
   - What you send becomes a task: yours (To do) or the Agent's, decided by homeWho() from the words. A link on
     the card moves it to the other side when the guess was wrong.
   - The thread is what you sent from this device (kept in localStorage, not synced); each message shows its
     task as a card with its date or the Agent's status and answer.
   - It is a conversation: the Agent's answer is written out under the card, and what you send next (within
     half an hour, until "New topic") is your reply on that same task, so it knows what was said (homeFollows).
   - On a phone the chat fills the screen with the box at the bottom; a swipe left shows the lists and tabs, a
     swipe right comes back (homePane). What he tells the Agent anywhere else, a reply typed into a notification
     included, joins the thread from the task's history (homeAdopt).
   - The microphone talks it through: it listens, sends, reads the answer aloud and listens again (homeTalk).
   - Beside it (under it on a narrow window): everything open, grouped by who it is waiting on.
   Adding goes through addTask() (task-actions.js), so dates, repeats, tags and groceries work as they do in the add box.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── who does it: 'agent' or 'me' (test/home.test.js) ── */
const HOME_LEAD=/^(?:(?:hey\s+)?romulus[,:]?\s+)?(?:(?:please|can you|could you|will you|would you|i need you to|i want you to|help me)\s+)*/i;
const HOME_AGENT_START=new RegExp('^(?:'+[
  'find','look up','look for','look into','search','research','compare','summari[sz]e','draft','translate','order','reorder',
  'get me','show me','tell me','recommend','suggest','figure out','price out',
  'explain','describe','define','brainstorm','give me','teach me','walk me through',
  'write (?:me|up|a draft|an? (?:email|reply|message|letter|text|note|summary|list))',
  'check (?:if|whether|when|what|how|the price|prices|the weather|my email)',
  'track (?:my |the |a )?(?:package|order|flight|price|delivery)',
  'plan (?:a|an|my|our) (?:trip|vacation|route|itinerary|menu)'
].join('|')+')\\b','i');
const HOME_ASKS=/^(?:what|what's|whats|when|when's|where|where's|who|who's|which|how|why)\b/i;
function homeWho(text){
  const s=String(text||'').trim().replace(HOME_LEAD,'');
  if(!s)return 'me';
  // "remind me to…", "I need to…": his own to do, whatever the verb after it
  if(/^(?:remind me|i need to|i have to|i should|i must|i gotta|don'?t forget|remember to)\b/i.test(s))return 'me';
  if(HOME_AGENT_START.test(s))return 'agent';
  if(/^(?:book|reserve)\b.*\b(?:flights?|hotel|table|tickets?|rental|room|airbnb|train|bus|restaurant)\b/i.test(s))return 'agent';
  if(/^buy\b.*\b(?:online|(?:on|from|at) (?:amazon|walmart|target|best buy|ebay))\b/i.test(s))return 'agent';
  if(HOME_ASKS.test(s))return 'agent'; // a question is something to find out
  if(/\?\s*$/.test(s)&&/^(?:is|are|does|do|did|can|could|should|will)\b/i.test(s))return 'agent';
  if(/\b(?:cheapest|best price|lowest price|price of|prices for|reviews? (?:of|for)|near me)\b/i.test(s))return 'agent';
  return 'me';
}
// the Agent's answer as one plain line for a card: no markdown marks, cut at a word
function homePlain(s,n){
  s=String(s||'').replace(/```[\s\S]*?```/g,' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/[*_`#>|]+/g,'').replace(/\s+/g,' ').trim();
  n=n||260;
  return s.length>n?s.slice(0,n-1).replace(/\s+\S*$/,'')+'…':s;
}
/* ── a conversation: what you send next goes on with the Agent task you were just talking about ── */
const HOME_CHAT_MS=30*60*1000; // how long after the last word a conversation stays open
// a to-do of his own, said in so many words: never part of the conversation
function homeOwn(text){ return /^(?:remind me|i need to|i have to|i should|i must|i gotta|don'?t forget|remember to|add (?:a )?(?:task|to-?do|reminder))\b/i.test(String(text||'').trim().replace(HOME_LEAD,'')); }
// when the conversation with this task last moved: his message, or the Agent's last word
function homeLastAt(entry,t){
  const h=t&&Array.isArray(t.history)?t.history:[];
  return h.reduce(function(m,x){ return x&&x.who!=='sys'&&x.at>m?x.at:m; },(entry&&entry.at)||0);
}
// is this message the next thing said in the conversation the thread ends on? entry: the thread's last
// message, t: its task (an Agent task that is not ticked off or set aside)
function homeFollows(said,entry,t,now){
  if(!entry||!t||entry.closed||t.ws!=='agent'||t.done||t.parked)return false;
  if((now||Date.now())-homeLastAt(entry,t)>HOME_CHAT_MS)return false;
  return !!String(said||'').trim()&&!homeOwn(said);
}
// the Agent's answer to one message: its first word after it. A first message that found a task he already
// had, or one answered before this device kept the conversation, shows that task's latest note instead.
function homeAnswer(t,entry){
  if(!t||t.ws!=='agent'||!entry)return null;
  const h=Array.isArray(t.history)?t.history:[];
  const a=h.find(function(x){ return x&&x.who==='claude'&&x.text&&x.at>=entry.at; });
  if(a)return {text:a.text,at:a.at};
  if(!entry.reply&&t.note&&(t.done||t.status==='needs-you'||t.status==='done'))return {text:t.note,at:entry.at};
  return null;
}
// What he said to the Agent somewhere else (a reply typed into a notification, the task's own reply box,
// another device) since `since`, as thread messages: → the thread with them in, or null when there are none.
// A task the thread has not seen yet comes in with its card first (from:'task': no bubble of his own for it).
function homeAdopt(thread,tasks,since){
  const add=[], full=thread.length>=40?thread[0].at:0; // older than a full thread's first message: it was trimmed off, leave it off
  (tasks||[]).forEach(function(t){
    if(!t||t.ws!=='agent'||!Array.isArray(t.history))return;
    const mine=thread.filter(function(e){ return e.id===t.id; });
    t.history.forEach(function(h){
      if(!h||h.who!=='you'||!h.text||!(h.at>since)||h.at<=full)return;
      const same=function(e){ return e.id===t.id&&e.said===h.text&&Math.abs(e.at-h.at)<15000; }; // sent from Home: already there
      if(mine.some(same)||add.some(same))return;
      if(!mine.length&&!add.some(function(e){ return e.id===t.id; }))add.push({said:t.title,at:h.at-1,id:t.id,from:'task'});
      add.push({said:h.text,at:h.at,id:t.id,reply:true});
    });
  });
  return add.length?thread.concat(add).sort(function(a,b){ return a.at-b.at; }):null;
}
// a sideways swipe on the phone: 'dash' (to the lists), 'chat' (back), or null for a tap or a scroll
function homeSwipeTo(dx,dy,pane){
  if(Math.abs(dx)<60||Math.abs(dy)>Math.abs(dx)*0.6)return null;
  return dx<0&&pane==='chat'?'dash':dx>0&&pane==='dash'?'chat':null;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { homeWho, homePlain, homeOwn, homeFollows, homeAnswer, homeLastAt, homeAdopt, homeSwipeTo, HOME_CHAT_MS };

/* ── the thread: what was sent from here ── */
const HOME_THREAD_KEY='home.thread.v1';
const HOME_SHOW=6; // messages showing until "Earlier" is pressed
let homeShowAll=false, homeBusy=false;
function homeThreadLoad(){ try{ const l=JSON.parse(localStorage.getItem(HOME_THREAD_KEY)||'[]'); return Array.isArray(l)?l:[]; }catch(e){ return []; } }
function homeThreadSave(list){ try{ localStorage.setItem(HOME_THREAD_KEY,JSON.stringify(list.slice(-40))); }catch(e){} }
const HOME_TRY=[['Call the dentist tomorrow at 9','me'],['Pay rent every month on the 1st','me'],['Find 3 easy dinner recipes for tonight','agent'],['Compare prices for AirPods Pro','agent'],['Draft a polite email asking my landlord to fix the heater','agent']];

function homeAiMissing(){ return !!(window.desktop&&window.desktop.aiStatus)&&window.agentAiReady!==undefined&&!anyAiReady(); }
function homeWelcomed(){ if(typeof markWelcomed==='function')markWelcomed(); }

async function homeSend(){
  const inp=$('homeInput'); const said=inp.value.trim();
  if(!said||homeBusy)return;
  // the conversation goes on: this is his next word on the Agent task the thread ends with
  const thread=homeThreadLoad(), lastE=thread[thread.length-1], lastT=lastE&&lastE.id?state.tasks.find(function(t){ return t.id===lastE.id; }):null;
  if(agentAvailable()&&homeFollows(said,lastE,lastT,Date.now())){
    const lt=liveTask(lastT), busy=lt.status==='working'||lt.status==='queued';
    const entry={said:said,at:Date.now(),id:lt.id,reply:true};
    lt.reply=(busy&&lt.reply)?lt.reply+'\n'+said:said; // mid-run additions stack onto what he already sent
    agentSay(lt,'you',said); buzz('send'); if(lt.status!=='working')lt.status='queued';
    thread.push(entry); homeThreadSave(thread);
    inp.value=''; touch(); renderHome(); homeToEnd(); inp.focus();
    return entry;
  }
  homeBusy=true;
  const who=agentAvailable()?homeWho(said):'me';
  const before={}; state.tasks.forEach(function(t){ before[t.id]=1; });
  $('newTitle').value=who==='me'?said.replace(/^\s*remind me (?:to|that|about)\s+/i,''):said;
  $('newDue').value=''; $('newTime').value=''; $('newTag').value='';
  addWsOverride=who==='agent'?'agent':'personal';
  let res; try{ res=await addTask(); }catch(e){ res='error'; } finally{ addWsOverride=null; homeBusy=false; }
  const entry={said:said,at:Date.now()};
  if(res==='same'&&sameAskHeld){ entry.id=sameAskHeld.id; entry.same=true; hideSameAsk(); $('newTitle').value=''; } // he has this one already: show that task
  else{
    const made=state.tasks.find(function(t){ return !before[t.id]; });
    if(made)entry.id=made.id;
    else{ const vt=$('voiceToast'); entry.text=res==='error'?'That didn’t go through. Try it again.':(vt&&!vt.hidden&&vt.textContent)||'Done.'; } // groceries, a task sent to someone in the group
  }
  // tasks that are gone leave the thread here, once the list is known to be loaded
  const list=homeThreadLoad().filter(function(e){ return !e.id||state.tasks.some(function(t){ return t.id===e.id; }); });
  list.push(entry); homeThreadSave(list);
  inp.value=''; homeWelcomed(); renderHome();
  inp.focus(); homeToEnd();
  return entry;
}
function homeToEnd(){
  if(homePhone()&&homePaneNow()==='chat'){ window.scrollTo(0,document.documentElement.scrollHeight); return; } // the newest message sits just over the box
  const last=$('homeThread').lastElementChild; if(last&&last.scrollIntoView)last.scrollIntoView({block:'nearest'});
}
/* ── on a phone: the chat fills the screen; a swipe left shows the lists and tabs, a swipe right comes back ── */
function homePhone(){ return typeof matchMedia==='function'&&matchMedia('(max-width:520px)').matches; }
function homePaneNow(){ return document.body.classList.contains('home-dash')?'dash':'chat'; }
function homePane(to){
  if(homePaneNow()===to)return;
  document.body.classList.toggle('home-dash',to==='dash');
  renderHome(); if(to==='chat')homeToEnd(); else window.scrollTo(0,0);
}
// replies typed into a notification or a task's own box join the thread; nothing from before this was first run
function homeSince(){
  let s=0; try{ s=+localStorage.getItem('home.since.v1')||0; if(!s){ s=Date.now(); localStorage.setItem('home.since.v1',String(s)); } }catch(e){}
  return s||Date.now();
}
// "New topic": the next message starts something new instead of going on with the last task
function homeNewTopic(){
  const list=homeThreadLoad(); if(!list.length)return;
  list[list.length-1].closed=true; homeThreadSave(list); renderHome(); $('homeInput').focus();
}

/* ── talking: say it, hear the answer, say the next thing. The same conversation as typing. ── */
const homeTalk={on:false,waitFor:0,partial:null};
function homeTalkBtn(){
  const b=$('homeMicBtn'); if(!b)return;
  b.classList.toggle('on',homeTalk.on); b.innerHTML=homeTalk.on?I.stop:I.mic;
  b.title=homeTalk.on?'Stop talking':'Talk to Romulus'; b.setAttribute('aria-label',b.title);
}
function homeTalkEnd(msg){
  homeTalk.on=false; homeTalk.waitFor=0;
  try{ if(window.speechSynthesis)window.speechSynthesis.cancel(); }catch(e){}
  $('homeInput').placeholder='Message Romulus'; homeTalkBtn(); renderHome();
  if(msg)voiceToast(msg,true);
}
function homeSpeak(text,then){
  const say=homePlain(text,700);
  if(!say||!window.speechSynthesis||typeof SpeechSynthesisUtterance==='undefined'){ then(); return; }
  let went=false; const done=function(){ if(went)return; went=true; then(); };
  try{
    const u=new SpeechSynthesisUtterance(say); u.onend=done; u.onerror=done;
    window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    setTimeout(done,90000); // a voice that never reports the end must not leave it stuck
  }catch(e){ done(); }
}
async function homeListen(){
  const v=voiceEngine(); if(!v||!homeTalk.on)return;
  if(voiceOn){ homeTalkEnd(); return; } // the Speak button is already listening
  const inp=$('homeInput'); let heard='', partial=null;
  voiceOn=true; inp.value=''; inp.placeholder='Listening…';
  try{ partial=v.onPartial(function(text){ heard=text; inp.value=text; }); }catch(e){}
  let r=null, err='';
  try{ r=await v.listen(); if(r&&r.error)err=r.error; }catch(e){ err=(e&&e.message)||'Voice didn’t work'; }
  voiceOn=false; try{ if(partial&&partial.remove)partial.remove(); }catch(e){}
  if(!homeTalk.on){ inp.value=''; return; } // stopped while listening
  if(err){ inp.value=''; homeTalkEnd(err); return; }
  const said=((r&&r.text)||heard||'').trim();
  if(!said){ inp.value=''; homeTalkEnd(); return; } // nothing said: the talk is over
  inp.value=said; inp.placeholder='Message Romulus';
  const entry=await homeSend();
  if(!homeTalk.on)return;
  const t=entry&&entry.id?state.tasks.find(function(x){ return x.id===entry.id; }):null;
  if(t&&taskWs(t)==='agent'&&!homeAnswer(t,entry)){ homeTalk.waitFor=entry.at; inp.placeholder='Romulus is thinking…'; return; } // homeDrawThread speaks the answer when it lands
  homeSpeak(t?(homeAnswer(t,entry)||{}).text||'It’s on your list.':(entry&&entry.text)||'Done.',homeListen);
}
function homeTalkToggle(){
  if(homeTalk.on){ const v=voiceEngine(); homeTalkEnd(); if(v&&voiceOn){ try{ v.stop(); }catch(e){} } return; }
  if(!voiceEngine())return;
  homeTalk.on=true; homeTalkBtn(); buzz('tap'); homeListen();
}
// the guess was wrong: the task goes to the other side under a new id, and the thread follows it
function homeFlip(t,toWs){
  const nid=uid();
  homeThreadSave(homeThreadLoad().map(function(e){ if(e.id===t.id){ e.id=nid; delete e.same; } return e; }));
  moveTask(t,toWs,nid);
}
function homeCheck(t){
  const b=el('button','home-check'+(t.done?' on':'')); b.type='button'; b.innerHTML=t.done?I.check:'';
  b.setAttribute('aria-label',t.done?'Mark as not done':'Mark as done'); b.title=t.done?'Not done after all':'Done';
  b.addEventListener('click',function(e){ e.stopPropagation(); const live=liveTask(t); if(!live.done)buzz('check'); setDone(live,!live.done); touch(); });
  return b;
}
// {chip:[class,text], sub, need, acts:[[label,fn,accent]]} for a task on a card or a row
function homeStatus(t){
  const out={chip:null,sub:'',need:false,acts:[]};
  const open=function(){ openTaskById(t.id); };
  if(taskWs(t)!=='agent'){
    if(t.due){ const d=dateInfo(t.due,t.dueTime); out.chip=[d.cls==='late'?'late':'',d.text]; }
    out.sub=t.done?'Done.':'On your list.'+(t.recur?' It comes back each time you tick it off.':'');
    return out;
  }
  if(t.done){ out.chip=['','done']; out.sub=homePlain(t.note); if(t.note)out.acts.push(['See it',open]); return out; }
  if(t.status==='needs-you'&&!t.parked){ out.chip=['needs','needs you']; out.need=true; out.sub=homePlain(t.note)||'The Agent needs something from you.'; out.acts.push(['Answer',open,true]); }
  else if(t.status==='needs-you'){ out.chip=['','set aside']; out.sub=homePlain(t.note); out.acts.push(['See it',open]); }
  else if(t.status==='working'){ out.chip=['working','working']; out.sub='The Agent is working on it now.'; out.acts.push(['Watch',open]); }
  else if(t.status==='done'){ out.chip=['ready','finished']; out.sub=homePlain(t.note)||'Finished.'; out.acts.push(['See it',open]); }
  else if(homeAiMissing()){ out.chip=['','waiting']; out.sub='I can do this one once an AI is connected.'; out.acts.push(['Connect an AI',function(){ openSettingsAt('agentGroup','aiSection'); },true]); }
  else{ out.chip=['','waiting']; out.sub='With the Agent. It asks before anything final.'; }
  return out;
}
// Romulus's side of the thread: a plain line, or an answer drawn as the text it is (lists, links, bold)
function homeFrom(text,rich){
  const f=el('div','home-from'+(rich?' home-answer':'')); f.appendChild(el('span','mono','Romulus'));
  if(rich){ const b=el('div','home-answer-text'); b.appendChild(richText(text)); f.appendChild(b); }
  else f.appendChild(document.createTextNode(text));
  return f;
}
function homeCard(t,entry,answered){
  const st=homeStatus(t), isAgent=taskWs(t)==='agent';
  if(answered)st.sub=''; // the answer is written out in full under the card
  const card=el('div','home-card'+(st.need?' need':'')+(t.done?' done':''));
  const top=el('div','home-card-top');
  top.appendChild(homeCheck(t));
  const title=el('span','home-title',t.title.replace(/(^|\s)#(legion|research)\b/ig,' ').trim()); title.title='Open this task';
  title.addEventListener('click',function(){ openTaskById(t.id); });
  top.appendChild(title);
  if(isAgent)top.appendChild(el('span','chip st home-who','Agent'));
  if(st.chip)top.appendChild(el('span','chip st'+(st.chip[0]?' '+st.chip[0]:''),st.chip[1]));
  card.appendChild(top);
  const sub=(entry&&entry.same&&!t.done?'You already had this one. ':'')+st.sub;
  if(sub)card.appendChild(el('div','home-sub',sub));
  const acts=el('div','home-acts');
  st.acts.forEach(function(a){ const b=el('button',a[2]?'btn-accent':'ghost home-ghost',a[0]); b.type='button'; b.addEventListener('click',a[1]); acts.appendChild(b); });
  // wrong side? one tap moves it
  if(!t.done&&agentAvailable()&&(!isAgent||t.status==='queued')){
    const fl=el('button','home-link',isAgent?'I’ll do it myself':'Give it to the Agent'); fl.type='button';
    fl.addEventListener('click',function(){ homeFlip(liveTask(t),isAgent?'personal':'agent'); });
    acts.appendChild(fl);
  }
  if(acts.childNodes.length)card.appendChild(acts);
  return card;
}
function homeSetupLinks(){
  const row=el('div','home-setup');
  const add=function(label,fn){ const b=el('button','home-link',label); b.type='button'; b.addEventListener('click',function(){ homeWelcomed(); fn(); }); row.appendChild(b); };
  const desktop=!!(window.desktop&&window.desktop.aiStatus);
  if(homeAiMissing())add('Connect an AI',function(){ switchTab('agent'); window.scrollTo(0,0); });
  if(!syncEnabled())add(desktop?'Sync with my phone':'Sync with my computer',function(){ openSettingsAt(null,'syncSection'); });
  if((window.desktop&&window.desktop.calOverview)||window.phoneCal)add('Connect my calendar and email',function(){ if(window.openConnect)window.openConnect(); else openSettingsAt('calGroup','gcalSection'); });
  if(!state.tasks.length&&$('welcomeImportBtn'))add('Bring tasks from another app',function(){ switchTab('list'); $('welcomeImportBtn').click(); });
  return row.childNodes.length?row:null;
}
function homeDrawThread(){
  const box=$('homeThread'); box.textContent='';
  const all=homeThreadLoad().map(function(e){ return {e:e,t:e.id?state.tasks.find(function(t){ return t.id===e.id; }):null}; })
    .filter(function(x){ return x.t||(!x.e.id&&x.e.text); });
  const shown=homeShowAll?all:all.slice(-HOME_SHOW);
  if(!all.length){
    const intro=el('div','home-from'); intro.appendChild(el('span','mono','Romulus'));
    intro.appendChild(document.createTextNode(agentAvailable()
      ?'Tell me what you need to do, the way you’d text a person. I’ll keep it on your list, or do it myself and ask before anything final.'
      :'Tell me what you need to do, the way you’d text a person. I’ll keep it on your list and work out the date.'));
    box.appendChild(intro);
    const links=homeSetupLinks(); if(links)box.appendChild(links);
  }
  if(shown.length<all.length){
    const more=el('button','home-link home-earlier','Earlier ('+(all.length-shown.length)+')'); more.type='button';
    more.addEventListener('click',function(){ homeShowAll=true; renderHome(); }); box.appendChild(more);
  }
  let spoken=null;
  shown.forEach(function(x,i){
    if(x.e.from!=='task')box.appendChild(el('div','home-me',x.e.said));
    if(!x.t){ box.appendChild(homeFrom(x.e.text)); return; }
    // two messages sent before one answer share it: it is written under the later one
    const nx=shown[i+1], ans=homeAnswer(x.t,x.e), mine=ans&&!(nx&&nx.t===x.t&&nx.e.at<=ans.at);
    if(!x.e.reply)box.appendChild(homeCard(x.t,x.e,!!mine));
    if(mine){ box.appendChild(homeFrom(ans.text,true)); if(homeTalk.waitFor===x.e.at)spoken=ans.text; }
    else if(x.e.reply&&!ans&&!x.t.done&&(x.t.status==='queued'||x.t.status==='working'))box.appendChild(el('div','home-thinking',homeAiMissing()?'Waiting for an AI to be connected.':'Thinking…'));
  });
  // the conversation is open: the box says so, and "New topic" ends it
  const lastX=all[all.length-1], open=!!(lastX&&lastX.t&&agentAvailable()&&homeFollows('x',lastX.e,lastX.t,Date.now()));
  if(!homeTalk.on)$('homeInput').placeholder=open?'Reply to Romulus':'Message Romulus';
  if($('homeNewTopic'))$('homeNewTopic').hidden=!open;
  if(spoken&&homeTalk.on){ homeTalk.waitFor=0; $('homeInput').placeholder='Message Romulus'; homeSpeak(spoken,homeListen); }
  // things to try, until a few have been sent
  const tryBox=$('homeTry'); tryBox.textContent=''; tryBox.hidden=all.length>=3;
  if(!tryBox.hidden)HOME_TRY.forEach(function(p){
    if(p[1]==='agent'&&!agentAvailable())return;
    const b=el('button','home-try-chip'+(p[1]==='agent'?' agent':''),p[0]); b.type='button'; b.title=p[1]==='agent'?'One for the Agent':'One for your list';
    b.addEventListener('click',function(){ const i=$('homeInput'); i.value=p[0]; i.focus(); i.setSelectionRange(p[0].length,p[0].length); });
    tryBox.appendChild(b);
  });
}
/* ── everything open, by who it waits on ── */
function homeRailGroup(box,label,tasks,max,accent,moreTab){
  if(!tasks.length)return;
  const head=el('div','home-rh'); head.appendChild(el('span','mono'+(accent?' home-accent':''),label)); head.appendChild(el('span','mono',String(tasks.length))); box.appendChild(head);
  tasks.slice(0,max).forEach(function(t){
    const st=homeStatus(t);
    const r=el('div','home-r'+(t.done?' done':''));
    r.appendChild(homeCheck(t));
    const n=el('span','home-r-title',t.title.replace(/(^|\s)#(legion|research)\b/ig,' ').trim()); r.appendChild(n);
    if(st.chip&&!t.done&&!st.need)r.appendChild(el('span','chip st'+(st.chip[0]?' '+st.chip[0]:''),st.chip[1]));
    r.title=st.need&&st.sub?st.sub:'Open this task';
    r.addEventListener('click',function(){ openTaskById(t.id); });
    box.appendChild(r);
  });
  if(tasks.length>max){
    const more=el('button','home-link home-more',(tasks.length-max)+' more'); more.type='button';
    more.addEventListener('click',function(){ if(moreTab==='done')state.showDone=true; switchTab(moreTab==='agent'?'agent':'list'); }); box.appendChild(more);
  }
}
function homeDrawRail(){
  const box=$('homeRail'); box.textContent='';
  const byKey=function(a,b){ return getSortKey(a)-getSortKey(b); };
  const agent=state.tasks.filter(function(t){ return inTab(t,'agent')&&!t.done; });
  const needs=agent.filter(function(t){ return t.status==='needs-you'&&!t.parked; }).sort(byKey);
  const mine=state.tasks.filter(function(t){ return taskWs(t)!=='agent'&&inTab(t,'list')&&!t.done; }).sort(byKey);
  const going=agent.filter(function(t){ return t.status==='queued'||t.status==='working'; }).sort(byKey);
  const day=todayStart().getTime();
  const done=state.tasks.filter(function(t){ return t.done&&t.doneAt&&t.doneAt>=day; }).sort(function(a,b){ return b.doneAt-a.doneAt; });
  homeRailGroup(box,'Needs you',needs,6,true,'agent');
  homeRailGroup(box,'Yours to do',mine,7,false,'list');
  homeRailGroup(box,'The Agent is on',going,5,false,'agent');
  homeRailGroup(box,'Done today',done,4,false,'done');
  if(!box.childNodes.length)box.appendChild(el('div','home-empty','Nothing open. What you send shows up here.'));
}
function renderHome(){
  const view=$('homeView'); if(!view||view.hidden)return;
  const grown=homeAdopt(homeThreadLoad(),state.tasks,homeSince()); if(grown)homeThreadSave(grown);
  homeDrawThread(); homeDrawRail();
  if(grown)homeToEnd();
}

if (typeof document !== 'undefined') {
$('tabHome').addEventListener('click',function(){ document.body.classList.remove('home-dash'); switchTab('home'); homeToEnd(); }); // on a phone, Home is the chat
$('homeDashBtn').addEventListener('click',function(){ homePane('dash'); });
$('homeChatBtn').addEventListener('click',function(){ homePane('chat'); });
homeSince();
(function(){ // the swipe between the chat and the lists (phone only, Home only)
  let sx=null, sy=0;
  document.addEventListener('touchstart',function(e){
    sx=null;
    if(e.touches.length!==1||state.activeTab!=='home'||!homePhone()||document.body.classList.contains('settings-open'))return;
    if(e.target.closest&&e.target.closest('.tabs,.home-try,input,textarea,pre,table'))return; // these scroll sideways or take text
    sx=e.touches[0].clientX; sy=e.touches[0].clientY;
  },{passive:true});
  document.addEventListener('touchend',function(e){
    if(sx===null)return;
    const c=e.changedTouches[0], to=homeSwipeTo(c.clientX-sx,c.clientY-sy,homePaneNow()); sx=null;
    if(to){ buzz('tap'); homePane(to); }
  },{passive:true});
})();
$('homeSendBtn').addEventListener('click',homeSend);
$('homeNewTopic').addEventListener('click',homeNewTopic);
$('homeMicBtn').addEventListener('click',homeTalkToggle);
if(voiceEngine()){ $('homeMicBtn').hidden=false; homeTalkBtn(); }
$('homeInput').addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.isComposing){ e.preventDefault(); homeSend(); } });
// Home is where the app opens, unless it is switched off in Settings > Tabs (tab-picker.js ran just before this).
// Only the shell is shown here; init.js draws it once the tasks are loaded.
if(!$('tabHome').classList.contains('tab-off')){
  state.activeTab='home';
  $('tabList').classList.remove('active'); $('tabList').setAttribute('aria-selected','false');
  $('tabHome').classList.add('active'); $('tabHome').setAttribute('aria-selected','true');
  $('listView').hidden=true; $('homeView').hidden=false; document.querySelector('.composer').hidden=true; document.body.classList.add('home-mode');
}
}
