/* Popups: the day detail and the enlarged option photo.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── day detail popup ── */
function dayPopKey(e){ if(e.key==='Escape'){ e.stopPropagation(); closeDayPop(); } }
/* ── enlarged option photo: click a card's photo; ← → flip through the options, Esc/click closes ── */
let lbZoomed=false, lbZoomApi=null; // current photo's zoom state / controls
function lightboxKey(e){
  if(e.key==='Escape'){ e.stopPropagation(); if(lbZoomed&&lbZoomApi)lbZoomApi.reset(); else closeLightbox(); }
  else if((e.key==='+'||e.key==='=')&&lbZoomApi){ e.preventDefault(); e.stopPropagation(); lbZoomApi.step(1.5); }
  else if((e.key==='-'||e.key==='_')&&lbZoomApi){ e.preventDefault(); e.stopPropagation(); lbZoomApi.step(1/1.5); }
  else if(e.key==='0'&&lbZoomApi){ e.preventDefault(); e.stopPropagation(); lbZoomApi.reset(); }
  else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){ e.preventDefault(); e.stopPropagation(); const b=document.querySelector(e.key==='ArrowLeft'?'.lb-prev':'.lb-next'); if(b)b.click(); }
}
// Zoom a photo inside its frame: wheel/pinch zoom around the pointer, click/tap toggles 2.5x at
// that spot, drag pans; the photo always stays covering the frame so you can't lose it.
function makeZoomable(stage,img){
  const MAX=6, TAP_ZOOM=2.5;
  let sc=1, tx=0, ty=0;
  const pts=new Map(); let lastDist=0, moved=false, downAt=null;
  lbZoomed=false;
  function clamp(){
    const w=stage.clientWidth, h=stage.clientHeight;
    tx=Math.min(0,Math.max(w-w*sc,tx)); ty=Math.min(0,Math.max(h-h*sc,ty));
  }
  function apply(){
    if(sc<=1.001){ sc=1; tx=0; ty=0; }
    clamp();
    img.style.transform='translate('+tx+'px,'+ty+'px) scale('+sc+')';
    lbZoomed=sc>1;
    stage.classList.toggle('zoomed',lbZoomed);
  }
  function zoomAt(ns,cx,cy){ // cx,cy: point in the frame that should stay put
    ns=Math.min(MAX,Math.max(1,ns));
    tx=cx-(cx-tx)*(ns/sc); ty=cy-(cy-ty)*(ns/sc); sc=ns; apply();
  }
  function local(e){ const r=stage.getBoundingClientRect(); return [e.clientX-r.left,e.clientY-r.top]; }
  stage.addEventListener('wheel',function(e){
    e.preventDefault(); e.stopPropagation();
    const p=local(e); zoomAt(sc*Math.exp(-e.deltaY*0.0018),p[0],p[1]);
  },{passive:false});
  stage.addEventListener('pointerdown',function(e){
    try{ stage.setPointerCapture(e.pointerId); }catch(_e){} // keep the drag even if the pointer leaves the photo
    pts.set(e.pointerId,[e.clientX,e.clientY]); moved=false; downAt=[e.clientX,e.clientY];
    if(pts.size===2){ const a=[...pts.values()]; lastDist=Math.hypot(a[0][0]-a[1][0],a[0][1]-a[1][1]); }
  });
  stage.addEventListener('pointermove',function(e){
    if(!pts.has(e.pointerId))return;
    const prev=pts.get(e.pointerId); pts.set(e.pointerId,[e.clientX,e.clientY]);
    if(downAt&&Math.hypot(e.clientX-downAt[0],e.clientY-downAt[1])>6)moved=true;
    if(pts.size===2){ // pinch
      const a=[...pts.values()], d=Math.hypot(a[0][0]-a[1][0],a[0][1]-a[1][1]);
      const r=stage.getBoundingClientRect(), mx=(a[0][0]+a[1][0])/2-r.left, my=(a[0][1]+a[1][1])/2-r.top;
      if(lastDist)zoomAt(sc*d/lastDist,mx,my); lastDist=d; moved=true;
    } else if(sc>1){ // pan
      tx+=e.clientX-prev[0]; ty+=e.clientY-prev[1]; apply(); stage.classList.add('dragging');
    }
  });
  function up(e){ pts.delete(e.pointerId); if(pts.size<2)lastDist=0; if(!pts.size)stage.classList.remove('dragging'); }
  stage.addEventListener('pointerup',up); stage.addEventListener('pointercancel',up);
  stage.addEventListener('click',function(e){
    e.stopPropagation(); // never close the viewer from a click on the photo
    if(moved){ moved=false; return; } // that was a drag or pinch, not a click
    const p=local(e);
    if(sc>1){ sc=1; apply(); } else zoomAt(TAP_ZOOM,p[0],p[1]);
  });
  stage.addEventListener('touchstart',function(e){ if(lbZoomed||e.touches.length>1)e.stopPropagation(); },{passive:true});
  lbZoomApi={
    reset:function(){ sc=1; apply(); },
    step:function(f){ zoomAt(sc*f,stage.clientWidth/2,stage.clientHeight/2); }
  };
  apply();
}
function closeLightbox(){
  lbZoomed=false; lbZoomApi=null;
  const n=document.getElementById('lightbox'); if(n)n.remove();
  document.removeEventListener('keydown',lightboxKey,true);
}
function openLightbox(opts,startIdx){
  closeLightbox();
  const pics=opts.map(function(o,i){ return {o:o,i:i}; }).filter(function(x){ return x.o.image&&/^https:\/\//i.test(String(x.o.image)); });
  if(!pics.length)return;
  let pos=Math.max(0,pics.findIndex(function(x){ return x.i===startIdx; }));
  const box=el('div','lightbox'); box.id='lightbox';
  box.setAttribute('role','dialog'); box.setAttribute('aria-modal','true');
  function show(){
    box.innerHTML='';
    const o=pics[pos].o, label=String(o.label||('Option '+(pics[pos].i+1)));
    const big=document.createElement('img');
    big.src=String(o.image).replace(/\._AC_SL\d+_\./,'._AC_SL1500_.'); // sharper copy of the same Amazon photo
    big.alt=label; big.referrerPolicy='no-referrer'; big.draggable=false;
    big.addEventListener('error',function(){ if(big.src!==o.image)big.src=o.image; }); // fall back to the card-size photo
    const stage=el('div','lb-stage'); stage.appendChild(big);
    makeZoomable(stage,big);
    const cap=el('div','lb-cap'); cap.addEventListener('click',function(e){ e.stopPropagation(); });
    cap.appendChild(el('div','t',(pics[pos].i+1)+'. '+label));
    if(o.desc)cap.appendChild(el('div','d',String(o.desc)));
    const metaBits=[o.price,o.rating].filter(Boolean);
    if(metaBits.length)cap.appendChild(el('div','m',metaBits.join(' · ')));
    if(o.url){ const ob=el('button','lb-open','Open on '+siteName(o.url)+' ↗'); ob.addEventListener('click',function(){ openExternal(String(o.url)); }); cap.appendChild(ob);
      const sb=el('button','lb-open lb-share','Share link'); sb.addEventListener('click',function(){ shareLink(o.url,sb); }); cap.appendChild(sb); }
    if(pics.length>1)cap.appendChild(el('div','c',(pos+1)+' of '+pics.length));
    const x=el('button','lb-close','✕'); x.setAttribute('aria-label','Close'); x.addEventListener('click',function(e){ e.stopPropagation(); closeLightbox(); });
    box.appendChild(x); box.appendChild(stage); box.appendChild(el('div','lb-hint',window.matchMedia('(hover:none)').matches?'Pinch or tap to zoom':'Scroll or click to zoom \u00B7 drag to look around')); box.appendChild(cap);
    if(pics.length>1){
      const prev=el('button','lb-nav lb-prev','‹'), next=el('button','lb-nav lb-next','›');
      prev.setAttribute('aria-label','Previous option'); next.setAttribute('aria-label','Next option');
      prev.addEventListener('click',function(e){ e.stopPropagation(); pos=(pos-1+pics.length)%pics.length; show(); });
      next.addEventListener('click',function(e){ e.stopPropagation(); pos=(pos+1)%pics.length; show(); });
      box.appendChild(prev); box.appendChild(next);
    }
  }
  box.addEventListener('click',closeLightbox); // click the dark area to close
  // swipe on phones
  let sx=null;
  box.addEventListener('touchstart',function(e){ sx=e.touches[0].clientX; },{passive:true});
  box.addEventListener('touchend',function(e){ if(sx===null||pics.length<2||lbZoomed)return; const dx=e.changedTouches[0].clientX-sx; sx=null; if(Math.abs(dx)>50){ pos=(pos+(dx<0?1:-1)+pics.length)%pics.length; show(); } });
  show();
  document.addEventListener('keydown',lightboxKey,true);
  document.body.appendChild(box);
}
function closeDayPop(){
  const n=document.getElementById('dayPop'); if(n)n.remove();
  document.removeEventListener('keydown',dayPopKey);
}
function openDayPop(ds){
  closeDayPop();
  const backdrop=el('div','day-pop-backdrop'); backdrop.id='dayPop';
  const card=el('div','day-pop');
  const p=ds.split('-').map(Number);
  card.appendChild(el('h3',null,new Date(p[0],p[1]-1,p[2]).toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})));
  const listWrap=el('div');
  function fill(){
    listWrap.innerHTML='';
    const dayTasks=state.tasks.filter(function(t){ return t.due===ds; })
      .sort(function(a,b){ return Number(a.done)-Number(b.done)||getSortKey(a)-getSortKey(b); });
    if(!dayTasks.length){ closeDayPop(); return; }
    dayTasks.forEach(function(t){
      const row=el('div','day-pop-row'+(t.done?' done':''));
      const c=el('button','check'+(t.done?' on':'')); c.innerHTML=I.check;
      c.setAttribute('aria-label',t.done?'Mark as not done':'Mark as done');
      c.addEventListener('click',function(){ setDone(t,!t.done); touch(); fill(); });
      const title=el('span','day-pop-title',t.title);
      title.title='Open in list';
      title.addEventListener('click',function(){ closeDayPop(); openTaskById(t.id); });
      row.appendChild(c); row.appendChild(title);
      if(t.dueTime)row.appendChild(el('span','chip date',fmtTime(t.dueTime)));
      if(t.tag)row.appendChild(el('span','chip tag',t.tag));
      listWrap.appendChild(row);
    });
  }
  fill();
  card.appendChild(listWrap);
  backdrop.appendChild(card);
  backdrop.addEventListener('click',function(e){ if(e.target===backdrop)closeDayPop(); });
  document.addEventListener('keydown',dayPopKey);
  document.body.appendChild(backdrop);
}

