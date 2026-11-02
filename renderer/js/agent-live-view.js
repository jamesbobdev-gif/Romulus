/* ── live view: the agent browser inside Tasks ──
   Watch Claude work in the agent browser and click / scroll / type to take over (log in, fix a field).
   It talks to the agent browser's localhost debugging port (the main process lists its tabs):
   Page.startScreencast sends pictures of the page, Input.dispatch* sends his mouse and keys back.
   It follows the agent: when a new tab opens, the view switches to it. Desktop only.
   While Claude works on a task the view sits in that task's card by itself (embedded), and shows only
   once the browser has a real page up; ⤢ makes it big. */
let liveView=null; // { box, img, ws, page, pages, meta, nextId, timer, touchedAt, host, forId, big }
const liveHidden={}; // task id → he closed its embedded view: a button brings it back

function liveViewAvailable(){ return !!(window.desktop&&window.desktop.livePages); }
// Watch on a task: that task's own tabs only (agent/task-tabs.js), as its run left them. page: where the
// run ended, reopened only if its tab is gone
function watchButton(t){
  const b=el('button','btn-ghost agent-watch','◉ Watch');
  b.title='Watch this task’s browser here, and click or type to take over';
  b.addEventListener('click',async function(e){
    e.stopPropagation();
    let id=null;
    if(window.desktop.liveOpen){ b.disabled=true; try{ id=await window.desktop.liveOpen(t.page||null,t.id); }catch(err){} b.disabled=false; }
    // a view showing another task (say, one working now) makes way for this one
    if(liveView&&liveView.forId!==t.id)closeLiveView();
    const had=!!liveView;
    if(had){ liveView.want=id; liveView.touchedAt=Date.now(); }
    openLiveView(null,t.id,id);
    if(had&&id)livePoll();
  });
  return b;
}

/* the local model stuck on a task: its browser on top of the Agent tab, live, so he can see what it sees and
   click or type to sort it out (log in, pick the course), then reply. The picture it took when it stopped
   shows instead while the live one can't be reached, or while a task on this computer has the view */
let lupaStuckAt=0; // which one, when several are waiting
// human: on top of the Human tab too, so he can put right what went wrong in its browser; a step only he can
// do (a password, an MFA code, a robot check: agent/signin-watch.js wallKind) first. "Done, try again" when he has
const isVerify=function(t){ return !!(t.stuck&&t.stuck.verify); };
function drawLupaStuck(show,human){
  const box=$('lupaStuck'); if(!box)return;
  const waiting=!show?[]:state.tasks.filter(function(t){ return taskWs(t)==='agent'&&!t.done&&t.status==='needs-you'&&t.lane==='local'&&!t.parked; })
    .sort(function(a,b){ return (isVerify(b)?1:0)-(isVerify(a)?1:0)||((b.stuck||b.shot)?1:0)-((a.stuck||a.shot)?1:0)||getSortKey(a)-getSortKey(b); }); // his step first, then stopped in the browser
  box.textContent='';
  if(!waiting.length){ box.hidden=true; if(liveView&&liveView.src==='lupa')closeLiveView(); return; }
  box.hidden=false;
  const t=waiting[lupaStuckAt%waiting.length], key='lupa:'+t.id;
  const head=el('div','lupa-stuck-head');
  head.appendChild(el('b',null,isVerify(t)?'Your turn: the local model needs you to verify on':'The local model stopped on'));
  const name=el('button','lupa-stuck-title',t.title); name.title='Open this task';
  name.addEventListener('click',function(){ openTaskById(t.id); });
  head.appendChild(name);
  if(waiting.length>1){
    const next=el('button','btn-ghost lupa-stuck-next',((lupaStuckAt%waiting.length)+1)+' of '+waiting.length+' ›'); next.title='The next one it stopped on';
    next.addEventListener('click',function(){ lupaStuckAt++; render(); });
    head.appendChild(next);
  }
  box.appendChild(head);
  const why=t.stuck&&t.stuck.reason||String(t.note||'').replace(/\s+/g,' ').slice(0,220);
  if(why)box.appendChild(el('div','lupa-stuck-why',why));
  if(human){
    const row=el('div','yes-btns');
    const go=el('button','btn-accent','Done, try again'); go.title='You sorted it out in its browser: the local model picks the task up again from what the page shows now';
    go.addEventListener('click',function(){ const lt=liveTask(t); if(!lt.reply)lt.reply=isVerify(t)?'I did the verification in your browser. Carry on.':'I fixed it in your browser: look at the page again and carry on.'; retryAgent(lt); });
    row.appendChild(go);
    box.appendChild(row);
  }
  // live: not while a task here is working (its card has the one view), not over the hub
  const busyHere=state.tasks.some(function(x){ return taskWs(x)==='agent'&&!x.done&&x.status==='working'&&x.lane!=='local'; });
  const inCard=!human&&state.expanded.has(t.id); // its card is open below: the view is there (lupaEmbed)
  if(inCard)box.appendChild(el('div','lupa-stuck-why','Its browser is open in the task below.'));
  else if(liveViewAvailable()&&!busyHere){
    const slot=el('div','live-slot lupa-stuck-live'); box.appendChild(slot);
    if(liveHidden[key]){
      const b=el('button','btn-ghost agent-watch','◉ Show the browser');
      b.addEventListener('click',function(){ delete liveHidden[key]; render(); });
      slot.appendChild(b);
    } else openLiveView(slot,key,null,'lupa');
  } else if(liveView&&liveView.src==='lupa')closeLiveView();
  if(t.shot){ const ps=photoStrip([t.shot],'stuck-shot lupa-stuck-shot'); const im=ps.querySelector('img'); if(im){ im.alt='What the browser showed'; im.title='What its browser showed when it stopped. Click to enlarge'; } box.appendChild(ps); }
}

