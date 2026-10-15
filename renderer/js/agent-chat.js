/* Agent tasks: the conversation with Claude / the mini PC, and repeat schedules.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── agent conversation + repeat schedule (agent tasks only) ── */
const convOpen=new Set(); // tasks whose conversation drop-down is open
const liveText={};        // task id → what the mini PC's model is doing right now (streamed from the desktop app)
let localStat=null;       // last mini PC status: {configured, online, model, loaded, address}
function refreshLocalStatus(){
  if(!window.desktop||!window.desktop.localStatus)return;
  window.desktop.localStatus().then(function(s){
    const changed=JSON.stringify(s)!==JSON.stringify(localStat); localStat=s;
    if(changed&&state.activeTab==='agent')render();
  }).catch(function(){});
}
function agentSay(t,who,text,extra){
  if(!text)return;
  if(!Array.isArray(t.history))t.history=[];
  const e={who:who,text:String(text).slice(0,2000),at:Date.now()};
  if(extra)Object.assign(e,extra);
  t.history.push(e);
  if(t.history.length>40)t.history=t.history.slice(-40);
}
/* photos attached to an agent reply: shrunk on the device, uploaded to the agent-attachments
   bucket (under the agent sync key), then passed to Claude with the reply */
const pendingAtts={}; // task id → [{blob, preview}] picked but not sent yet
const attachTargets={}; // task id → {add: addFiles(), el} of its open reply box
const picTargets={};    // task id → {add: addPics(), el} of its open Screenshots section (any non-agent task)
let lastPanelId=null;   // the task panel you last clicked/typed in (a paste goes there first)
function clipboardImages(e){
  const cd=e.clipboardData; if(!cd)return [];
  const out=[];
  Array.from(cd.items||[]).forEach(function(it){ if(it.kind==='file'&&/^image\//.test(it.type)){ const f=it.getAsFile(); if(f)out.push(f); } });
  // some platforms expose the pasted image only via .files
  if(!out.length&&cd.files)Array.from(cd.files).forEach(function(f){ if(/^image\//.test(f.type))out.push(f); });
  return out;
}
// Paste a screenshot (Win+Shift+S / Print Screen → Ctrl+V) and it lands on the
// right place, like a chat box: the reply box or Add box you're typing in, else the
// task you're working in / have selected / the only one open, else the Add box.
// Targets are only counted while they're actually on screen (a task left open on
// another tab or hidden by a filter used to make every paste ambiguous → ignored).
function onScreen(t){ return t&&t.el&&t.el.isConnected&&t.el.getClientRects().length>0; }
function pasteToast(msg){
  let b=document.getElementById('pasteToast');
  if(!b){ b=el('div',null,''); b.id='pasteToast'; b.setAttribute('role','status'); b.style.cssText='position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:9999;max-width:min(440px,calc(100vw - 32px));background:var(--ink);color:var(--bg);font-family:var(--mono);font-size:11.5px;line-height:1.45;padding:9px 14px;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.18);text-align:center'; document.body.appendChild(b); }
  b.textContent=msg; b.hidden=false;
  clearTimeout(pasteToast.t); pasteToast.t=setTimeout(function(){ b.hidden=true; },3800);
}
document.addEventListener('paste',function(e){
  const imgs=clipboardImages(e); if(!imgs.length)return;
  const live=function(map){ return Object.keys(map).filter(function(k){ return onScreen(map[k]); }); };
  const pics=live(picTargets), replies=live(attachTargets);
  const pick=function(ids){
    if(ids.length===1)return ids[0];
    if(ids.indexOf(lastPanelId)!==-1)return lastPanelId;
    if(ids.indexOf(state.selectedId)!==-1)return state.selectedId;
    return null;
  };
  const go=function(map,id){ e.preventDefault(); map[id].add(imgs); };
  // 1) typing directly in a reply box → that task
  const ae=document.activeElement, focusedReply=ae&&ae.dataset&&ae.dataset.replyFor;
  const listy=state.activeTab!=='ideas'&&state.activeTab!=='calendar';
  if(ae&&ae.id==='newTitle'&&listy&&attachProfile()){ e.preventDefault(); addComposerFiles(imgs); return; }
  if(focusedReply&&replies.indexOf(focusedReply)!==-1)return go(attachTargets,focusedReply);
  // 2) the task you're in (focus inside its panel / last clicked / selected / the only open one)
  const inPanel=function(map,ids){ return ids.filter(function(k){ const p=map[k].el.closest('.panel'); return ae&&p&&p.contains(ae); })[0]; };
  let id=inPanel(picTargets,pics)||inPanel(attachTargets,replies);
  if(id)return go(pics.indexOf(id)!==-1?picTargets:attachTargets,id);
  id=pick(pics); if(id)return go(picTargets,id);
  id=pick(replies); if(id)return go(attachTargets,id);
  // 3) nothing chosen → staged on the new task you're writing (like attaching in a chat box)
  if(!listy)return;
  if(!attachProfile()){ pasteToast('Screenshots need agent sync — connect it in Settings.'); return; }
  if(pics.length+replies.length>1){ pasteToast('A few tasks are open — click the one you want, then paste again.'); return; }
  e.preventDefault(); addComposerFiles(imgs); $('newTitle').focus();
});
function attachProfile(){ const a=syncState.cfg&&syncState.cfg.agent; return validProfile(a)?a:null; }
async function shrinkImage(file){ // → JPEG blob, longest side ≤ 1600px
  const src=URL.createObjectURL(file);
  try{
    const img=await new Promise(function(res,rej){ const i=new Image(); i.onload=function(){ res(i); }; i.onerror=function(){ rej(new Error('can\u2019t read that image')); }; i.src=src; });
    const k=Math.min(1,1600/Math.max(img.naturalWidth,img.naturalHeight));
    const c=document.createElement('canvas'); c.width=Math.max(1,Math.round(img.naturalWidth*k)); c.height=Math.max(1,Math.round(img.naturalHeight*k));
    c.getContext('2d').drawImage(img,0,0,c.width,c.height);
    const blob=await new Promise(function(r){ c.toBlob(r,'image/jpeg',0.85); });
    if(!blob)throw new Error('can\u2019t read that image');
    return blob;
  } finally { URL.revokeObjectURL(src); }
}
async function uploadAttachment(blob){
  const a=attachProfile(); if(!a)throw new Error('agent sync isn\u2019t set up');
  const base=a.url.replace(/\/+$/,''), path=a.syncKey+'/'+uid()+'.jpg';
  const r=await fetch(base+'/storage/v1/object/agent-attachments/'+path,{method:'POST',headers:{apikey:a.key,Authorization:'Bearer '+a.key,'Content-Type':'image/jpeg'},body:blob});
  if(!r.ok)throw new Error('upload failed ('+r.status+')');
  return base+'/storage/v1/object/public/agent-attachments/'+path;
}
const composerAtts=[]; // photos staged for the new task being typed (pasted into the Add box)
async function addComposerFiles(list){
  const files=Array.from(list||[]).filter(function(f){ return /^image\//.test(f.type); }).slice(0,Math.max(0,6-composerAtts.length));
  for(const f of files){
    try{ const blob=await shrinkImage(f); composerAtts.push({blob:blob,preview:URL.createObjectURL(blob)}); }catch(e){}
  }
  drawComposerAtts();
}
function drawComposerAtts(){
  const box=document.getElementById('newAtts'); if(!box)return;
  box.innerHTML=''; box.hidden=!composerAtts.length||state.activeTab==='ideas'||state.activeTab==='calendar';
  composerAtts.forEach(function(a,i){
    const th=el('div','att-thumb'); const im=document.createElement('img'); im.src=a.preview; im.alt='Photo for Claude';
    im.addEventListener('click',function(){ openLightbox(composerAtts.map(function(x,j){ return {image:x.preview,label:'Photo '+(j+1)}; }),i); });
    const x=el('button',null,'\u2715'); x.setAttribute('aria-label','Remove photo');
    x.addEventListener('click',function(){ URL.revokeObjectURL(a.preview); composerAtts.splice(i,1); drawComposerAtts(); });
    th.appendChild(im); th.appendChild(x); box.appendChild(th);
  });
}
/* phone home-screen widgets + Android Share menu call this (see MainActivity.java). Returns
   "keyboard" when it focused a text box, so the phone shows the keyboard. */
function openTaskById(id){
  const t=state.tasks.find(function(x){ return x.id===id; }); if(!t)return;
  const w=taskWs(t);
  const tab=w==='agent'?'agent':(w==='school'&&schoolConfigured())?'school':(w==='work'&&workConfigured())?'work':'list';
  if(t.done)state.showDone=true;
  if(tab==='list'&&state.wsFilter&&w!==state.wsFilter&&!(w==='school'&&state.wsFilter==='personal'))state.wsFilter=null;
  // drop a tag filter or search that would hide it
  if(state.filter!==null&&t.tag!==state.filter)state.filter=null;
  if(state.search){ state.search=''; $('searchBox').value=''; }
  state.expanded.add(id);
  switchTab(tab); // (clears the selection when the tab changes, so select after)
  state.selectedId=id; render();
  requestAnimationFrame(function(){
    const li=document.querySelector('li.task[data-id="'+id+'"]'); if(!li)return;
    li.scrollIntoView({block:'center'});
    li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash');
  });
}
window.__tasksHook=function(p){
  p=p||{};
  if(p.kind==='open'){ openTaskById(p.arg); return 'ok'; }
  if(p.kind==='tab'){ switchTab(p.arg==='agent'&&agentConfigured()?'agent':p.arg==='school'&&schoolConfigured()?'school':p.arg==='work'&&workConfigured()?'work':'list'); window.scrollTo(0,0); return 'ok'; }
  if(p.kind==='voice'){
    switchTab(p.arg==='agent'&&agentConfigured()?'agent':'list'); window.scrollTo(0,0);
    setTimeout(voiceAdd,300); return 'ok';
  }
  if(p.kind==='wake'){ // "Hey Romulus" (WakeWordService.java): listen right where you are
    if(!$('settingsPanel').hidden)setSettingsOpen(false);
    setTimeout(function(){ voiceAdd(true); },250); return 'ok';
  }
  if(p.kind==='quickAdd'){
    switchTab(p.arg==='agent'&&agentConfigured()?'agent':'list'); window.scrollTo(0,0);
    const ti=$('newTitle'); ti.focus(); return 'keyboard';
  }
  if(p.kind==='share'){
    switchTab(agentConfigured()?'agent':'list'); window.scrollTo(0,0);
    const bits=[p.subject,p.text].filter(function(x){ return x&&String(x).trim(); }).map(function(x){ return String(x).trim(); });
    const ti=$('newTitle'); if(bits.length)ti.value=bits.join(' \u2014 ').slice(0,600);
    (p.images||[]).forEach(function(d){
      fetch(d).then(function(r){ return r.blob(); }).then(function(b){ addComposerFiles([new File([b],'shared.jpg',{type:'image/jpeg'})]); });
    });
    ti.focus(); return 'keyboard';
  }
  return 'ok';
};
function photoStrip(urls,cls){ // clickable thumbnails → full-screen viewer
  const wrap=el('div',cls||'conv-imgs');
  urls.forEach(function(u,i){
    if(!/^https:\/\//i.test(String(u)))return;
    const im=document.createElement('img'); im.src=u; im.alt='Attached photo '+(i+1); im.loading='lazy'; im.referrerPolicy='no-referrer';
    im.addEventListener('click',function(e){ e.stopPropagation(); openLightbox(urls.map(function(x,j){ return {image:x,label:'Your photo '+(j+1)}; }),i); });
    wrap.appendChild(im);
  });
  return wrap;
}
const REPEAT_LABELS={day:'Every day',weekday:'Weekdays',week:'Every week'};
// next run strictly after `from`, at r.at local time
function nextRepeatAt(r,from){
  const p=String(r.at||'08:00').split(':').map(Number);
  const d=new Date(from); d.setHours(p[0]||0,p[1]||0,0,0);
  if(d.getTime()<=from)d.setDate(d.getDate()+1);
  if(r.every==='weekday'){ while(d.getDay()===0||d.getDay()===6)d.setDate(d.getDate()+1); }
  if(r.every==='week'){ const wd=r.day!=null?r.day:d.getDay(); while(d.getDay()!==wd)d.setDate(d.getDate()+1); }
  return d.getTime();
}
function repeatText(r){
  if(!r)return '';
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return (r.every==='week'?'Every '+days[r.day!=null?r.day:1]:REPEAT_LABELS[r.every]||'Repeats')+' at '+fmtTime(r.at||'08:00');
}
// Moving between channels = delete here + a fresh copy (new id) there, so the
// old channel's tombstone can never remove the moved copy.
// James's override: the other model takes this task over. The conversation, his reply and the links all
// live on the task, so the new model starts from everything said so far. A late answer from the old
// model is ignored (the app only applies a result to a task still "working" for it; the connector's
// finish_task checks who holds the claim).
// who has the task now: its lane, or for older tasks whoever answered last; null = nobody yet
// 'gemini' / 'openai' = the cloud lane ('claude' on the server) with that AI only (t.cloud)
const PINNED_CLOUDS=['gemini','openai'];
function laneNow(t){
  if(t.lane==='claude'&&PINNED_CLOUDS.indexOf(t.cloud)!==-1)return t.cloud;
  if(t.lane==='claude'||t.lane==='local')return t.lane;
  const last=(Array.isArray(t.history)?t.history:[]).filter(function(h){ return h.who==='claude'; }).slice(-1)[0];
  return last?(last.lane==='local'?'local':'claude'):null;
}
function setLane(t,to){
  const from=laneNow(t);
  if(from===to)return;
  // switching (not a first pick) asks first
  const name={claude:'Claude',gemini:'Gemini',openai:'ChatGPT',local:'your mini PC'}[to];
  if(from&&!window.confirm(to==='local'
    ?'Send this task to your mini PC? It takes over with the whole conversation.'
    :'Send this task to '+name+'? '+name+' will see the whole conversation, including anything the others wrote.'))return;
  t.lane=to==='local'?'local':'claude'; if(PINNED_CLOUDS.indexOf(to)!==-1)t.cloud=to; else delete t.cloud; delete t.routeAsk; delete t.claimedBy; delete t.claimedAt;
  t.status='queued'; t.waitUntil=null; if(!from)t.note=null;
  agentSay(t,'sys',(from?'You switched this to ':'You sent this to ')+name);
  buzz('tap'); touch();
}
function moveTask(t,toWs){
  if(t.googleEventId && window.desktop && window.desktop.gcalDeleteEvent) window.desktop.gcalDeleteEvent(t.googleEventId,t.calRef);
  const now=Date.now();
  const c=Object.assign({},t,{id:uid(),ws:toWs,googleEventId:null,calRef:null,updatedAt:now,subs:t.subs.map(function(s){ return Object.assign({},s); })});
  if(toWs==='agent'){ c.fromWs=taskWs(t); c.status='queued'; c.note=null; c.reply=null; c.options=null; c.done=false; c.repeat=null; c.nextRun=null; c.repeatDue=false;
    // carry any screenshots into Claude's view: as reply images + a conversation entry
    const imgs=Array.isArray(t.images)?t.images.slice(0,6):[];
    c.replyImages=imgs.length?imgs:null;
    c.history=imgs.length?[{who:'you',text:'Screenshot(s) from the task',at:now,images:imgs}]:[];
  }
  else { ['status','note','reply','replyImages','options','history','repeat','nextRun','repeatDue','fromWs','waitUntil','useInbox'].forEach(function(k){ delete c[k]; }); }
  ['lane','claimedBy','claimedAt'].forEach(function(k){ delete c[k]; }); // routed and claimed afresh
  // only school tasks carry a type + instructions; the old office build drops unknown fields on work tasks
  if(toWs!=='school'&&toWs!=='agent'){ delete c.kind; delete c.notes; }
  state.tasks=state.tasks.filter(function(x){ return x.id!==t.id; }).concat([c]);
  state.expanded.delete(t.id);
  state.tombstones.push({id:t.id,deletedAt:now});
  touch();
}
function setDone(t,v){
  t.done=v;
  if(taskWs(t)==='agent'){
    // re-opening an agent task hands it back to Claude; ticking one off closes it
    if(!v&&t.status==='done')t.status='queued';
    if(v)t.status='done';
  }
}
function toggleDone(t,liEl,checkEl){
  if(!t.done)buzz('check'); // only finishing something buzzes
  if(t.done){ setDone(t,false); touch(); }
  else if(prefersReduced){ setDone(t,true); touch(); }
  else { checkEl.classList.add('on'); liEl.classList.add('leaving'); setTimeout(function(){ setDone(liveTask(t),true); touch(); },200); }
}
function deleteTask(t){
  if(t.googleEventId && window.desktop && window.desktop.gcalDeleteEvent) window.desktop.gcalDeleteEvent(t.googleEventId,t.calRef);
  state.tasks=state.tasks.filter(function(x){ return x.id!==t.id; }); state.expanded.delete(t.id);
  state.tombstones.push({id:t.id,deletedAt:Date.now()});
  buzz('delete');
  touch();
}
function startEdit(t,span){
  const input=el('input','title-edit'); input.value=t.title;
  input.addEventListener('click',function(e){ e.stopPropagation(); });
  let finished=false;
  function commit(){ if(finished)return; finished=true; const v=input.value.trim(); if(v)liveTask(t).title=v; touch(); }
  input.addEventListener('keydown',function(e){ if(e.key==='Enter')commit(); if(e.key==='Escape'){finished=true;render();} });
  input.addEventListener('blur',commit);
  span.replaceWith(input); input.focus(); input.select();
}
