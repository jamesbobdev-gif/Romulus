/* The daily swipe: today or tomorrow for each task.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── daily swipe: once a day, decide today (right) or tomorrow (left) for each task ──
   The decision lives on the task (plan = the day it's for, planSet = the day you decided),
   so it syncs: finish the deck on the phone and the desktop has nothing left to ask.
   It never touches the real due date (school deadlines stay put). */
const SWIPE_DAY_KEY='tasks.swipeDay';
function dayStr(offset){ const d=new Date(); d.setDate(d.getDate()+(offset||0)); return formatDate(d); }
function swipeEligible(t){
  if(t.done||!inTab(t,'list'))return false;
  const today=dayStr(0);
  if(t.planSet===today)return false;          // already decided today
  if(t.created&&formatDate(new Date(t.created))===today)return false; // added today: it's simply today's, nothing to decide
  // overdue or due today, plus what you swiped to "tomorrow" yesterday
  return (t.due&&t.due<=today)||t.plan===today;
}
function swipeDeck(){
  const today=dayStr(0);
  // overdue first (oldest on top), then due today, then the ones pushed over from yesterday
  const rank=function(t){ return (t.due&&t.due<today)?0:(t.due===today?1:2); };
  return state.tasks.filter(swipeEligible).sort(function(a,b){
    return rank(a)-rank(b)||String(a.due||'9999').localeCompare(String(b.due||'9999'))||String(a.dueTime||'99:99').localeCompare(String(b.dueTime||'99:99'))||(a.created||0)-(b.created||0);
  });
}
var swipe={ open:false, deck:[], i:0, history:[], counts:{today:0,tmrw:0,done:0} };
// a background sync swaps task objects, so always act on the live copy
function liveTask(t){ return state.tasks.find(function(x){ return x.id===t.id; })||t; }
function updatePlanBtn(){
  if(!swipe)return;
  const n=swipe.open?0:swipeDeck().length, b=$('planBtn');
  b.hidden=!n; b.textContent='Plan today · '+n;
}
function openSwipe(){
  swipe.deck=swipeDeck(); swipe.i=0; swipe.history=[]; swipe.counts={today:0,tmrw:0,done:0};
  if(!swipe.deck.length)return;
  swipe.open=true;
  let ov=$('swipeOverlay');
  if(!ov){ ov=el('div','swipe'); ov.id='swipeOverlay'; ov.setAttribute('role','dialog'); ov.setAttribute('aria-label','Plan your day'); document.body.appendChild(ov); }
  ov.hidden=false; document.body.style.overflow='hidden';
  renderSwipe(); updatePlanBtn();
}
function closeSwipe(){
  swipe.open=false;
  try{ localStorage.setItem(SWIPE_DAY_KEY,dayStr(0)); }catch(e){}
  const ov=$('swipeOverlay'); if(ov)ov.hidden=true;
  document.body.style.overflow='';
  renderActive(); updatePlanBtn();
}
// auto-open the first time the app is opened (or brought back) on a new day
var swipeReady=false; // set a few seconds after load, once the first sync has had a chance
function maybeShowSwipe(){
  if(!swipeReady||swipe.open||document.hidden)return;
  let last=null; try{ last=localStorage.getItem(SWIPE_DAY_KEY); }catch(e){}
  if(last===dayStr(0)){ updatePlanBtn(); return; }
  if(swipeDeck().length)openSwipe(); else { try{ localStorage.setItem(SWIPE_DAY_KEY,dayStr(0)); }catch(e){} updatePlanBtn(); }
}
// phone haptics (Capacitor Haptics plugin); a no-op on desktop
function buzz(kind){
  // no JS bundler in the phone app, so call the native plugin through the bridge directly
  const cap=window.Capacitor;
  if(!cap||typeof cap.nativePromise!=='function')return;
  const call=function(method,opts){ try{ const p=cap.nativePromise('Haptics',method,opts||{}); if(p&&p.catch)p.catch(function(){}); }catch(e){} };
  const H={ impact:function(o){ call('impact',o); }, notification:function(o){ call('notification',o); }, selectionChanged:function(){ call('selectionStart'); call('selectionChanged'); call('selectionEnd'); } };
  const later=function(ms,f){ setTimeout(function(){ try{ f(); }catch(e){} },ms); };
  try{
    if(kind==='tick')H.impact({style:'LIGHT'});                                   // crossed the "let go to decide" line
    else if(kind==='today'){ H.impact({style:'HEAVY'}); later(70,function(){ H.impact({style:'LIGHT'}); }); } // thump + echo
    else if(kind==='tmrw')H.impact({style:'MEDIUM'});
    else if(kind==='shake'){ H.impact({style:'HEAVY'}); later(85,function(){ H.impact({style:'MEDIUM'}); }); later(170,function(){ H.impact({style:'MEDIUM'}); }); later(255,function(){ H.impact({style:'LIGHT'}); }); } // rattles with the shake
    else if(kind==='complete')H.notification({type:'SUCCESS'});                   // swiped up: finished
    else if(kind==='undo'){ H.impact({style:'LIGHT'}); later(90,function(){ H.impact({style:'LIGHT'}); }); }
    else if(kind==='done'){ H.notification({type:'SUCCESS'}); later(260,function(){ H.impact({style:'HEAVY'}); }); }
    else if(kind==='snap')H.selectionChanged();                                   // card snapped back
    // the few moments that matter: finished, added, deleted, sent to Claude, Claude answered, mic on
    else if(kind==='check'){ H.notification({type:'SUCCESS'}); }                   // ticked a task off
    else if(kind==='add')H.impact({style:'MEDIUM'});                              // new task
    else if(kind==='tap')H.impact({style:'LIGHT'});                               // mic on
    else if(kind==='delete')H.notification({type:'WARNING'});
    else if(kind==='send'){ H.impact({style:'MEDIUM'}); later(90,function(){ H.impact({style:'LIGHT'}); }); } // to Claude
    else if(kind==='answer'){ H.impact({style:'LIGHT'}); later(140,function(){ H.impact({style:'LIGHT'}); }); } // Claude replied
  }catch(e){}
}
function decide(dir){
  if(!swipe.deck[swipe.i])return;
  const t=liveTask(swipe.deck[swipe.i]);
  swipe.history.push({t:t,dir:dir,plan:t.plan||null,planSet:t.planSet||null});
  if(dir==='done')setDone(t,true); // swiped up: finished, the plan stays as it was
  else { t.plan=dir==='today'?dayStr(0):dayStr(1); t.planSet=dayStr(0); }
  swipe.counts[dir]++; swipe.i++;
  if(swipe.i>=swipe.deck.length)setTimeout(function(){ buzz('done'); },180); // deck cleared
  persist(); renderSwipe();
}
function undoSwipe(){
  const h=swipe.history.pop(); if(!h)return;
  buzz('undo');
  const t=liveTask(h.t);
  if(h.dir==='done')setDone(t,false);
  if(h.plan)t.plan=h.plan; else delete t.plan;
  if(h.planSet)t.planSet=h.planSet; else delete t.planSet;
  swipe.counts[h.dir]--; swipe.i--;
  persist(); renderSwipe(h.dir); // card flies back in from the side it left
}
function cardFor(t){
  const c=el('div','swipe-card');
  c.appendChild(el('div','swipe-stamp today','Today'));
  c.appendChild(el('div','swipe-stamp tmrw','Tomorrow'));
  c.appendChild(el('div','swipe-stamp done','Done'));
  c.appendChild(el('div','sc-title',t.title));
  const meta=el('div','sc-meta');
  if(t.due){ const info=dateInfo(t.due,t.dueTime); meta.appendChild(el('span','chip date'+(info.cls?' '+info.cls:''),info.text)); }
  else meta.appendChild(el('span','chip date','no date'));
  const ws=taskWs(t); if(ws==='work'||ws==='school')meta.appendChild(el('span','chip '+(ws==='work'?'ws':'school'),ws));
  if(t.tag)meta.appendChild(el('span','chip tag',t.tag));
  c.appendChild(meta);
  const openSubs=(t.subs||[]).filter(function(s){ return !s.done; });
  if(openSubs.length)c.appendChild(el('div','sc-subs',openSubs.slice(0,4).map(function(s){ return '○ '+s.title; }).join('\n')+(openSubs.length>4?'\n+'+(openSubs.length-4)+' more':'')));
  const today0=dayStr(0);
  if(t.due&&t.due<today0){ const d=dateInfo(t.due).diff; c.appendChild(el('div','mono sc-why','Overdue by '+(-d)+' day'+(-d===1?'':'s'))); }
  else if(t.plan===today0&&t.due!==today0)c.appendChild(el('div','mono sc-why','You pushed this to today'));
  c.querySelector('.sc-subs')&&(c.querySelector('.sc-subs').style.whiteSpace='pre-line');
  return c;
}
function renderSwipe(returnFrom){
  const ov=$('swipeOverlay'); ov.innerHTML='';
  const total=swipe.deck.length, left=total-swipe.i;
  const top=el('div','swipe-top');
  top.appendChild(el('h2',null,'Plan your day'));
  const x=el('button','swipe-close',left?'Later':'Close'); x.addEventListener('click',closeSwipe); top.appendChild(x);
  ov.appendChild(top);
  ov.appendChild(el('div','mono swipe-sub',left?(swipe.i+1)+' of '+total+' · right = today, left = tomorrow, up = done':'All '+total+' sorted'));
  const stage=el('div','swipe-stage'); ov.appendChild(stage);

  const acts=el('div','swipe-actions');
  const bL=el('button','go-tmrw','← Tomorrow'), bU=el('button','undo','Undo'), bR=el('button','go-today','Today →');
  bU.disabled=!swipe.history.length; bL.disabled=bR.disabled=!left;
  acts.appendChild(bL); acts.appendChild(bU); acts.appendChild(bR);
  ov.appendChild(acts);
  if(!window.Capacitor)ov.appendChild(el('div','mono swipe-hint','← / → keys to sort · ↑ for done · Z to undo'));
  bU.addEventListener('click',undoSwipe);

  if(!left){
    const d=el('div','swipe-done');
    d.appendChild(el('div','big','Day planned'));
    d.appendChild(el('div','mono',swipe.counts.today+' for today · '+swipe.counts.tmrw+' for tomorrow'+(swipe.counts.done?' · '+swipe.counts.done+' done':'')));
    const ok=el('button','btn-accent','Done'); ok.addEventListener('click',closeSwipe); d.appendChild(ok);
    stage.appendChild(d);
    return;
  }
  // the next card peeks out behind the current one
  if(swipe.deck[swipe.i+1]){ const b=cardFor(liveTask(swipe.deck[swipe.i+1])); b.classList.add('back'); stage.appendChild(b); }
  const card=cardFor(liveTask(swipe.deck[swipe.i])); stage.appendChild(card);
  const stT=card.querySelector('.swipe-stamp.today'), stM=card.querySelector('.swipe-stamp.tmrw'), stD=card.querySelector('.swipe-stamp.done');

  const fly=function(dir){
    if(card.dataset.gone)return; card.dataset.gone='1';
    if(dir==='done'){ // shake where it was let go, then off the top
      const m=/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(card.style.transform)||[0,0,0];
      const x0=+m[1], y0=+m[2];
      stT.style.opacity=0; stM.style.opacity=0; stD.style.opacity=1;
      card.style.setProperty('--sx',x0+'px'); card.style.setProperty('--sy',y0+'px');
      card.style.transform='translate('+x0+'px,'+y0+'px)';
      buzz('shake');
      const finish=function(){
        card.classList.remove('shake'); buzz('complete');
        card.classList.add('anim');
        card.style.transform='translate('+x0+'px,'+(-(stage.clientHeight+window.innerHeight*0.6))+'px) rotate('+(x0/20)+'deg)';
        card.style.opacity='0';
        setTimeout(function(){ decide('done'); },240);
      };
      if(prefersReduced)finish(); else { card.classList.add('shake'); setTimeout(finish,340); }
      return;
    }
    buzz(dir);
    const w=stage.clientWidth+200;
    card.classList.add('anim');
    card.style.transform='translateX('+(dir==='today'?w:-w)+'px) rotate('+(dir==='today'?18:-18)+'deg)';
    card.style.opacity='0';
    setTimeout(function(){ decide(dir); },220);
  };
  bR.addEventListener('click',function(){ fly('today'); });
  bL.addEventListener('click',function(){ fly('tmrw'); });
  swipe.fly=fly;

  if(returnFrom){ // undo: slide back in from where it went
    card.style.transform=returnFrom==='done'?'translateY('+(-(stage.clientHeight+window.innerHeight*0.6))+'px)':'translateX('+(returnFrom==='today'?1:-1)*(stage.clientWidth+200)+'px)';
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ card.classList.add('anim'); card.style.transform=''; setTimeout(function(){ card.classList.remove('anim'); },300); }); });
  }

  let sx=0, sy=0, dx=0, dy=0, dragging=false, t0=0, armed=0; // armed: -1/0/1/2 = past the left/no/right/top line
  const up=function(){ return -dy>Math.abs(dx); }; // heading up more than sideways
  card.addEventListener('pointerdown',function(e){
    if(card.dataset.gone)return;
    dragging=true; sx=e.clientX; sy=e.clientY; dx=0; dy=0; t0=Date.now(); armed=0;
    card.classList.remove('anim'); try{ card.setPointerCapture(e.pointerId); }catch(err){}
  });
  card.addEventListener('pointermove',function(e){
    if(!dragging)return;
    dx=e.clientX-sx; dy=e.clientY-sy;
    const ty=up()?dy:dy*.25; // follows the finger upward; down and sideways stay damped
    card.style.transform='translate('+dx+'px,'+ty+'px) rotate('+(dx/18)+'deg)';
    const p=Math.min(1,Math.abs(dx)/110), pu=up()?Math.min(1,-dy/110):0;
    stT.style.opacity=!up()&&dx>0?p:0; stM.style.opacity=!up()&&dx<0?p:0; stD.style.opacity=pu;
    const nowArmed=up()&&-dy>110?2:up()?0:dx>110?1:dx<-110?-1:0;
    if(nowArmed!==armed){ if(nowArmed)buzz('tick'); armed=nowArmed; }
  });
  const end=function(){
    if(!dragging)return; dragging=false;
    const ms=Math.max(1,Date.now()-t0);
    if(up()){
      if(-dy>110||(-dy/ms>0.6&&-dy>40)){ fly('done'); return; }
    } else {
      const fast=Math.abs(dx)/ms>0.6&&Math.abs(dx)>40;
      if(Math.abs(dx)>110||fast){ fly(dx>0?'today':'tmrw'); return; }
    }
    if(Math.abs(dx)>30||-dy>30)buzz('snap');
    card.classList.add('anim'); card.style.transform=''; stT.style.opacity=0; stM.style.opacity=0; stD.style.opacity=0;
  };
  card.addEventListener('pointerup',end); card.addEventListener('pointercancel',end);
}
document.addEventListener('keydown',function(e){
  if(!swipe.open)return;
  if(e.key==='ArrowRight'&&swipe.fly&&swipe.i<swipe.deck.length){ e.preventDefault(); e.stopImmediatePropagation(); swipe.fly('today'); }
  else if(e.key==='ArrowLeft'&&swipe.fly&&swipe.i<swipe.deck.length){ e.preventDefault(); e.stopImmediatePropagation(); swipe.fly('tmrw'); }
  else if(e.key==='ArrowUp'&&swipe.fly&&swipe.i<swipe.deck.length){ e.preventDefault(); e.stopImmediatePropagation(); swipe.fly('done'); }
  else if((e.key==='z'||e.key==='Z')&&!e.altKey){ e.preventDefault(); e.stopImmediatePropagation(); undoSwipe(); }
  else if(e.key==='Escape'){ e.preventDefault(); e.stopImmediatePropagation(); closeSwipe(); }
  else e.stopImmediatePropagation(); // list shortcuts (Delete, Space…) stay off while the deck is up
},true);
$('planBtn').addEventListener('click',openSwipe);
document.addEventListener('visibilitychange',function(){ if(!document.hidden)maybeShowSwipe(); });
window.addEventListener('focus',maybeShowSwipe);
