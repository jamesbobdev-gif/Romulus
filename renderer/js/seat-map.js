/* ── the seat map ──
   When the Agent picks seats on a ticket site (t.seats, from agent/seats.js), the task shows the map the
   way the site does: the screen on top, every row, taken seats grey and its pick in blue. He can tap
   open seats to choose his own instead (seatDrafts, a draft on this device); "Use these seats" sends
   them back as a reply, so the next run selects those and asks for the yes again. */
const seatDrafts={}; // task id → seat names he tapped
// each spot of a row: {name, kind} (kind: o open, x taken, p its pick, a wheelchair, _ a gap); seats count from r.first
function seatSpots(r){
  let n=(r.first||1)-1;
  return String(r.seats||'').split('').map(function(k){ return k==='_'?{kind:'_'}:{kind:k,name:(r.row||'')+(++n)}; });
}
function seatPicks(s){
  const out=[]; (s.rows||[]).forEach(function(r){ seatSpots(r).forEach(function(sp){ if(sp.kind==='p')out.push(sp.name); }); }); return out;
}
function seatMap(t){
  const s=t.seats, box=el('div','seat-box');
  const canPick=t.status==='needs-you'&&!t.done;
  const its=seatPicks(s);
  const mine=function(){ return seatDrafts[t.id]||null; };
  const head=el('div','seat-head'); head.appendChild(el('span',null,'Seats'));
  if(s.where)head.appendChild(el('span','seat-where',s.where));
  box.appendChild(head);
  const wrap=el('div','seat-wrap'); box.appendChild(wrap);
  const grid=el('div','seat-grid'); wrap.appendChild(grid);
  // seats shrink to fit the widest row on a phone (a big venue still scrolls sideways)
  const widest=Math.max.apply(null,s.rows.map(function(r){ return String(r.seats||'').length; }))+2;
  grid.style.setProperty('--seat',Math.max(12,Math.min(20,Math.floor(290/widest)-4))+'px');
  grid.appendChild(el('div','seat-screen',s.screen||'Screen'));
  const btns=[];
  s.rows.forEach(function(r){
    const row=el('div','seat-row');
    row.appendChild(el('span','seat-lab',r.row||''));
    seatSpots(r).forEach(function(sp){
      if(sp.kind==='_'){ row.appendChild(el('span','seat-gap')); return; }
      const b=el('button','seat '+(sp.kind==='x'?'taken':sp.kind==='a'?'acc':'open'));
      b.dataset.name=sp.name; b.title=sp.name+(sp.kind==='x'?' · taken':sp.kind==='a'?' · wheelchair space':'');
      b.setAttribute('aria-label',b.title);
      if(sp.kind==='x'||sp.kind==='a'||!canPick)b.disabled=true;
      else b.addEventListener('click',function(e){
        e.stopPropagation();
        const cur=(mine()||its).slice(), i=cur.indexOf(sp.name);
        if(i===-1)cur.push(sp.name); else cur.splice(i,1);
        seatDrafts[t.id]=cur; buzz('tap'); draw();
      });
      btns.push(b); row.appendChild(b);
    });
    row.appendChild(el('span','seat-lab',r.row||''));
    grid.appendChild(row);
  });
  const foot=el('div','seat-foot'); box.appendChild(foot);
  const info=el('div','seat-info'); foot.appendChild(info);
  const acts=el('div','seat-acts'); foot.appendChild(acts);
  const use=el('button','btn-accent seat-use','Use these seats'); acts.appendChild(use);
  const reset=el('button','cart-all','Back to the Agent’s pick'); acts.appendChild(reset);
  const same=function(a,b){ return a.length===b.length&&a.every(function(x){ return b.indexOf(x)!==-1; }); };
  function draw(){
    const m=mine(), on=m||its;
    btns.forEach(function(b){ b.classList.toggle('pick',on.indexOf(b.dataset.name)!==-1); b.setAttribute('aria-pressed',String(on.indexOf(b.dataset.name)!==-1)); });
    const changed=!!m&&!same(m,its);
    const names=changed?m:(s.picked&&s.picked.length?s.picked:its);
    info.textContent=changed?(m.length?'Your pick: '+m.join(', '):'Tap the seats you want')
      :(names.length?'The Agent picked '+names.join(', '):'Tap the seats you want')+(s.price?' · '+s.price:'');
    acts.hidden=!changed; use.disabled=!m||!m.length;
  }
  use.addEventListener('click',function(e){
    e.stopPropagation();
    const m=mine(); if(!m||!m.length)return;
    const lt=liveTask(t), msg='Use seats '+m.join(', ')+' instead'+(its.length?' of '+its.join(', '):'');
    lt.reply=msg; agentSay(lt,'you',msg); lt.status='queued'; delete seatDrafts[t.id];
    buzz('send'); touch();
  });
  reset.addEventListener('click',function(e){ e.stopPropagation(); delete seatDrafts[t.id]; draw(); });
  if(s.url){ const a=el('a','seat-link','Open the seat page ↗'); a.href=s.url; a.target='_blank'; a.rel='noopener'; a.addEventListener('click',function(e){ e.stopPropagation(); }); foot.appendChild(a); }
  draw();
  return box;
}