// a local task's open card: the mini PC's browser in it (he's looking at this one, so it has the view)
function lupaEmbed(panel,t){
  const key='lupa:'+t.id, slot=el('div','live-slot lupa-card-live'); panel.appendChild(slot);
  if(liveHidden[key]){
    const b=el('button','btn-ghost agent-watch','◉ Show its browser');
    b.title='The local model’s browser, live: click and type in it yourself';
    b.addEventListener('click',function(e){ e.stopPropagation(); delete liveHidden[key]; render(); });
    slot.appendChild(b); return;
  }
  openLiveView(slot,key,null,'lupa');
}
// a working task's card: the live view goes in its slot (one view at a time: the task that has it keeps it,
// and so does the local model's browser while a card he opened shows it)
function liveEmbed(slot,id){
  if(liveView&&liveView.src==='lupa'&&liveView.host&&liveView.host.isConnected&&liveView.host.classList.contains('lupa-card-live'))return;
  if(liveHidden[id]){
    const b=el('button','btn-ghost agent-watch','◉ Show the browser');
    b.addEventListener('click',function(e){ e.stopPropagation(); delete liveHidden[id]; render(); });
    slot.appendChild(b); return;
  }
  if(liveView&&liveView.forId&&liveView.forId!==id&&(liveView.big||state.tasks.some(function(t){ return t.id===liveView.forId&&t.status==='working'; })))return;
  openLiveView(slot,id);
}
// src 'lupa': the local model's browser on the mini PC (the stuck task on top of the Agent tab), else this computer's
function openLiveView(host,forId,want,src){
  if(liveView&&liveView.src!==(src||null))closeLiveView(); // one view at a time, of one browser
  if(liveView){
    if(host){ liveView.host=host; liveView.forId=forId; if(!liveView.big)host.appendChild(liveView.box); }
    else liveBig(true);
    return;
  }
  const box=el('div','live-view'+(host?' live-embed':'')); box.tabIndex=0; box.setAttribute('role','dialog'); box.setAttribute('aria-label','Agent browser, live');
  const bar=el('div','live-bar');
  const dot=el('span','live-dot'); bar.appendChild(dot);
  const where=el('div','live-where','Connecting…'); bar.appendChild(where);
  const tabs=el('select','live-tabs'); tabs.title='Which tab to watch'; tabs.hidden=true; bar.appendChild(tabs);
  const big=el('button','icon live-bigger','⤢'); big.title='Make it bigger'; big.setAttribute('aria-label','Make the live view bigger'); big.hidden=!host; bar.appendChild(big);
  const close=el('button','icon live-close'); close.innerHTML=I.x; close.setAttribute('aria-label','Close the live view'); bar.appendChild(close);
  box.appendChild(bar);
  const stage=el('div','live-stage');
  const img=el('img','live-img'); img.alt=''; img.draggable=false; stage.appendChild(img);
  const msg=el('div','live-msg'); stage.appendChild(msg);
  box.appendChild(stage);
  box.appendChild(el('div','live-hint','Click, scroll and type here to use it yourself. The Agent keeps going when you’re done.'));
  // what has keyboard focus: a hidden box, so text that comes without key presses (emoji picker,
  // voice typing, IME) arrives as input and is typed into the page too
  const keys=el('textarea','live-keys'); keys.setAttribute('aria-label','Type into the agent browser'); keys.tabIndex=-1; box.appendChild(keys);
  (host||document.body).appendChild(box);
  liveView={box:box,keys:keys,img:img,msg:msg,where:where,tabs:tabs,dot:dot,bigBtn:big,ws:null,page:null,pages:[],meta:null,nextId:1,timer:null,touchedAt:0,seen:{},want:want||null,
    host:host||null,forId:forId||null,big:!host,src:src||null};
  if(host&&src!=='lupa')box.hidden=true; // until the browser shows a real page (the mini PC's: always, so he sees why when it can't connect)

  // closing the embedded view hides it for that task; closing the big one puts it back in the card
  close.addEventListener('click',function(e){ e.stopPropagation(); if(liveView.big&&liveView.host&&liveView.host.isConnected)liveBig(false); else { if(liveView.forId)liveHidden[liveView.forId]=true; closeLiveView(); if(liveView===null)render(); } });
  big.addEventListener('click',function(e){ e.stopPropagation(); liveBig(!liveView.big); });
  box.addEventListener('click',function(e){ e.stopPropagation(); }); // using it doesn't fold the card
  tabs.addEventListener('change',function(){ const p=liveView.pages.find(function(x){ return x.id===tabs.value; }); if(p){ liveView.touchedAt=Date.now(); liveConnect(p,true); } });
  box.addEventListener('keydown',liveKey); box.addEventListener('keyup',liveKey);
  box.addEventListener('focus',function(){ keys.focus(); });
  keys.addEventListener('input',function(){ if(keys.value){ liveSend('Input.insertText',{text:keys.value}); keys.value=''; } });
  box.addEventListener('paste',function(e){ const t=e.clipboardData&&e.clipboardData.getData('text'); if(t){ e.preventDefault(); liveSend('Input.insertText',{text:t}); } });
  liveMouse(img);
  if(!host)keys.focus(); // embedded: his typing stays in the reply box until he clicks the page
  livePoll(); liveView.timer=setInterval(livePoll,2000);
}
// big (over the app) or back in the task's card
function liveBig(on){
  const v=liveView; if(!v)return;
  v.big=on; v.box.classList.toggle('live-embed',!on);
  v.bigBtn.textContent=on?'⤡':'⤢'; v.bigBtn.title=on?'Put it back in the task':'Make it bigger';
  v.bigBtn.hidden=on&&!(v.host&&v.host.isConnected);
  if(on){ v.box.hidden=false; document.body.appendChild(v.box); v.keys.focus(); }
  else if(v.host&&v.host.isConnected)v.host.appendChild(v.box);
  else closeLiveView();
}
function closeLiveView(){
  if(!liveView)return;
  clearInterval(liveView.timer);
  if(liveView.ws){ try{ liveView.ws.close(); }catch(e){} }
  liveView.box.remove(); liveView=null;
}
function liveShow(text,startBtn){
  const v=liveView; if(!v)return;
  v.msg.textContent=text||''; v.msg.hidden=!text; v.img.hidden=!!text;
  if(startBtn){
    const b=el('button','btn-accent','Start it now');
    b.addEventListener('click',async function(){ b.disabled=true; b.textContent='Starting…';
      if(v.relay)liveRelay.start(); else await window.desktop.liveStart(v.src||undefined); livePoll(); });
    v.msg.appendChild(document.createElement('br')); v.msg.appendChild(b);
  }
}

