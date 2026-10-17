/* ── the seat map ──
   When Romulus picks seats on a ticket site (t.seats, from agent/seats.js), the task shows the map the
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
  const reset=el('button','cart-all','Back to Romulus’s pick'); acts.appendChild(reset);
  const same=function(a,b){ return a.length===b.length&&a.every(function(x){ return b.indexOf(x)!==-1; }); };
  function draw(){
    const m=mine(), on=m||its;
    btns.forEach(function(b){ b.classList.toggle('pick',on.indexOf(b.dataset.name)!==-1); b.setAttribute('aria-pressed',String(on.indexOf(b.dataset.name)!==-1)); });
    const changed=!!m&&!same(m,its);
    const names=changed?m:(s.picked&&s.picked.length?s.picked:its);
    info.textContent=changed?(m.length?'Your pick: '+m.join(', '):'Tap the seats you want')
      :(names.length?'Romulus picked '+names.join(', '):'Tap the seats you want')+(s.price?' · '+s.price:'');
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
   When Romulus looks up a movie (t.showtimes, from agent/seats.js), the task shows the days as tabs and
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