/* ── showtimes ──
   When the Agent looks up a movie (t.showtimes, from agent/seats.js), the task shows the days as tabs and
   each theater's times as buttons, right here instead of a link out. Tapping a time sends it back as his
   reply ("Get tickets for …"), so the next run opens that showing and picks seats. */
const showDay={}; // task id → the day tab he's on (a draft on this device)
function showtimesCard(t){
  const s=t.showtimes, box=el('div','seat-box show-box');
  const canPick=t.status==='needs-you'&&!t.done;
  const head=el('div','seat-head'); head.appendChild(el('span',null,'Showtimes'));
  if(s.movie)head.appendChild(el('span','seat-where',s.movie));
  box.appendChild(head);
  const tabs=el('div','show-days'); box.appendChild(tabs);
  const list=el('div','show-list'); box.appendChild(list);
  function draw(){
    const on=Math.min(showDay[t.id]||0,s.days.length-1), d=s.days[on];
    Array.prototype.forEach.call(tabs.children,function(b,i){ b.classList.toggle('on',i===on); b.setAttribute('aria-selected',String(i===on)); });
    list.textContent='';
    d.theaters.forEach(function(th){
      const row=el('div','show-theater');
      const name=el('div','show-name'); name.appendChild(el('span',null,th.name));
      if(th.dist)name.appendChild(el('span','show-dist',th.dist));
      row.appendChild(name);
      const times=el('div','show-times');
      th.times.forEach(function(x){
        const b=el('button','show-time'); b.appendChild(el('span',null,x.at));
        if(x.fmt)b.appendChild(el('small',null,x.fmt));
        b.disabled=!canPick;
        b.addEventListener('click',function(e){
          e.stopPropagation();
          const lt=liveTask(t), msg='Get tickets for '+(s.movie?s.movie+', ':'')+d.day+' '+x.at+(x.fmt?' ('+x.fmt+')':'')+' at '+th.name+(x.url?' — '+x.url:'');
          lt.reply=msg; agentSay(lt,'you',msg); lt.status='queued'; delete showDay[t.id];
          buzz('send'); touch();
        });
        times.appendChild(b);
      });
      row.appendChild(times); list.appendChild(row);
    });
  }
  s.days.forEach(function(d,i){
    const b=el('button','show-day',d.day); b.setAttribute('role','tab');
    b.addEventListener('click',function(e){ e.stopPropagation(); showDay[t.id]=i; buzz('tap'); draw(); });
    tabs.appendChild(b);
  });
  if(s.url){ const a=el('a','seat-link','All showtimes ↗'); a.href=s.url; a.target='_blank'; a.rel='noopener'; a.addEventListener('click',function(e){ e.stopPropagation(); }); box.appendChild(a); }
  draw();
  return box;
}