// every 2 s: which tabs are open. A tab that wasn't there before = the agent opened it: follow it
// (unless he's been using the view in the last few seconds)
async function livePoll(){
  const v=liveView; if(!v)return;
  // the mini PC's browser comes through Supabase when the mini PC runs the local model itself (live-relay.js)
  v.relay=v.src==='lupa'&&typeof liveRelay!=='undefined'&&await liveRelay.watching().catch(function(){ return false; });
  let r; try{ r=v.relay?liveRelay.pages():await window.desktop.livePages(v.src?undefined:v.forId||undefined,v.src||undefined); }catch(e){ r={up:false,pages:[]}; }
  if(liveView!==v)return;
  // its task finished: the card went (checked after the wait: a card being drawn isn't on the page yet)
  if(!v.big&&!v.box.isConnected){ closeLiveView(); return; }
  // in a card: only once the browser has a real page up (a run that only searches never shows it)
  if(!v.big&&v.src!=='lupa')v.box.hidden=!r.up||!r.pages.some(function(p){ return p.url&&!/^(about:|chrome:|devtools:)/.test(p.url); });
  // down: forget the page too, so the next poll that finds it up connects again
  if(!r.up&&v.src==='lupa'){ v.dot.className='live-dot'; v.where.textContent='Can’t reach the local model’s browser'; v.tabs.hidden=true; if(v.ws){ try{ v.ws.onclose=null; v.ws.close(); }catch(e){} } v.ws=null; v.page=null;
    if(v.relay&&r.connecting)liveShow('Connecting to the mini PC…');
    else if(v.relay&&r.quiet)liveShow('The mini PC isn’t answering. Is it on and online, with Romulus running?');
    else if(v.relay)liveShow('The mini PC’s browser isn’t running.',true);
    else liveShow('Can’t open the mini PC’s browser from here. It needs a direct line to the mini PC (SSH), or Romulus on the mini PC taking local tasks.',true);
    return; }
  if(!r.up){ v.dot.className='live-dot'; v.where.textContent='Agent browser isn’t open'; v.tabs.hidden=true; if(v.ws){ try{ v.ws.onclose=null; v.ws.close(); }catch(e){} } v.ws=null; v.page=null;
    liveShow('The Agent’s browser isn’t running. It starts by itself when the Agent needs the web.',true); return; }
  const first=Object.keys(v.seen).length===0;
  const fresh=r.pages.filter(function(p){ return !v.seen[p.id]; });
  r.pages.forEach(function(p){ v.seen[p.id]=true; });
  v.pages=r.pages;
  v.tabs.innerHTML='';
  r.pages.forEach(function(p){ const o=el('option',null,(p.title||p.url||'New tab').slice(0,60)); o.value=p.id; v.tabs.appendChild(o); });
  v.tabs.hidden=r.pages.length<2;
  if(!r.pages.length){ liveShow(v.forId?'This task has no pages open in the browser yet.':'No tabs open in the agent browser.'); return; }
  // the tab Watch opened for a task: straight to it, once it's listed
  const want=v.want&&r.pages.find(function(p){ return p.id===v.want; });
  if(want){ v.want=null; liveConnect(want,true); return; }
  const cur=v.page&&r.pages.find(function(p){ return p.id===v.page.id; });
  if(cur){ v.page.title=cur.title; v.page.url=cur.url; liveWhere(); }
  const follow=!first&&fresh.length&&Date.now()-v.touchedAt>5000;
  if(!cur||follow)liveConnect(follow?fresh[fresh.length-1]:r.pages[0],follow);
  else if(!v.ws)liveConnect(cur,false); // its socket dropped ("trying again"): back on
  else v.tabs.value=v.page.id;
}
function liveWhere(){
  const v=liveView; if(!v||!v.page)return;
  let host=''; try{ host=new URL(v.page.url).host; }catch(e){}
  v.where.textContent=(v.page.title||'Untitled')+(host?' · '+host:'');
  v.where.title=v.page.url;
}

