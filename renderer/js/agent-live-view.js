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

// a working task's card: the live view goes in its slot (one view at a time: the task that has it keeps it)
function liveEmbed(slot,id){
  if(liveHidden[id]){
    const b=el('button','btn-ghost agent-watch','◉ Show the browser');
    b.addEventListener('click',function(e){ e.stopPropagation(); delete liveHidden[id]; render(); });
    slot.appendChild(b); return;
  }
  if(liveView&&liveView.forId&&liveView.forId!==id&&(liveView.big||state.tasks.some(function(t){ return t.id===liveView.forId&&t.status==='working'; })))return;
  openLiveView(slot,id);
}
function openLiveView(host,forId,want){
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
  box.appendChild(el('div','live-hint','Click, scroll and type here to use it yourself. Romulus keeps going when you’re done.'));
  // what has keyboard focus: a hidden box, so text that comes without key presses (emoji picker,
  // voice typing, IME) arrives as input and is typed into the page too
  const keys=el('textarea','live-keys'); keys.setAttribute('aria-label','Type into the agent browser'); keys.tabIndex=-1; box.appendChild(keys);
  (host||document.body).appendChild(box);
  liveView={box:box,keys:keys,img:img,msg:msg,where:where,tabs:tabs,dot:dot,bigBtn:big,ws:null,page:null,pages:[],meta:null,nextId:1,timer:null,touchedAt:0,seen:{},want:want||null,
    host:host||null,forId:forId||null,big:!host};
  if(host)box.hidden=true; // until the browser shows a real page

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
    b.addEventListener('click',async function(){ b.disabled=true; b.textContent='Starting…'; await window.desktop.liveStart(); livePoll(); });
    v.msg.appendChild(document.createElement('br')); v.msg.appendChild(b);
  }
}

// every 2 s: which tabs are open. A tab that wasn't there before = the agent opened it: follow it
// (unless he's been using the view in the last few seconds)
async function livePoll(){
  const v=liveView; if(!v)return;
  let r; try{ r=await window.desktop.livePages(v.forId||undefined); }catch(e){ r={up:false,pages:[]}; }
  if(liveView!==v)return;
  // its task finished: the card went (checked after the wait: a card being drawn isn't on the page yet)
  if(!v.big&&!v.box.isConnected){ closeLiveView(); return; }
  // in a card: only once the browser has a real page up (a run that only searches never shows it)
  if(!v.big)v.box.hidden=!r.up||!r.pages.some(function(p){ return p.url&&!/^(about:|chrome:|devtools:)/.test(p.url); });
  if(!r.up){ v.dot.className='live-dot'; v.where.textContent='Agent browser isn’t open'; v.tabs.hidden=true; if(v.ws){ try{ v.ws.close(); }catch(e){} v.ws=null; v.page=null; }
    liveShow('Romulus’s browser isn’t running. It starts by itself when Romulus needs the web.',true); return; }
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
  const ws=new WebSocket(page.ws); v.ws=ws;
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