/* ── theaters on a map ──
   When the Agent finds where a movie is playing on the days he's free (t.theaters, from agent/seats.js), the
   task shows a map (Esri's gray basemap) with him (the blue dot) and a numbered pin per theater, and the list
   below, closest first. Tapping a pin picks its row; "Go here" sends it back as his reply ("Go to …"), so
   the next run shows that theater's times. */
const theaterPick={}; // task id → index of the theater he tapped (a draft on this device)
const MAP_W=640, MAP_H=280, TILE=256;
function mercX(lng,z){ return (lng+180)/360*TILE*Math.pow(2,z); }
function mercY(lat,z){ const s=Math.sin(lat*Math.PI/180); return (0.5-Math.log((1+s)/(1-s))/(4*Math.PI))*TILE*Math.pow(2,z); }
/* Esri's plain gray basemap (light, or dark when his theme is dark): no API key needed. The roads come
   from one zoom further in, drawn at half size, so they stay sharp on high-res screens; the street names
   sit on top at the map's own zoom so they're readable. The app has no dark mode of its own: a custom
   theme with a dark surface counts. */
function themeIsDark(){
  const m=getComputedStyle(document.documentElement).getPropertyValue('--surface').trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if(!m)return false;
  const h=m[1].length===3?m[1].replace(/./g,'$&$&'):m[1], v=[0,2,4].map(function(i){ return parseInt(h.substr(i,2),16); });
  return 0.299*v[0]+0.587*v[1]+0.114*v[2]<128;
}
function tileUrl(layer,z,x,y,dark){
  return 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_'+(dark?'Dark':'Light')+'_Gray_'+layer+'/MapServer/tile/'+z+'/'+y+'/'+x;
}
function theaterMap(pts,here,onPin){
  const NS='http://www.w3.org/2000/svg', all=pts.concat(here?[here]:[]);
  const span=function(z){
    const xs=all.map(function(p){ return mercX(p.lng,z); }), ys=all.map(function(p){ return mercY(p.lat,z); });
    return { x0:Math.min.apply(null,xs), x1:Math.max.apply(null,xs), y0:Math.min.apply(null,ys), y1:Math.max.apply(null,ys) };
  };
  // the closest zoom that fits every pin with a margin
  let z=15;
  for(;z>3;z--){ const b=span(z); if(b.x1-b.x0<=MAP_W-90&&b.y1-b.y0<=MAP_H-80)break; }
  const b=span(z), ox=(b.x0+b.x1)/2-MAP_W/2, oy=(b.y0+b.y1)/2-MAP_H/2;
  const svg=document.createElementNS(NS,'svg'); svg.setAttribute('viewBox','0 0 '+MAP_W+' '+MAP_H); svg.setAttribute('class','th-map');
  svg.setAttribute('role','img'); svg.setAttribute('aria-label','Map of the theaters');
  const dark=themeIsDark(); if(dark)svg.classList.add('dark');
  // one layer of tiles: zoom `tz` tiles drawn `size` px wide (size TILE/2 at z+1 = twice the detail)
  const tiles=function(layer,tz,size){
    const tn=Math.pow(2,tz);
    for(let tx=Math.floor(ox/size);tx<=Math.floor((ox+MAP_W)/size);tx++)for(let ty=Math.floor(oy/size);ty<=Math.floor((oy+MAP_H)/size);ty++){
      if(ty<0||ty>=tn)continue;
      const im=document.createElementNS(NS,'image');
      im.setAttribute('href',tileUrl(layer,tz,((tx%tn)+tn)%tn,ty,dark));
      im.setAttribute('x',tx*size-ox); im.setAttribute('y',ty*size-oy); im.setAttribute('width',size+0.5); im.setAttribute('height',size+0.5); // overlap: no hairline seams
      svg.appendChild(im);
    }
  };
  tiles('Base',z+1,TILE/2); tiles('Reference',z,TILE);
  if(here){
    const c=document.createElementNS(NS,'circle'); c.setAttribute('cx',mercX(here.lng,z)-ox); c.setAttribute('cy',mercY(here.lat,z)-oy);
    c.setAttribute('r',8); c.setAttribute('class','th-me');
    const tt=document.createElementNS(NS,'title'); tt.textContent='You'; c.appendChild(tt); svg.appendChild(c);
  }
  const pins=pts.map(function(p){
    const g=document.createElementNS(NS,'g'); g.setAttribute('class','th-pin');
    g.setAttribute('transform','translate('+(mercX(p.lng,z)-ox)+','+(mercY(p.lat,z)-oy)+')');
    const c=document.createElementNS(NS,'circle'); c.setAttribute('r',13); g.appendChild(c);
    const tx=document.createElementNS(NS,'text'); tx.setAttribute('text-anchor','middle'); tx.setAttribute('dy','5'); tx.textContent=String(p.i+1); g.appendChild(tx);
    const tt=document.createElementNS(NS,'title'); tt.textContent=p.name; g.appendChild(tt);
    g.addEventListener('click',function(e){ e.stopPropagation(); onPin(p.i); });
    svg.appendChild(g); return g;
  });
  const credit=document.createElementNS(NS,'text'); credit.setAttribute('x',MAP_W-6); credit.setAttribute('y',MAP_H-6);
  credit.setAttribute('text-anchor','end'); credit.setAttribute('class','th-credit'); credit.textContent='Esri, HERE, Garmin, © OpenStreetMap contributors'; svg.appendChild(credit);
  return { svg:svg, pins:pins };
}
function theatersCard(t){
  const s=t.theaters, box=el('div','seat-box th-box');
  const canPick=t.status==='needs-you'&&!t.done;
  const head=el('div','seat-head'); head.appendChild(el('span',null,'Theaters'));
  if(s.movie)head.appendChild(el('span','seat-where',s.movie));
  box.appendChild(head);
  if(s.days&&s.days.length)box.appendChild(el('div','th-days','Your days: '+s.days.join(', ')));
  const placed=[];
  s.theaters.forEach(function(th,i){ if(typeof th.lat==='number'&&typeof th.lng==='number')placed.push({ lat:th.lat, lng:th.lng, name:th.name, i:i }); });
  let map=null;
  if(placed.length){
    map=theaterMap(placed,s.here||null,function(i){ theaterPick[t.id]=i; buzz('tap'); draw(true); });
    const wrap=el('div','th-map-wrap'); wrap.appendChild(map.svg); box.appendChild(wrap);
  }
  const list=el('div','th-list'); box.appendChild(list);
  const rows=s.theaters.map(function(th,i){
    const row=el('div','th-row');
    row.appendChild(el('span','th-num',String(i+1)));
    const info=el('div','th-info');
    const name=el('div','show-name'); name.appendChild(el('span',null,th.name)); if(th.dist)name.appendChild(el('span','show-dist',th.dist));
    info.appendChild(name);
    if(th.address)info.appendChild(el('div','th-addr',th.address));
    if(th.days&&th.days.length)info.appendChild(el('div','th-addr','Showing '+th.days.join(', ')));
    row.appendChild(info);
    const go=el('button','btn-accent th-go','Go here'); go.disabled=!canPick;
    go.addEventListener('click',function(e){
      e.stopPropagation();
      const lt=liveTask(t), msg='Go to '+th.name+(th.address?' — '+th.address:'');
      lt.reply=msg; agentSay(lt,'you',msg); lt.status='queued'; delete theaterPick[t.id];
      buzz('send'); touch();
    });
    row.appendChild(go);
    row.addEventListener('click',function(e){ e.stopPropagation(); theaterPick[t.id]=i; draw(false); });
    list.appendChild(row); return row;
  });
  function draw(scroll){
    const on=theaterPick[t.id];
    rows.forEach(function(r,i){ r.classList.toggle('on',i===on); });
    if(map)map.pins.forEach(function(g,k){ g.classList.toggle('on',placed[k].i===on); });
    if(scroll&&on!=null&&rows[on]&&rows[on].scrollIntoView)rows[on].scrollIntoView({ block:'nearest' });
  }
  draw(false);
  return box;
}