function liveConnect(page,front){
  const v=liveView; if(!v)return;
  if(v.ws){ try{ v.ws.onclose=null; v.ws.close(); }catch(e){} }
  v.page=page; v.meta=null; v.tabs.value=page.id; liveWhere();
  liveShow('Connecting…');
  const ws=String(page.ws).indexOf('relay:')===0?liveRelay.socket(page):new WebSocket(page.ws); v.ws=ws;
  ws.onopen=function(){
    if(front)liveSend('Page.bringToFront'); // a tab in the back doesn't draw
    liveSend('Page.enable');
    liveSend('Page.startScreencast',{format:'jpeg',quality:70,maxWidth:1600,maxHeight:1600,everyNthFrame:1});
    v.dot.className='live-dot on';
  };
  ws.onmessage=function(ev){
    let m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
    if(m.method==='Page.screencastFrame'){
      liveSend('Page.screencastFrameAck',{sessionId:m.params.sessionId});
      v.meta=m.params.metadata; v.img.src='data:image/jpeg;base64,'+m.params.data;
      if(!v.msg.hidden)liveShow('');
    } else if(m.method==='Page.frameNavigated'&&m.params.frame&&!m.params.frame.parentId){ v.page.url=m.params.frame.url; liveWhere(); }
  };
  ws.onclose=function(){ if(liveView&&liveView.ws===ws){ v.ws=null; v.dot.className='live-dot'; liveShow('Lost the connection: trying again…'); } };
}
function liveSend(method,params){
  const v=liveView; if(!v||!v.ws||v.ws.readyState!==1)return;
  v.ws.send(JSON.stringify({id:v.nextId++,method:method,params:params||{}}));
}