function renderCal(){
  const y=state.calYear, m=state.calMonth;
  $('calMonthLabel').textContent=new Date(y,m,1).toLocaleDateString('en-US',{month:'long',year:'numeric'});
  const nowD=new Date();
  $('calToday').hidden=(y===nowD.getFullYear()&&m===nowD.getMonth());
  const grid=$('calGrid');
  grid.innerHTML='';
  const DOWS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  DOWS.forEach(function(d){ grid.appendChild(el('div','cal-dow',d)); });
  const firstDow=new Date(y,m,1).getDay();
  const lastDate=new Date(y,m+1,0).getDate();
  const todayStr=formatDate(new Date());
  // pad before
  for(let i=firstDow-1;i>=0;i--){ const d=new Date(y,m,-i); grid.appendChild(buildDayCell(d,true,todayStr)); }
  // current month
  for(let d=1;d<=lastDate;d++){ grid.appendChild(buildDayCell(new Date(y,m,d),false,todayStr)); }
  // pad after
  const total=firstDow+lastDate; const needed=Math.ceil(total/7)*7;
  let nd=1; for(let i=total;i<needed;i++){ grid.appendChild(buildDayCell(new Date(y,m+1,nd++),true,todayStr)); }
  // empty state
  const hasAny=state.tasks.some(function(t){ return t.due; });
  $('calEmpty').hidden=hasAny;
}

