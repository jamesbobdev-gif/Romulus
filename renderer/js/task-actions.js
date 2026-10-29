/* Task actions: add, edit, complete, move, delete, voice input.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── task actions ── */
let addingTask=false;
/* ⚔ Legion (Agent tab): the task goes out as deep research, every connected AI on a different angle (agent/legion.js) */
let legionOn=false;
function setLegion(on){
  legionOn=!!on; const b=$('legionBtn'); b.classList.toggle('on',legionOn); b.setAttribute('aria-pressed',String(legionOn));
  if(state.activeTab==='agent')$('newTitle').placeholder=legionOn?'What should the legion research?':'Add a task for the Agent…';
}
async function addTask(){
  if(addingTask)return;
  const titleEl=$('newTitle'); let title=titleEl.value.trim();
  const withPhotos=composerAtts.length>0&&!!attachProfile();
  if(!title&&withPhotos)title=state.activeTab==='agent'?(composerAtts.length===1?'Look at this photo':'Look at these photos'):'Screenshot';
  if(!title){ titleEl.focus(); return; }
  // typed "we're out of eggs": onto the grocery list, not a new task (grocery-list.js)
  if(!withPhotos&&outOfNames(title)&&groceryTask()){ const g=addToGroceries(title); if(g){ titleEl.value=''; voiceToast('On the next grocery order: '+g.names.join(', ')); return; } }
  let photoUrls=[];
  if(withPhotos){
    addingTask=true; $('addBtn').disabled=true; $('addBtn').textContent='Uploading\u2026';
    try{ for(const a of composerAtts)photoUrls.push(await uploadAttachment(a.blob)); }
    catch(err){ addingTask=false; $('addBtn').disabled=false; $('addBtn').textContent='Add'; alert('Couldn\u2019t upload the photos: '+err.message); return; }
    composerAtts.forEach(function(a){ URL.revokeObjectURL(a.preview); }); composerAtts.length=0; drawComposerAtts();
    addingTask=false; $('addBtn').disabled=false; $('addBtn').textContent='Add';
  }
  const due=$('newDue').value||null; const dueTime=due?($('newTime').value||null):null; const tag=$('newTag').value.trim()||null;
  // adding on the Agent tab files it for Claude; on the Work tab (or with the Work filter on), under work
  const ws=state.activeTab==='agent'?'agent':state.activeTab==='school'?'school':(state.activeTab==='work'||state.wsFilter==='work')?'work':'personal';
  const t={id:uid(),title:title,done:false,due:due,dueTime:dueTime,tag:tag,ws:ws,subs:[],googleEventId:null,created:Date.now()};
  if(ws==='agent'&&legionOn){ if(!/(^|\s)#(legion|research)\b/i.test(t.title))t.title='#legion '+t.title; setLegion(false); }
  if(ws==='agent'){ t.status='queued'; t.note=null; if(photoUrls.length){ t.replyImages=photoUrls; agentSay(t,'you',title,{images:photoUrls}); } }
  if(ws!=='agent'&&photoUrls.length)t.images=photoUrls;
  if(ws==='school')t.kind='regular';
  state.tasks.push(t);
  titleEl.value=''; buzz('add'); touch(); titleEl.focus();
}
/* "Call the dentist on Friday at 3pm" → {title:'Call the dentist', due:<Friday>, dueTime:'15:00'}.
   A day you mention becomes the due date (and is taken out of the title); no day → no date. */
function parseSpokenTask(text,now){
  now=now||new Date();
  let s=' '+String(text||'').trim().replace(/\s+/g,' ')+' ';
  let due=null, time=null;
  const base=new Date(now); base.setHours(0,0,0,0);
  const plus=function(n){ const d=new Date(base); d.setDate(d.getDate()+n); return d; };
  const NUM={a:1,an:1,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,fourteen:14,thirty:30};
  const DOW=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const MON=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const LEAD='(?:\\b(?:on|by|due|for|before|until|till|this|coming|next)\\s+)*';
  const cut=function(m){ s=s.slice(0,m.index)+' '+s.slice(m.index+m[0].length); };
  const tryDate=function(re,fn){ if(due)return; const m=re.exec(s); if(!m)return; const d=fn(m); if(d){ due=d; cut(m); } };
  // time: "at 3", "at 3:30 pm", "3pm", "at noon"
  (function(){
    let m=/\b(?:at|by|around)\s+(noon|midday|midnight)\b/i.exec(s);
    if(m){ time=/mid?night/i.test(m[1])?'00:00':'12:00'; cut(m); return; }
    m=/\b(?:(?:at|by|around)\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?=\W)/i.exec(s);
    if(!m)m=/\b(?:at|by|around)\s+(\d{1,2})(?::(\d{2}))?\b(?!\s*(?:days?|weeks?|st|nd|rd|th|\/))/i.exec(s);
    if(!m)return;
    let h=Number(m[1]); const min=Number(m[2]||0); if(h>23||min>59)return;
    const ap=m[3]?m[3].replace(/[^ap]/gi,'').toLowerCase():'';
    const evening=/\b(?:tonight|evening|night|after\s+work|after\s+dinner)\b/i.test(s);
    if(ap==='p'&&h<12)h+=12; else if(ap==='a'&&h===12)h=0; else if(!ap&&h<12&&(evening||h>=1&&h<=7))h+=12; // "at 3" / "tonight at 8" mean pm
    time=String(h).padStart(2,'0')+':'+String(min).padStart(2,'0'); cut(m);
  })();
  tryDate(new RegExp(LEAD+'\\bthe\\s+day\\s+after\\s+tomorrow\\b|'+LEAD+'\\bday\\s+after\\s+tomorrow\\b','i'),function(){ return plus(2); });
  tryDate(new RegExp(LEAD+'\\b(?:today|tonight|this\\s+(?:morning|afternoon|evening))\\b','i'),function(){ return plus(0); });
  tryDate(new RegExp(LEAD+'\\b(?:tomorrow|tmrw|tomorrow\\s+(?:morning|afternoon|evening|night))\\b','i'),function(){ return plus(1); });
  tryDate(/\bin\s+(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|thirty)\s+(days?|weeks?)\b/i,function(m){
    const n=/^\d+$/.test(m[1])?Number(m[1]):NUM[m[1].toLowerCase()]; return plus(n*(/^w/i.test(m[2])?7:1)); });
  tryDate(new RegExp(LEAD+'\\b(?:the\\s+)?end\\s+of\\s+(?:the\\s+|this\\s+)?week\\b','i'),function(){ const a=(5-base.getDay()+7)%7; return plus(a); });
  tryDate(new RegExp(LEAD+'\\b(?:this|the)\\s+weekend\\b','i'),function(){ const a=(6-base.getDay()+7)%7; return plus(a); });
  tryDate(/\b(?:by\s+|for\s+)?next\s+week\b/i,function(){ const a=(1-base.getDay()+7)%7||7; return plus(a); });
  tryDate(new RegExp(LEAD+'\\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\\b','i'),function(m){
    const a=(DOW.indexOf(m[1].toLowerCase())-base.getDay()+7)%7; return plus(a===0&&!/\bthis\s+$/i.test(m[0].slice(0,-m[1].length))?7:a); });
  const ymd=function(mi,day){ if(mi<0||day<1||day>31)return null; const d=new Date(base.getFullYear(),mi,day); if(d<base)d.setFullYear(d.getFullYear()+1); return d; };
  tryDate(new RegExp(LEAD+'\\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b','i'),function(m){ return ymd(MON.indexOf(m[1].slice(0,3).toLowerCase()),Number(m[2])); });
  tryDate(new RegExp(LEAD+'\\b(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+of\\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b','i'),function(m){ return ymd(MON.indexOf(m[2].slice(0,3).toLowerCase()),Number(m[1])); });
  tryDate(new RegExp(LEAD+'\\b(\\d{1,2})\\/(\\d{1,2})\\b','i'),function(m){ return ymd(Number(m[1])-1,Number(m[2])); });
  tryDate(new RegExp(LEAD+'\\bthe\\s+(\\d{1,2})(?:st|nd|rd|th)\\b','i'),function(m){
    const day=Number(m[1]); if(day<1||day>31)return null; const d=new Date(base.getFullYear(),base.getMonth(),day); if(d<base)d.setMonth(d.getMonth()+1); return d; });
  // a time with no day: today if it's still ahead, otherwise tomorrow
  if(time&&!due){ const p=time.split(':').map(Number); const at=new Date(base); at.setHours(p[0],p[1]); due=at>now?plus(0):plus(1); }
  // "Friday evening" → the day is the date; a leftover "evening" at the end shouldn't stay in the title
  if(due||time)s=s.replace(/(?:\s+(?:in\s+the\s+)?(?:morning|afternoon|evening|night))+\s*$/i,' ');
  let title=s.replace(/\s+/g,' ').trim()
    .replace(/^(?:(?:remind me to|i need to|i have to|i've got to|i gotta|need to|add|to do|todo)\s+)+/i,'')
    .replace(/(?:\s+(?:on|by|due|for|at|before|until|this|next|and|the))+$/i,'')
    .replace(/[\s,.;:!?-]+$/,'').trim();
  if(title)title=title.charAt(0).toUpperCase()+title.slice(1);
  return {title:title, due:due?formatDate(due):null, dueTime:due&&time?time:null};
}
/* Spoken commands ("Hey Romulus …"): where the words go, before parseSpokenTask reads dates out of them.
     "go to ideas" / "open the work tab"                → {kind:'tab'}
     "add monkey tinder to app ideas" / "new idea …"    → {kind:'idea', group}
     "add finish the report to work"                    → {kind:'task', tab:'work'}
     "send to agent find flights" / "tell Claude to …"  → {kind:'task', tab:'agent'}
   "go to work and add …" goes there first, then reads the rest. Anything else: a task on the tab you're on. */
const VOICE_TABS={human:'list',personal:'list',main:'list',home:'list',agent:'agent',claude:'agent',school:'school',work:'work',calendar:'calendar',ideas:'ideas',idea:'ideas'};
const VOICE_TAB_NAME={list:'Human',agent:'Agent',school:'School',work:'Work',calendar:'Calendar',ideas:'Ideas'};
function voiceTabOk(tab){ return tab==='agent'?agentAvailable():tab==='school'?schoolConfigured():tab==='work'?workConfigured():true; }
// "app" / "app ideas" / "the app ideas group" → that idea group's id ('' = Unsorted); undefined = no such group
function voiceIdeaGroup(dest){
  const bare=function(x){ return String(x||'').toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\b(?:the|my|group|ideas?)\b/g,' ').replace(/\s+/g,' ').trim(); };
  const d=bare(dest); if(!d)return undefined;
  const all=[{id:'',name:state.ideas.inbox.name||'Unsorted'}].concat(state.ideas.groups);
  const hit=all.find(function(g){ return bare(g.name)===d; });
  return hit?hit.id:undefined;
}
// where "… to X" points: a tab, an idea group, or nothing we know (then "to X" is part of the task)
function voiceDest(raw){
  const d=String(raw||'').toLowerCase().replace(/[\s,.;:!?]+$/,'').replace(/^(?:the|my)\s+/,'').replace(/\s+(?:tab|list|page|board|group)$/,'').trim();
  // the recognizer often writes "the agents tab" / "the agent's tab"
  const t=VOICE_TABS[d]?d:VOICE_TABS[d.replace(/(?:['’]s|s['’]?)$/,'')]?d.replace(/(?:['’]s|s['’]?)$/,''):null;
  if(t&&VOICE_TABS[t]!=='calendar')return VOICE_TABS[t]==='ideas'?{kind:'idea',group:''}:{kind:'task',tab:VOICE_TABS[t]};
  const g=voiceIdeaGroup(d);
  return g===undefined?null:{kind:'idea',group:g};
}
function parseVoiceCommand(said,curTab,smart){
  let s=String(said||'').trim().replace(/\s+/g,' ')
    .replace(/^(?:(?:hey|hi|ok|okay)\s+)?romulus\b[\s,.!:]*/i,'').replace(/^(?:please|can you|could you)\s+/i,'').replace(/[\s.!?]+$/,'');
  let tab=null, m;
  // "we're out of eggs" / "add eggs to groceries": onto his grocery list for the next order (grocery-list.js)
  if(outOfNames(s)&&groceryTask())return {kind:'grocery',text:s};
  // "go to the ideas tab (and …)" — the tab first, then whatever follows
  m=/^(?:go|switch|jump|move|take me|bring me|show me|open(?: up)?)\s+(?:(?:to|over to|back to)\s+)?(?:the\s+|my\s+)?(human|personal|main|home|agent|claude|school|work|calendar|ideas?)(?:\s+(?:tab|list|page|board))?\b[\s,]*(?:(?:and|then|and then)\b[\s,]*)?(.*)$/i.exec(s);
  if(m){ tab=VOICE_TABS[m[1].toLowerCase()]; s=m[2].trim(); if(!s)return {kind:'tab',tab:tab}; }
  // Claude / the agent
  m=/^(?:send|give|hand|pass)\s+(?:this\s+|it\s+)?(?:over\s+)?(?:to\s+)?(?:the\s+)?(?:agent|claude)\s*[,:]?\s*(?:to\s+)?(.+)$/i.exec(s)
    ||/^(?:tell|ask|have|get)\s+(?:the\s+)?(?:agent|claude)\s*[,:]?\s*(?:to\s+)?(.+)$/i.exec(s);
  if(m)return {kind:'task',tab:'agent',text:m[1]};
  m=/^(?:send|give|hand|pass)\s+(.+?)\s+(?:over\s+)?to\s+(?:the\s+)?(?:agent|claude)$/i.exec(s);
  if(m)return {kind:'task',tab:'agent',text:m[1]};
  // "new idea …" / "add an idea …" / "… as an idea"
  m=/^(?:(?:add|new|save|write|note)\s+(?:a\s+|an\s+)?(?:new\s+)?idea|idea)\s*[,:]?\s*(?:called\s+|for\s+)?(.+)$/i.exec(s);
  if(m)return {kind:'idea',group:'',text:m[1]};
  m=/^(?:add|save|write|note|put)\s+(.+?)\s+as\s+(?:a\s+|an\s+)?(?:new\s+)?idea$/i.exec(s);
  if(m)return {kind:'idea',group:'',text:m[1]};
  // "add X to Y": try the last "to/in/on/under" first, so "add go to the store to work" files "go to the store" under work
  // ("right"/"rite": how the recognizer often hears "write")
  const VERB=/^(?:add|put|write|right|rite|save|note|make|create|jot(?:\s+down)?)\s+(?:a\s+(?:task|note)\s+)?/i;
  const verb=VERB.exec(s);
  const body=verb?s.slice(verb[0].length):s;
  // the place first: "in the agent tab, write X" / "write to the agent X" / "agent tab: X"
  m=/^(?:(?:in|on|to|into|onto|under)\s+(.+)|((?:the\s+|my\s+)?\S+\s+(?:tab|list)\b.*))$/i.exec(body);
  if(m){
    const words=(m[1]||m[2]).split(' ');
    for(let n=Math.min(words.length-1,5);n>=1;n--){
      const dest=voiceDest(words.slice(0,n).join(' ')); if(!dest)continue;
      if(m[2]&&!/^(?:tab|list)[,.:;]*$/i.test(words[n-1]))continue; // no "in/to": only when it says "… tab"
      let rest=words.slice(n).join(' ').replace(/^[\s,.:;-]+/,'');
      const v2=VERB.exec(rest); if(v2)rest=rest.slice(v2[0].length);
      if(rest)return Object.assign(dest,{text:rest});
    }
  }
  const preps=[]; const re=/\s+(?:to|in|into|on|under|onto)\s+/gi; let p;
  while((p=re.exec(body)))preps.push({at:p.index,end:p.index+p[0].length});
  for(let i=preps.length-1;i>=0;i--){
    const text=body.slice(0,preps[i].at).replace(/[\s,;:-]+$/,'').trim(); if(!text)continue;
    // the place can be followed by more of the task: "to work on friday" → work, "… on friday"
    const words=body.slice(preps[i].end).split(' ');
    for(let n=Math.min(words.length,5);n>=1;n--){
      const dest=voiceDest(words.slice(0,n).join(' ')); if(!dest)continue;
      return Object.assign(dest,{text:(text+' '+words.slice(n).join(' ')).trim()});
    }
  }
  // no place named: "right" was probably meant ("right turn signal is broken")
  const plain=verb&&!/^(?:right|rite)\b/i.test(verb[0])?body:s;
  if(smart&&!tab){
    // after "Hey Romulus" (smart), with no tab said: the tab your past tasks like it are on, else a
    // question or an errand goes to Claude word for word, else Human (not whatever tab is open)
    const guess=voiceGuessTab(plain);
    if(guess)return {kind:'task',tab:guess,text:plain,learned:guess!=='list'};
    if(plain===s&&agentAvailable()&&VOICE_ASK.test(s))return {kind:'task',tab:'agent',text:s,raw:true};
    return {kind:'task',tab:'list',text:plain};
  }
  const where=tab||curTab;
  if(where==='ideas')return {kind:'idea',group:'',text:plain};
  return {kind:'task',tab:where==='calendar'?'list':where,text:plain};
}
/* Learning where things go: every task you have (done ones too) is a past request on the tab it ended
   up on, moves included, so a correction teaches it. The words of a new request vote for the tabs that
   past tasks sharing them are on, weighted by how rare the word is and scaled by each tab's size (so the
   big Human list doesn't win by sheer numbers). Only a clear winner counts; otherwise null. */
const VOICE_STOP=new Set('the a an and or but to of in on at for with from by my me i you it is are be this that these those some any up out about into over after before again then than so just get got do does did have has had can could would will should please need needs want wants make made take go going new add put write right rite save note list tab task tasks today tomorrow tonight morning afternoon evening night week next day monday tuesday wednesday thursday friday saturday sunday'.split(' '));
function voiceWords(text){
  return String(text||'').toLowerCase().replace(/['’]s\b/g,'').split(/[^a-z0-9]+/).filter(function(w){ return w.length>2&&!VOICE_STOP.has(w); })
    .map(function(w){ return w.length>5?w.replace(/(?:ing|ed|es)$/,''):w.length>3?w.replace(/s$/,''):w; });
}
const VOICE_WS_TAB={personal:'list',work:'work',school:'school',agent:'agent'};
function voiceGuessTab(text){
  const words=Array.from(new Set(voiceWords(text))); if(!words.length)return null;
  const size={}, seen={}; let all=0;
  state.tasks.forEach(function(t){
    const ws=taskWs(t), tab=VOICE_WS_TAB[ws]; if(!tab||!voiceTabOk(tab))return;
    size[ws]=(size[ws]||0)+1; all++;
    new Set(voiceWords(t.title)).forEach(function(w){ if(words.indexOf(w)===-1)return; const c=seen[w]=seen[w]||{}; c[ws]=(c[ws]||0)+1; });
  });
  const score={}, hits={}; let total=0;
  words.forEach(function(w){
    const c=seen[w]; if(!c)return;
    const n=Object.keys(c).reduce(function(a,ws){ return a+c[ws]; },0); if(n<2)return; // seen once is luck
    const idf=Math.log(1+all/n);
    const rate={}; let rsum=0; Object.keys(c).forEach(function(ws){ rate[ws]=c[ws]/size[ws]; rsum+=rate[ws]; });
    Object.keys(rate).forEach(function(ws){ const v=idf*rate[ws]/rsum; score[ws]=(score[ws]||0)+v; total+=v; hits[ws]=(hits[ws]||0)+c[ws]; });
  });
  let best=null; Object.keys(score).forEach(function(ws){ if(!best||score[ws]>score[best])best=ws; });
  if(!best||score[best]/total<0.7||hits[best]<2)return null;
  return VOICE_WS_TAB[best];
}
// "what's on Friday", "find me a cheap flight", "email Sam that …": Claude's job, not a to-do of yours
const VOICE_ASK=/^(?:what|what's|whats|when|where|who|whose|why|how|which|is|are|was|were|do|does|did|can|could|would|will|should|find|look\s+up|look\s+for|search|google|research|book|order|check|email|e-mail|text|message|reply|draft|write\s+(?:me|an?\s+email|a\s+message)|plan|compare|summari[sz]e|figure\s+out|help\s+me|show\s+me|tell\s+me|explain|get\s+me)\b/i;
let voiceOn=false;
const MIC_LABEL=I.mic+'<span>Speak</span>';
function voiceToast(msg,isErr){ const t=$('voiceToast'); if(!t)return; t.textContent=msg; t.className='voice-toast'+(isErr?' err':''); t.hidden=!msg; clearTimeout(voiceToast._t); if(msg)voiceToast._t=setTimeout(function(){ t.hidden=true; },6000); if(wakeLive&&msg)wakeBubble(isErr?'err':'done',msg); }
// "Hey Romulus" heard you: a speech bubble at the bottom. 'listen' (live words as you talk), then
// 'done' / 'err' with what happened, which fades after a few seconds
let wakeLive=false;
function wakeBubble(mode,text){
  const b=$('wakeBubble'); if(!b)return;
  clearTimeout(wakeBubble._t);
  if(mode==='hide'){ b.classList.add('out'); wakeBubble._t=setTimeout(function(){ b.hidden=true; b.classList.remove('out'); },260); return; }
  b.className='wake-bubble'+(mode==='listen'?'':' '+mode); b.hidden=false;
  if(mode==='listen'){ $('wakeHead').textContent='Listening…'; $('wakeWords').textContent=text||'a task, or ask the Agent something'; return; }
  $('wakeHead').textContent=mode==='err'?'Hmm…':'Got it'; $('wakeWords').textContent=text||'';
  wakeBubble._t=setTimeout(function(){ wakeBubble('hide'); },mode==='err'?5000:3500);
}
// speech: the phone app's Voice plugin (Android), or Windows dictation through the desktop app
function voiceEngine(){
  const d=window.desktop;
  if(d&&d.voiceListen)return {
    listen:function(){ return d.voiceListen(); },
    stop:function(){ return d.voiceStop(); },
    onPartial:function(cb){ const off=d.onVoicePartial(cb); return {remove:off}; }
  };
  const cap=window.Capacitor;
  if(cap&&typeof cap.nativePromise==='function'&&cap.isPluginAvailable&&cap.isPluginAvailable('Voice'))return {
    listen:function(){ return cap.nativePromise('Voice','listen',{}); },
    stop:function(){ return cap.nativePromise('Voice','stop',{}); },
    onPartial:function(cb){ return cap.addListener('Voice','partial',function(d){ if(d&&d.text)cb(d.text); }); }
  };
  return null;
}
// smart: started by "Hey Romulus" (see WakeWordService.java), so questions and errands can go to Claude
async function voiceAdd(smart){
  const v=voiceEngine(); if(!v)return;
  const btn=$('micBtn'), ti=$('newTitle');
  if(voiceOn){ if(smart!==true){ try{ await v.stop(); }catch(e){} } return; } // tap again: done talking
  smart=smart===true;
  voiceOn=true; btn.classList.add('listening'); btn.innerHTML=I.stop+'<span>Listening\u2026</span>';
  voiceToast(smart?'Hey! Listening\u2026 a task, or ask the Agent something':'Listening\u2026 say the task (and a day, if it has one)');
  const before=ti.value, prevPh=ti.placeholder; ti.value=''; ti.placeholder='Listening\u2026';
  if(smart){ wakeLive=true; wakeBubble('listen'); }
  let partial=null, heard=''; try{ partial=v.onPartial(function(text){ heard=text; ti.value=text; if(smart)wakeBubble('listen','“'+text+'”'); }); }catch(e){}
  buzz('tap');
  try{
    const r=await v.listen();
    if(r&&r.error)throw new Error(r.error);
    if(r&&r.timedOut){ // never heard a pause (background noise): leave it in the box to check instead of adding it
      ti.value=heard||before; voiceToast(heard?'Stopped listening — check the text and press Add':'Didn’t catch that — tap Speak and try again',!heard);
      if(heard)ti.focus(); return;
    }
    // the final answer can come back empty even though it heard you (some Android recognizers end with
    // "no match"): then use the last words it showed while you were talking
    const said=((r&&r.text)||heard||'').trim();
    if(!said){ ti.value=before; voiceToast('Didn\u2019t catch that \u2014 tap Speak and try again',true); return; }
    const cmd=parseVoiceCommand(said,state.activeTab,smart);
    if(cmd.tab&&!voiceTabOk(cmd.tab)){ ti.value=before; voiceToast('The '+VOICE_TAB_NAME[cmd.tab]+' list isn\u2019t connected on this device',true); return; }
    if(cmd.kind==='tab'){ ti.value=before; switchTab(cmd.tab); window.scrollTo(0,0); voiceToast('Opened '+VOICE_TAB_NAME[cmd.tab]); return; }
    if(cmd.kind==='grocery'){
      ti.value=before;
      const g=addToGroceries(cmd.text);
      voiceToast(g?'On the next grocery order: '+g.names.join(', '):'Couldn’t find your grocery list',!g);
      return;
    }
    if(cmd.kind==='idea'){
      ti.value=before;
      const text=cmd.text.trim().replace(/^./,function(c){ return c.toUpperCase(); });
      ideaAddCard(cmd.group,text); switchTab('ideas');
      voiceToast('Added \u201C'+text+'\u201D to Ideas \u2192 '+(ideaGroup(cmd.group).name||'Unsorted'));
      return;
    }
    // a task: go to its tab so addTask files it there (and you can see it land)
    if(cmd.tab!==state.activeTab)switchTab(cmd.tab);
    if(cmd.tab==='list')state.wsFilter=null; // "add \u2026 to human" shouldn't land under the Work filter
    // what you asked Claude stays as you said it (no dates pulled out of "what's on Friday")
    const p=cmd.raw?{title:cmd.text.charAt(0).toUpperCase()+cmd.text.slice(1),due:null,dueTime:null}:parseSpokenTask(cmd.text);
    if(!p.title){ ti.value=before; voiceToast('Heard \u201C'+said+'\u201D but no task in it',true); return; }
    // fill the boxes like you'd typed it, add, then put the sticky date/time back how they were
    const dueEl=$('newDue'), timeEl=$('newTime'), oldDue=dueEl.value, oldTime=timeEl.value;
    ti.value=p.title; dueEl.value=p.due||''; timeEl.disabled=!p.due; timeEl.value=p.dueTime||'';
    await addTask();
    dueEl.value=oldDue; timeEl.value=oldTime; timeEl.disabled=!oldDue;
    voiceToast(cmd.raw?'Sent to the Agent: \u201C'+p.title+'\u201D':'Added \u201C'+p.title+'\u201D to '+VOICE_TAB_NAME[cmd.tab]+(cmd.learned?' (like your past ones)':'')+' \u00B7 '+(p.due?dateInfo(p.due,p.dueTime).text:'no date'));
  }catch(e){
    ti.value=before; voiceToast((e&&e.message)||'Voice didn\u2019t work',true);
  }finally{
    voiceOn=false; btn.classList.remove('listening'); btn.innerHTML=MIC_LABEL; ti.placeholder=prevPh;
    // still saying "Listening…" (it ended without a message): just let it go
    if(smart){ wakeLive=false; const b=$('wakeBubble'); if(!b.classList.contains('done')&&!b.classList.contains('err'))wakeBubble('hide'); }
    if(partial&&typeof partial.remove==='function')partial.remove();
    else if(partial&&typeof partial.then==='function')partial.then(function(h){ if(h&&h.remove)h.remove(); }).catch(function(){});
  }
}
// the site a link goes to, for its button: "Amazon", "Fresha", "Yelp"… (not always Amazon)
// 3D-model sites: an option there is something to print, not to buy
// what the card's button does for an option's link: buy (a shop), print (a 3D-model site), or just send
// him the link (jobs, bookings, articles, forms… anything that isn't a purchase)
function optionKind(url){
  if(!url)return 'pick';
  if(isModelSite(url))return 'print';
  let h=''; try{ h=new URL(String(url)).hostname.toLowerCase(); }catch(e){ return 'link'; }
  return /(^|\.)(amazon\.[a-z.]+|amzn\.(to|com)|bestbuy\.com|walmart\.com|target\.com|newegg\.com|ebay\.com|etsy\.com|homedepot\.com|lowes\.com|costco\.com|bhphotovideo\.com|microcenter\.com|bambulab\.com|aliexpress\.com|temu\.com|adorama\.com|rei\.com|ikea\.com)$/.test(h)?'buy':'link';
}
// an Amazon product page: The Agent orders it (after a yes) instead of emailing the link
function isAmazon(url){
  let h=''; try{ h=new URL(String(url)).hostname.toLowerCase(); }catch(e){ return false; }
  return /(^|\.)(amazon\.com|amzn\.(to|com))$/.test(h);
}
// a flight or event-ticket site: The Agent books it after a yes, like Amazon (tickets skill)
function isTicketSite(url){
  let h=''; try{ h=new URL(String(url)).hostname.toLowerCase(); }catch(e){ return false; }
  return /(^|\.)(ticketmaster\.com|livenation\.com|axs\.com|seatgeek\.com|stubhub\.com|vividseats\.com|delta\.com|united\.com|aa\.com|southwest\.com|jetblue\.com|spirit\.com|flyfrontier\.com|alaskaair\.com)$/.test(h);
}
function isModelSite(url){
  let h=''; try{ h=new URL(String(url)).hostname.toLowerCase(); }catch(e){ return false; }
  return /(^|\.)(makerworld|printables|thingiverse|thangs|cults3d|myminifactory|prusaprinters)\.com$/.test(h);
}
function siteName(url){
  let h=''; try{ h=new URL(String(url)).hostname.toLowerCase(); }catch(e){ return 'Open'; }
  if(/(^|\.)amazon\.|(^|\.)amzn\.(to|com)$/.test(h))return 'Amazon';
  const parts=h.replace(/^www\d?\./,'').split('.');
  // last label before the TLD (handles co.uk-style endings too)
  const name=parts.length>2&&parts[parts.length-2].length<=3?parts[parts.length-3]:parts[Math.max(0,parts.length-2)];
  return name?name.charAt(0).toUpperCase()+name.slice(1):'Open';
}
// links from Claude's options open in the real browser, not inside the app
function openExternal(url){
  if(!/^https?:\/\//i.test(url))return;
  if(window.desktop&&window.desktop.gcalOpenUrl)window.desktop.gcalOpenUrl(url);
  else if(window.Capacitor)window.location.href=url; // Capacitor hands off-site URLs to the system browser
  else window.open(url,'_blank','noopener');
}
const SHARE_ICON='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>';
// send just the link to people: the phone's Share sheet (Messages, WhatsApp…), else copy it
const MAIL_ICON='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>';
function shareLink(url,btn){
  url=String(url||''); if(!/^https?:\/\//i.test(url))return;
  const cap=window.Capacitor;
  if(cap&&typeof cap.nativePromise==='function'&&cap.isPluginAvailable&&cap.isPluginAvailable('ShareLink')){ cap.nativePromise('ShareLink','share',{url:url}).catch(function(){}); return; }
  if(navigator.share){ navigator.share({url:url}).catch(function(){}); return; }
  // on the desktop there's no Share sheet, so copy it and say so on the button itself
  const flash=function(msg){ if(!btn)return; const was=btn.innerHTML; btn.textContent=msg; btn.disabled=true; setTimeout(function(){ btn.innerHTML=was; btn.disabled=false; },1500); };
  const done=function(){ flash('Copied'); };
  const oldCopy=function(){ const ta=document.createElement('textarea'); ta.value=url; ta.style.cssText='position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); let ok=false; try{ ok=document.execCommand('copy'); }catch(e){} ta.remove(); if(ok)done(); else flash('Couldn’t copy'); };
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(url).then(done,oldCopy); else oldCopy();
}