// his mouse → the page (picture coordinates scaled to the page's own size)
function liveMods(e){ return (e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0); }
function livePoint(e){
  const v=liveView, r=v.img.getBoundingClientRect(), m=v.meta;
  if(!m||!r.width)return null;
  return {x:(e.clientX-r.left)/r.width*m.deviceWidth, y:(e.clientY-r.top)/r.height*m.deviceHeight};
}
const LIVE_BTN=['left','middle','right'];
function liveMouse(img){
  let down=0, lastMove=0;
  img.addEventListener('contextmenu',function(e){ e.preventDefault(); });
  img.addEventListener('mousedown',function(e){
    const p=livePoint(e); if(!p)return; e.preventDefault(); liveView.keys.focus(); liveView.touchedAt=Date.now(); down|=1<<e.button;
    liveSend('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:LIVE_BTN[e.button]||'left',buttons:down,clickCount:e.detail||1,modifiers:liveMods(e)});
  });
  img.addEventListener('mouseup',function(e){
    const p=livePoint(e); if(!p)return; down&=~(1<<e.button);
    liveSend('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:LIVE_BTN[e.button]||'left',buttons:down,clickCount:e.detail||1,modifiers:liveMods(e)});
  });
  img.addEventListener('mousemove',function(e){
    const now=Date.now(); if(now-lastMove<40&&!down)return; lastMove=now; // hover: a few a second is plenty
    const p=livePoint(e); if(!p)return;
    liveSend('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y,buttons:down,button:down?'left':'none',modifiers:liveMods(e)});
  });
  img.addEventListener('wheel',function(e){
    const p=livePoint(e); if(!p)return; e.preventDefault(); liveView.touchedAt=Date.now();
    const k=e.deltaMode===1?40:e.deltaMode===2?600:1;
    liveSend('Input.dispatchMouseEvent',{type:'mouseWheel',x:p.x,y:p.y,deltaX:e.deltaX*k,deltaY:e.deltaY*k,modifiers:liveMods(e)});
  },{passive:false});
}
// his keys → the page. Escape (with nothing held) closes the view instead
function liveKey(e){
  if(!liveView)return;
  if(e.type==='keydown'&&e.key==='Escape'&&!liveMods(e)){ e.preventDefault(); if(!liveView.big)liveView.keys.blur(); else if(liveView.host&&liveView.host.isConnected)liveBig(false); else closeLiveView(); return; }
  if(e.target.closest&&e.target.closest('.live-bar'))return; // the tab picker and buttons keep their keys
  if(e.ctrlKey&&!e.altKey&&(e.key==='v'||e.key==='V'))return; // paste: the paste event sends the text
  if(e.isComposing||e.key==='Process'||e.key==='Unidentified')return; // IME: the text arrives as input
  e.preventDefault(); e.stopPropagation(); liveView.touchedAt=Date.now();
  const printable=e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey;
  const base={key:e.key,code:e.code,windowsVirtualKeyCode:e.keyCode,nativeVirtualKeyCode:e.keyCode,modifiers:liveMods(e),autoRepeat:e.repeat};
  if(e.type==='keyup')liveSend('Input.dispatchKeyEvent',Object.assign({type:'keyUp'},base));
  else if(printable)liveSend('Input.dispatchKeyEvent',Object.assign({type:'keyDown',text:e.key,unmodifiedText:e.key},base));
  else liveSend('Input.dispatchKeyEvent',Object.assign({type:'rawKeyDown'},base,e.key==='Enter'?{text:'\r'}:{}));
}