function buildDayCell(date,otherMonth,todayStr){
  const ds=formatDate(date);
  const isToday=ds===todayStr;
  const cell=el('div','cal-cell'+(otherMonth?' other':'')+(isToday?' today':''));
  const num=el('span','cal-num',String(date.getDate())); cell.appendChild(num);
  if(otherMonth) return cell;
  const dayTasks=state.tasks.filter(function(t){ return t.due===ds; })
    .sort(function(a,b){ return Number(a.done)-Number(b.done); });
  if(dayTasks.length){
    cell.classList.add('has-tasks');
    cell.addEventListener('click',function(){ openDayPop(ds); });
  }
  const MAX=3;
  dayTasks.slice(0,MAX).forEach(function(t){
    const isLate=!t.done&&dateInfo(ds).diff<0;
    const cls='cal-chip'+(t.done?' done':isLate?' late':isToday?' accent':'');
    const label=t.dueTime?fmtTime(t.dueTime)+' '+t.title:t.title;
    const chip=el('div',cls,label);
    chip.title=t.title;
    chip.addEventListener('click',function(e){
      // phones: chips are thin bars, so a tap anywhere in the day opens that day's list (the cell's handler)
      if(window.matchMedia('(max-width:520px)').matches)return;
      e.stopPropagation();
      openTaskById(t.id);
    });
    cell.appendChild(chip);
  });
  if(dayTasks.length>MAX) cell.appendChild(el('span','cal-more','+'+(dayTasks.length-MAX)+' more'));
  return cell;
}
