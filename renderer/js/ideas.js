/* The Ideas tab: note cards sorted into groups.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── ideas: note cards you sort into groups ──
   Each idea is a card in a group (group '' = Unsorted); within a group cards stack in `order`.
   They live in state.ideas and sync through their own row next to the personal list
   (syncKey+':ideas'), so the task lists, Claude's tools and older builds never see them.
   Per card/group id the newer updatedAt wins; a tombstone beats older copies. */
const IDEA_COLORS=['yellow','green','blue','pink','purple','plain'];
const ideaUI={drag:null,gdrag:null,editing:null,adding:null,open:null,descing:null,confirmDel:null,pending:false};
function normIdeas(raw){
  const r=raw||{}; const num=function(v,d){ return isFinite(v)&&v!==null&&v!==''?+v:d; };
  const groups=(Array.isArray(r.groups)?r.groups:[]).filter(function(g){ return g&&g.id; }).map(function(g,i){
    return {id:String(g.id),name:String(g.name||''),color:IDEA_COLORS.indexOf(g.color)>=0?g.color:'yellow',order:num(g.order,i),updatedAt:g.updatedAt||0};
  });
  const cards=(Array.isArray(r.cards)?r.cards:[]).filter(function(c){ return c&&c.id; }).map(function(c,i){
    const o={id:String(c.id),text:String(c.text||''),group:c.group?String(c.group):'',order:num(c.order,i),updatedAt:c.updatedAt||0};
    // the description's sections, only when there are some, so older cards stay byte-identical for sync
    const secs=(Array.isArray(c.sections)?c.sections:[]).filter(function(x){ return x&&x.id; })
      .map(function(x){ return {id:String(x.id),title:String(x.title||''),body:String(x.body||'')}; });
    if(!secs.length&&c.desc)secs.push({id:'d'+o.id,title:'',body:String(c.desc)}); // the first version had one plain description
    if(secs.length)o.sections=secs;
    return o;
  });
  const tombs=(Array.isArray(r.tombstones)?r.tombstones:[]).filter(function(t){ return t&&t.id; });
  // the default group (Unsorted unless renamed): new ideas start here, removed groups' ideas land here
  const ib=r.inbox&&typeof r.inbox==='object'?r.inbox:{};
  const inbox={name:typeof ib.name==='string'?ib.name:'Unsorted',color:IDEA_COLORS.indexOf(ib.color)>=0?ib.color:'plain',order:num(ib.order,-1),updatedAt:ib.updatedAt||0};
  return {inbox:inbox,groups:groups,cards:cards,tombstones:tombs};
}
function ideasProfile(){
  const p=syncState.cfg&&syncState.cfg.personal;
  return validProfile(p)?{url:p.url,key:p.key,syncKey:p.syncKey+':ideas'}:null;
}
function ideasDoc(){ return {v:2,inbox:state.ideas.inbox,groups:state.ideas.groups,cards:state.ideas.cards,tombstones:state.ideas.tombstones}; }
function canonIdeas(d){
  const by=function(a,b){ return a.id<b.id?-1:1; };
  return JSON.stringify([d.inbox,d.groups.slice().sort(by),d.cards.slice().sort(by)]);
}
function mergeIdeas(remoteDoc){
  const remote=normIdeas(remoteDoc), local=state.ideas;
  const tombs={};
  local.tombstones.concat(remote.tombstones).forEach(function(x){ if(!tombs[x.id]||x.deletedAt>tombs[x.id])tombs[x.id]=x.deletedAt; });
  function mergeList(a,b){
    const byId={};
    a.concat(b).forEach(function(it){ const prev=byId[it.id]; if(!prev||(it.updatedAt||0)>(prev.updatedAt||0))byId[it.id]=it; });
    return Object.keys(byId).map(function(id){ return byId[id]; })
      .filter(function(it){ return !(tombs[it.id]&&tombs[it.id]>=(it.updatedAt||0)); });
  }
  const cutoff=Date.now()-60*86400000; // drop tombstones older than 60 days
  const mergedTombs=Object.keys(tombs).filter(function(id){ return tombs[id]>cutoff; })
    .map(function(id){ return {id:id,deletedAt:tombs[id]}; });
  const inbox=(remote.inbox.updatedAt||0)>(local.inbox.updatedAt||0)?remote.inbox:local.inbox;
  const merged={inbox:inbox,groups:mergeList(local.groups,remote.groups),cards:mergeList(local.cards,remote.cards),tombstones:mergedTombs};
  const changedLocal=canonIdeas(merged)!==canonIdeas(local);
  const changedRemote=canonIdeas(merged)!==canonIdeas(remote)||mergedTombs.length!==remote.tombstones.length;
  state.ideas=merged;
  return {changedLocal:changedLocal,changedRemote:changedRemote};
}

function ideaCard(id){ return state.ideas.cards.find(function(c){ return c.id===id; }); }
function ideaGroup(id){ if(id==='')return state.ideas.inbox; return state.ideas.groups.find(function(g){ return g.id===id; }); }
// a card whose group was deleted on another device falls back to Unsorted
function ideaGroupOf(c){ return c.group&&ideaGroup(c.group)?c.group:''; }
function ideaCardsIn(gid){
  return state.ideas.cards.filter(function(c){ return ideaGroupOf(c)===gid; })
    .sort(function(a,b){ return a.order-b.order||(a.id<b.id?-1:1); });
}
function ideaTomb(id){ state.ideas.tombstones.push({id:id,deletedAt:Date.now()}); }
function ideaRemoveCard(id){
  state.ideas.cards=state.ideas.cards.filter(function(c){ return c.id!==id; });
  ideaTomb(id); persist();
}
function ideaAddCard(gid,text){
  const list=ideaCardsIn(gid);
  const c={id:uid(),text:'',group:gid,order:list.length?list[list.length-1].order+1:0,updatedAt:0};
  state.ideas.cards.push(c); ideaSetFullText(c,text);
}
// an idea as one piece of text: the title, then its notes on the lines under it
// (older ideas with headed sections show each heading on its own line)
function ideaFullText(c){
  const notes=(c.sections||[]).map(function(s){ return [s.title,s.body].filter(Boolean).join('\n'); }).filter(Boolean).join('\n\n');
  return notes?c.text+'\n'+notes:c.text;
}
function ideaSetFullText(c,v){
  v=v.replace(/^\s*\n/,'').replace(/\s+$/,'');
  const i=v.indexOf('\n'), title=(i<0?v:v.slice(0,i)).trim(), notes=i<0?'':v.slice(i+1).replace(/^\s*\n/,'');
  const secs=notes.trim()?[{id:(c.sections&&c.sections[0]&&c.sections[0].id)||uid(),title:'',body:notes}]:null;
  if(title===c.text&&JSON.stringify(secs)===JSON.stringify(c.sections||null))return;
  c.text=title; if(secs)c.sections=secs; else delete c.sections;
  c.updatedAt=Date.now(); persist();
}
function ideaAddGroup(){
  const gs=state.ideas.groups, now=Date.now();
  const g={id:uid(),name:'',color:IDEA_COLORS[gs.length%5],order:Math.max.apply(null,[state.ideas.inbox.order,-1].concat(gs.map(function(x){ return x.order; })))+1,updatedAt:now};
  gs.push(g); persist(); drawIdeas();
  const inp=document.querySelector('.idea-group[data-group="'+g.id+'"] .idea-gname'); if(inp)inp.focus();
}
function ideaRemoveGroup(gid){
  const now=Date.now();
  // its cards aren't lost: they go back to Unsorted, after what's already there
  const base=ideaCardsIn('').reduce(function(m,c){ return Math.max(m,c.order); },-1)+1;
  ideaCardsIn(gid).forEach(function(c,i){ c.group=''; c.order=base+i; c.updatedAt=now; });
  state.ideas.groups=state.ideas.groups.filter(function(g){ return g.id!==gid; });
  ideaTomb(gid); persist(); drawIdeas();
}
// every group in board order, the default one (id '') included
function ideaGroupsSorted(){
  const ib=state.ideas.inbox;
  return [{id:'',name:ib.name,color:ib.color,order:ib.order}].concat(state.ideas.groups)
    .sort(function(a,b){ return a.order-b.order||(a.id<b.id?-1:1); });
}
// put the groups in this order (a list of ids); only the ones whose spot changed get touched
function ideaSetGroupOrder(ids){
  const now=Date.now(); let changed=false;
  ids.forEach(function(id,i){ const g=ideaGroup(id); if(g&&g.order!==i){ g.order=i; g.updatedAt=now; changed=true; } });
  if(changed)persist();
}
// leaving the tab: let any open text box save itself
function ideaLeave(){ const a=document.activeElement; if(a&&$('ideasView').contains(a))a.blur(); }

// external re-renders (sync) wait while you're dragging or typing, so nothing is yanked away
function renderIdeas(){
  const a=document.activeElement;
  if((ideaUI.drag&&ideaUI.drag.active)||(ideaUI.gdrag&&ideaUI.gdrag.active)||(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA')&&$('ideasView').contains(a))){ ideaUI.pending=true; return; }
  drawIdeas();
}
function drawIdeas(){
  ideaUI.pending=false;
  const wrap=$('ideaGroups'); wrap.textContent='';
  const ib=state.ideas.inbox;
  const groups=ideaGroupsSorted();
  let focusEl=null;
  groups.forEach(function(g){
    const sec=el('section','idea-group'); sec.dataset.group=g.id; sec.dataset.color=g.color;
    if(g.color!=='plain')sec.style.setProperty('--g','var(--idea-'+g.color+')');
    const head=el('div','idea-ghead');
    const grip=el('button','idea-ggrip','⠿'); grip.title='Drag to move this group (or use the arrow keys)'; grip.setAttribute('aria-label','Move group');
    grip.addEventListener('keydown',function(e){
      const step=e.key==='ArrowLeft'||e.key==='ArrowUp'?-1:e.key==='ArrowRight'||e.key==='ArrowDown'?1:0;
      if(!step)return; e.preventDefault();
      const ids=ideaGroupsSorted().map(function(x){ return x.id; }), i=ids.indexOf(g.id), j=i+step;
      if(j<0||j>=ids.length)return;
      ids.splice(i,1); ids.splice(j,0,g.id); ideaSetGroupOrder(ids); drawIdeas();
      const ng=document.querySelector('.idea-group[data-group="'+g.id+'"] .idea-ggrip'); if(ng)ng.focus();
    });
    head.appendChild(grip);
    const name=el('input','idea-gname'); name.value=g.name; name.placeholder='Name this group'; name.setAttribute('aria-label','Group name');
    const cards=ideaCardsIn(g.id);
    if(!g.id)name.placeholder='Unsorted';
    {
      name.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key==='Escape')name.blur(); });
      name.addEventListener('blur',function(){
        const gg=ideaGroup(g.id); const v=name.value.trim();
        if(gg&&v!==gg.name){ gg.name=v; gg.updatedAt=Date.now(); persist(); }
        if(ideaUI.pending)drawIdeas();
      });
    }
    head.appendChild(name);
    head.appendChild(el('span','mono idea-gcount',cards.length?String(cards.length):''));
    {
      const col=el('button','idea-gcolor'); col.style.background='var(--idea-'+g.color+')'; col.title='Change colour'; col.setAttribute('aria-label','Change colour');
      col.addEventListener('click',function(){ const gg=ideaGroup(g.id); if(!gg)return; gg.color=IDEA_COLORS[(IDEA_COLORS.indexOf(gg.color)+1)%IDEA_COLORS.length]; gg.updatedAt=Date.now(); persist(); drawIdeas(); });
      head.appendChild(col);
    }
    if(g.id){ // the default group stays: it's where new ideas start
      const del=el('button','idea-gdel','×'); del.title='Remove group (its ideas move to '+(ib.name||'Unsorted')+')'; del.setAttribute('aria-label','Remove group');
      del.addEventListener('click',function(){ ideaRemoveGroup(g.id); });
      head.appendChild(del);
    }
    sec.appendChild(head);
    const flow=el('div','idea-cards'); flow.dataset.group=g.id;
    cards.forEach(function(c){
      const b=el('div','idea-card'); b.dataset.id=c.id;
      if(ideaUI.open===c.id||ideaUI.editing===c.id){ // tapped open: its notes drop down under the title; tap any text to edit
        b.classList.add('open');
        const fold=el('button','idea-fold','▴'); fold.title='Collapse'; fold.setAttribute('aria-label','Collapse idea');
        fold.addEventListener('mousedown',function(e){ e.preventDefault(); });
        fold.addEventListener('click',function(){
          const a=document.activeElement; if(a&&b.contains(a))a.blur(); // saves what's being typed first
          ideaUI.open=null; ideaUI.editing=null; ideaUI.confirmDel=null; drawIdeas();
        });
        b.appendChild(fold);
        if(ideaUI.editing===c.id){ // one box: the first line is the title, everything under it is the notes
          b.classList.add('editing');
          const ta=ideaTextBox(ideaFullText(c),'Idea title\nNotes underneath…');
          let done=false;
          const commit=function(){
            if(done)return; done=true; ideaUI.editing=null;
            const cc=ideaCard(c.id);
            if(cc){ if(!ta.value.trim())ideaRemoveCard(c.id); else ideaSetFullText(cc,ta.value); }
            drawIdeas();
          };
          ta.addEventListener('keydown',function(e){ if(e.key==='Escape'||(e.key==='Enter'&&(e.ctrlKey||e.metaKey))){ e.preventDefault(); commit(); } });
          ta.addEventListener('blur',commit);
          b.appendChild(ta); focusEl=ta;
          if(ideaUI.caret==='notes'&&!c.sections){ ta.value+='\n'; } // "+ Add notes": start on the line under the title
          ideaUI.caret=null;
        } else {
          const tt=el('div','idea-title',c.text); tt.title='Click to edit';
          b.appendChild(tt);
          const secs=el('div','idea-secs');
          (c.sections||[]).forEach(function(s){
            const blk=el('div','idea-sec'); blk.dataset.sec=s.id;
            if(s.title)blk.appendChild(el('div','idea-sechead',s.title));
            if(s.body)blk.appendChild(el('div','idea-secbody',s.body));
            blk.addEventListener('click',function(){
              const sel=window.getSelection(); if(sel&&!sel.isCollapsed&&blk.contains(sel.anchorNode))return; // highlighting lines to move, not editing
              ideaUI.editing=c.id; drawIdeas();
            });
            secs.appendChild(blk);
          });
          if(!c.sections){
            const add=el('button','idea-secadd','+ Add notes');
            add.addEventListener('click',function(){ ideaUI.editing=c.id; ideaUI.caret='notes'; drawIdeas(); });
            secs.appendChild(add);
          }
          b.appendChild(secs);
        }
        const foot=el('div','idea-edit-foot idea-ofoot');
        foot.appendChild(el('span','mono',ideaUI.editing===c.id?'esc to save':''));
        const btns=el('span');
        const sure=ideaUI.confirmDel===c.id;
        const del=el('button','x'+(sure?' sure':''),sure?'Tap again to delete':'Delete'); del.setAttribute('aria-label','Delete idea');
        del.addEventListener('mousedown',function(e){ e.preventDefault(); });
        del.addEventListener('click',function(){
          if(!sure){ ideaUI.confirmDel=c.id; drawIdeas(); return; }
          ideaUI.confirmDel=null; ideaUI.open=null; ideaUI.descing=null; ideaUI.editing=null; ideaRemoveCard(c.id); drawIdeas();
        });
        btns.appendChild(del); foot.appendChild(btns);
        b.appendChild(foot);
      } else {
        b.appendChild(el('div','clip',c.text));
        b.title=c.sections?'Click to open its notes · double-click to edit':'Click to open · double-click to edit';
        if(c.sections)b.classList.add('hasdesc');
      }
      flow.appendChild(b);
    });
    if(ideaUI.adding===g.id){
      const b=el('div','idea-card editing'); const ta=ideaTextBox('','Idea title\nNotes underneath…');
      let done=false;
      const save=function(){ if(ta.value.trim())ideaAddCard(g.id,ta.value); };
      ta.addEventListener('keydown',function(e){
        if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){ e.preventDefault(); done=true; save(); drawIdeas(); } // saved; a fresh box opens for the next one
        else if(e.key==='Escape'){ e.preventDefault(); done=true; save(); ideaUI.adding=null; drawIdeas(); }
      });
      ta.addEventListener('blur',function(){ if(done)return; done=true; ideaUI.adding=null; save(); drawIdeas(); });
      const foot=el('div','idea-edit-foot'); foot.appendChild(el('span','mono','esc to save'));
      b.appendChild(ta); b.appendChild(foot); flow.appendChild(b); focusEl=ta;
    } else {
      const add=el('button','idea-addb','+ Add an idea'); add.setAttribute('aria-label','Add an idea to this group');
      add.addEventListener('click',function(){ ideaUI.editing=null; ideaUI.adding=g.id; drawIdeas(); });
      flow.appendChild(add);
    }
    if(!g.id&&!cards.length&&!state.ideas.groups.length&&ideaUI.adding!=='')
      flow.insertBefore(el('div','idea-empty','Write ideas here, then make groups and drag them in.'),flow.firstChild);
    sec.appendChild(flow);
    const sz=el('div','idea-gsize'); sz.title='Drag to make the boxes wider or narrower'; sec.appendChild(sz);
    wrap.appendChild(sec);
  });
  if(focusEl&&!$('ideasView').hidden){ focusEl.focus(); focusEl.setSelectionRange(focusEl.value.length,focusEl.value.length); focusEl.fit(); }
}
// a text box that grows with what you type
function ideaTextBox(text,ph){
  const ta=el('textarea'); ta.value=text; ta.placeholder=ph; ta.setAttribute('aria-label',ph);
  ta.fit=function(){ ta.style.height='auto'; ta.style.height=ta.scrollHeight+'px'; };
  ta.addEventListener('input',ta.fit);
  return ta;
}

/* highlight lines in an open idea's section and a bar pops up to move them to the To-do or Agent
   tab: each line becomes its own task and leaves the description. */
(function(){
  const bar=el('div','idea-movebar'); bar.hidden=true;
  const msg=el('span','mono');
  const toDo=el('button',null,'→ To-do'), toAgent=el('button',null,'→ Agent');
  bar.appendChild(msg); bar.appendChild(toDo); bar.appendChild(toAgent);
  document.body.appendChild(bar);
  let pick=null, hideT=null;
  // what's highlighted, as whole lines of one section: {card,sec,from,to,lines}
  function readPick(){
    const sel=window.getSelection(); if(!sel||sel.isCollapsed||!sel.rangeCount)return null;
    const r=sel.getRangeAt(0);
    const node=r.commonAncestorContainer, host=node.nodeType===1?node:node.parentNode;
    const sb=host&&host.closest?host.closest('.idea-sec'):null; if(!sb)return null;
    const body=sb.querySelector('.idea-secbody'), card=sb.closest('.idea-card'); if(!body||!card)return null;
    const c=ideaCard(card.dataset.id), s=c&&(c.sections||[]).find(function(x){ return x.id===sb.dataset.sec; }); if(!s)return null;
    const at=function(n,o,fallback){ if(!body.contains(n))return fallback; const p=document.createRange(); p.selectNodeContents(body); p.setEnd(n,o); return p.toString().length; };
    const text=s.body, start=at(r.startContainer,r.startOffset,0), end=at(r.endContainer,r.endOffset,text.length);
    if(end<=start)return null;
    const from=text.lastIndexOf('\n',start-1)+1;
    let to=text.indexOf('\n',text[end-1]==='\n'?end-1:end); if(to<0)to=text.length;
    const lines=text.slice(from,to).split('\n')
      .map(function(l){ return l.replace(/^\s*(?:[-*•–]|\d+[.)]|\[[ xX]?\])\s+/,'').trim(); }) // bullets and checkboxes aren't part of the task
      .filter(Boolean);
    if(!lines.length)return null;
    return {card:c.id,sec:s.id,from:from,to:to,lines:lines,rect:r.getBoundingClientRect()};
  }
  function show(){
    clearTimeout(hideT);
    const p=readPick();
    if(!p){ hideT=setTimeout(function(){ bar.hidden=true; pick=null; },250); return; } // the delay lets a tap on the bar land first
    pick=p;
    msg.textContent=p.lines.length===1?'Move 1 line':'Move '+p.lines.length+' lines';
    toAgent.hidden=!agentConfigured();
    bar.hidden=false;
    const bw=bar.offsetWidth, bh=bar.offsetHeight;
    const x=Math.max(8,Math.min(window.innerWidth-bw-8,p.rect.left+p.rect.width/2-bw/2));
    const y=p.rect.top-bh-8<8?p.rect.bottom+8:p.rect.top-bh-8; // above the highlight, or below if there's no room
    bar.style.left=x+'px'; bar.style.top=y+'px';
  }
  document.addEventListener('selectionchange',function(){ if(!$('ideasView').hidden)show(); else bar.hidden=true; });
  window.addEventListener('scroll',function(){ if(!bar.hidden)show(); },true);
  function move(ws){
    const p=pick; if(!p)return;
    const c=ideaCard(p.card), s=c&&(c.sections||[]).find(function(x){ return x.id===p.sec; }); if(!s)return;
    const now=Date.now();
    p.lines.forEach(function(title,i){
      const t={id:uid(),title:title,done:false,due:null,dueTime:null,tag:null,ws:ws,subs:[],googleEventId:null,created:now+i};
      if(ws==='agent'){ t.status='queued'; t.note=null; }
      state.tasks.push(t);
    });
    // take the lines (and the line break after them) out of the section
    let body=p.to<s.body.length?s.body.slice(0,p.from)+s.body.slice(p.to+1):s.body.slice(0,Math.max(0,p.from-1));
    body=body.replace(/\s+$/,'');
    const list=c.sections.map(function(x){ return x.id===s.id?{id:x.id,title:x.title,body:body}:x; })
      .filter(function(x){ return x.title||x.body; });
    if(list.length)c.sections=list; else delete c.sections;
    c.updatedAt=now;
    window.getSelection().removeAllRanges(); pick=null; bar.hidden=true;
    buzz('add'); persist(); touch(); drawIdeas();
    const n=p.lines.length;
    ideaNote((n===1?'1 task':n+' tasks')+' added to '+(ws==='agent'?'Agent':'To-do'));
  }
  // act on pointerdown: on a phone the tap would otherwise clear the highlight first
  toDo.addEventListener('pointerdown',function(e){ e.preventDefault(); move('personal'); });
  toAgent.addEventListener('pointerdown',function(e){ e.preventDefault(); move('agent'); });
})();
// a short note at the bottom of the screen
function ideaNote(text){
  let n=document.querySelector('.idea-note');
  if(!n){ n=el('div','idea-note mono'); document.body.appendChild(n); }
  n.textContent=text; n.hidden=false;
  clearTimeout(ideaNote._t); ideaNote._t=setTimeout(function(){ n.hidden=true; },2600);
}

/* dragging: the card lifts off, a dashed gap follows the pointer and the other cards slide
   aside. Mouse drags start after a few px; on a phone, press and hold (so swiping still scrolls). */
(function(){
  const wrap=$('ideaGroups');
  function cardsIn(flow){ return Array.from(flow.querySelectorAll('.idea-card')).filter(function(b){ return !b.classList.contains('ph')&&!b.classList.contains('dragging')&&!b.classList.contains('editing'); }); }
  // slide every card from where it was to where it lands
  function flip(mutate){
    const all=Array.from(wrap.querySelectorAll('.idea-card:not(.dragging),.idea-addb'));
    const before=all.map(function(n){ return n.getBoundingClientRect(); });
    mutate();
    if(prefersReduced)return;
    all.forEach(function(n,i){
      const r=n.getBoundingClientRect(), dx=before[i].left-r.left, dy=before[i].top-r.top;
      if(!dx&&!dy)return;
      n.style.transition='none'; n.style.transform='translate('+dx+'px,'+dy+'px)';
      n.getBoundingClientRect();
      n.style.transition='transform .18s ease'; n.style.transform='';
    });
  }
  function placeAt(d,x,y){
    const hit=document.elementFromPoint(x,y);
    const sec=hit&&hit.closest?hit.closest('.idea-group'):null;
    wrap.querySelectorAll('.idea-group.over').forEach(function(n){ if(n!==sec)n.classList.remove('over'); });
    if(!sec)return;
    sec.classList.add('over');
    const flow=sec.querySelector('.idea-cards');
    let ref=flow.querySelector('.idea-addb')||null;
    const list=cardsIn(flow);
    for(let i=0;i<list.length;i++){
      const r=list[i].getBoundingClientRect();
      if(y<r.top+r.height/2){ ref=list[i]; break; }
    }
    if(d.ph.parentNode===flow&&(d.ph.nextSibling===ref||(ref===null&&!d.ph.nextSibling)))return;
    flip(function(){ flow.insertBefore(d.ph,ref); });
  }
  function start(d){
    d.active=true; buzz('tick');
    const r=d.el.getBoundingClientRect();
    d.dx=d.sx-r.left; d.dy=d.sy-r.top;
    d.ph=el('div','idea-card ph'); d.ph.style.height=r.height+'px';
    d.ghost=d.el.cloneNode(true); d.ghost.classList.add('lifted');
    d.ghost.style.width=r.width+'px'; d.ghost.style.left=r.left+'px'; d.ghost.style.top=r.top+'px';
    const g=getComputedStyle(d.el).backgroundColor; d.ghost.style.background=g;
    document.body.appendChild(d.ghost);
    d.el.parentNode.insertBefore(d.ph,d.el);
    d.el.classList.add('dragging'); d.el.style.display='none';
  }
  function move(d,x,y){
    d.ghost.style.left=(x-d.dx)+'px'; d.ghost.style.top=(y-d.dy)+'px';
    placeAt(d,x,y);
    // nudge the page when dragging near the top/bottom edge
    if(y<50)window.scrollBy(0,-12); else if(y>window.innerHeight-50)window.scrollBy(0,12);
  }
  function finish(d,drop){
    clearTimeout(d.timer);
    if(d.ghost)d.ghost.remove();
    wrap.querySelectorAll('.idea-group.over').forEach(function(n){ n.classList.remove('over'); });
    const c=ideaCard(d.id);
    if(drop&&c&&d.ph&&d.ph.parentNode){
      const flow=d.ph.parentNode, gid=flow.dataset.group;
      const prev=d.ph.previousElementSibling, next=d.ph.nextElementSibling;
      const po=prev&&prev.dataset.id&&ideaCard(prev.dataset.id), no=next&&next.dataset.id&&ideaCard(next.dataset.id);
      const order=po&&no?(po.order+no.order)/2:po?po.order+1:no?no.order-1:0;
      if(gid!==ideaGroupOf(c)||order!==c.order){ c.group=gid; c.order=order; c.updatedAt=Date.now(); persist(); }
    }
    ideaUI.drag=null;
    drawIdeas();
  }
  wrap.addEventListener('pointerdown',function(e){
    if(e.button>0||ideaUI.drag||ideaUI.gdrag)return;
    let b=e.target.closest('.idea-card'); if(!b||!b.dataset.id||b.classList.contains('editing'))return;
    if(e.target.closest('.idea-secs,.idea-ofoot,.idea-fold'))return; // the open card's sections and buttons handle their own taps
    const a=document.activeElement;
    if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA')&&wrap.contains(a)){ // save what's being typed first (that redraws the cards)
      const id=b.dataset.id; a.blur();
      b=Array.from(wrap.querySelectorAll('.idea-card')).find(function(n){ return n.dataset.id===id; });
      if(!b)return;
    }
    const d={id:b.dataset.id,el:b,sx:e.clientX,sy:e.clientY,pid:e.pointerId,touch:e.pointerType!=='mouse',active:false};
    ideaUI.drag=d;
    if(d.touch)d.timer=setTimeout(function(){ if(ideaUI.drag===d)start(d); },260);
    else e.preventDefault();
  });
  document.addEventListener('pointermove',function(e){
    const d=ideaUI.drag; if(!d||e.pointerId!==d.pid)return;
    if(!d.active){
      const far=Math.abs(e.clientX-d.sx)+Math.abs(e.clientY-d.sy);
      if(d.touch){ if(far>8){ clearTimeout(d.timer); ideaUI.drag=null; } return; } // a swipe: let the page scroll
      if(far<5)return;
      start(d);
    }
    move(d,e.clientX,e.clientY);
  });
  // once a hold-drag has started, stop the page from scrolling under the finger
  document.addEventListener('touchmove',function(e){ if(ideaUI.drag&&ideaUI.drag.active)e.preventDefault(); },{passive:false});
  document.addEventListener('pointerup',function(e){
    const d=ideaUI.drag; if(!d||e.pointerId!==d.pid)return;
    if(d.active){ finish(d,true); return; }
    clearTimeout(d.timer); ideaUI.drag=null;
    if(ideaCard(d.id)){ // a click/tap opens it; on an open one it edits the text (so a double-click goes straight to editing)
      ideaUI.adding=null; ideaUI.descing=null; ideaUI.confirmDel=null;
      if(ideaUI.open===d.id)ideaUI.editing=d.id; else { ideaUI.open=d.id; ideaUI.editing=null; }
      drawIdeas();
    }
  });
  $('ideasView').addEventListener('pointerdown',function(e){ // a click on empty board space folds the open idea
    if(e.button>0||!ideaUI.open||ideaUI.editing||e.target.closest('.idea-card,button,input,textarea,.idea-gsize'))return;
    ideaUI.open=null; ideaUI.confirmDel=null; drawIdeas();
  });
  document.addEventListener('keydown',function(e){ // esc closes the open idea (when nothing's being typed in)
    if(e.key!=='Escape'||$('ideasView').hidden||!ideaUI.open)return;
    const t=e.target; if(t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'))return; // there esc just saves
    ideaUI.open=null; ideaUI.confirmDel=null; drawIdeas();
  });
  document.addEventListener('pointercancel',function(e){
    const d=ideaUI.drag; if(!d||e.pointerId!==d.pid)return;
    if(d.active)finish(d,false); else { clearTimeout(d.timer); ideaUI.drag=null; }
  });
  wrap.addEventListener('contextmenu',function(e){ if(e.target.closest('.idea-card')&&!e.target.closest('.idea-secs'))e.preventDefault(); }); // long-press menu on phones (but sections can still be highlighted)
  $('ideaAddGroup').addEventListener('click',ideaAddGroup);
})();

/* box size (desktop): drag the right edge of any group to make every box wider or narrower; the grid
   fits as many across as it can. Ctrl/⌘ + scroll over the board does the same. Kept per device. */
(function(){
  const KEY='tasks.ideaBoxW', wrap=$('ideaGroups');
  let cur=280;
  function set(w,save){
    cur=Math.max(200,Math.min(640,Math.round(w/10)*10||280));
    wrap.style.setProperty('--idea-w',cur+'px');
    if(save)try{ localStorage.setItem(KEY,String(cur)); }catch(e){}
  }
  let w=280; try{ w=+localStorage.getItem(KEY)||280; }catch(e){}
  set(w,false);
  let d=null;
  wrap.addEventListener('pointerdown',function(e){
    const h=e.target.closest('.idea-gsize'); if(!h||e.button>0)return;
    e.preventDefault(); e.stopPropagation();
    // start from the box's real width (columns stretch to fill the row)
    d={x:e.clientX,w:h.parentNode.getBoundingClientRect().width,pid:e.pointerId};
    h.classList.add('on'); document.body.classList.add('idea-sizing');
  });
  document.addEventListener('pointermove',function(e){ if(d&&e.pointerId===d.pid)set(d.w+e.clientX-d.x,false); });
  function end(e){
    if(!d||e.pointerId!==d.pid)return;
    document.body.classList.remove('idea-sizing');
    set(cur,true); d=null;
    wrap.querySelectorAll('.idea-gsize.on').forEach(function(n){ n.classList.remove('on'); });
  }
  document.addEventListener('pointerup',end); document.addEventListener('pointercancel',end);
  wrap.addEventListener('dblclick',function(e){ if(e.target.closest('.idea-gsize'))set(280,true); }); // back to the default size
  wrap.addEventListener('wheel',function(e){
    if(!(e.ctrlKey||e.metaKey))return; e.preventDefault();
    set(cur+(e.deltaY<0?20:-20),true);
  },{passive:false});
})();

/* moving whole groups: grab the ⠿ handle; the group lifts off, a dashed gap follows the pointer
   through the grid and the other groups slide aside. The handle doesn't scroll, so no hold needed. */
(function(){
  const wrap=$('ideaGroups');
  function secs(){ return Array.from(wrap.querySelectorAll('.idea-group')).filter(function(n){ return !n.classList.contains('gdrag'); }); }
  function flip(mutate){
    const all=secs().filter(function(n){ return !n.classList.contains('gph'); });
    const before=all.map(function(n){ return n.getBoundingClientRect(); });
    mutate();
    if(prefersReduced)return;
    all.forEach(function(n,i){
      const r=n.getBoundingClientRect(), dx=before[i].left-r.left, dy=before[i].top-r.top;
      if(!dx&&!dy)return;
      n.style.transition='none'; n.style.transform='translate('+dx+'px,'+dy+'px)';
      n.getBoundingClientRect();
      n.style.transition='transform .18s ease'; n.style.transform='';
    });
  }
  // the gap goes before the first group that comes after the pointer in reading order
  function placeAt(d,x,y){
    const list=secs().filter(function(n){ return n!==d.ph; });
    const rects=list.map(function(n){ return n.getBoundingClientRect(); });
    let ref=null;
    for(let i=0;i<list.length;i++){
      const r=rects[i];
      const row=rects.filter(function(o){ return Math.abs(o.top-r.top)<2; });
      const rowBottom=row.reduce(function(m,o){ return Math.max(m,o.bottom); },r.bottom);
      // alone on its row (the phone's single column): its top half means before it
      const before=row.length>1?x<r.left+r.width/2:y<r.top+r.height/2;
      if(y<r.top||(y<rowBottom&&before)){ ref=list[i]; break; }
    }
    if(d.ph.nextElementSibling===ref||(ref===null&&!d.ph.nextElementSibling))return;
    flip(function(){ wrap.insertBefore(d.ph,ref); });
  }
  function start(d){
    d.active=true; buzz('tick'); document.body.classList.add('gdragging');
    const r=d.el.getBoundingClientRect();
    d.dx=d.sx-r.left; d.dy=d.sy-r.top;
    d.ph=el('section','idea-group gph'); d.ph.style.height=r.height+'px';
    d.ghost=d.el.cloneNode(true); d.ghost.classList.add('glifted');
    d.ghost.style.width=r.width+'px'; d.ghost.style.left=r.left+'px'; d.ghost.style.top=r.top+'px';
    document.body.appendChild(d.ghost);
    wrap.insertBefore(d.ph,d.el);
    d.el.classList.add('gdrag'); d.el.style.display='none';
  }
  function finish(d,drop){
    if(d.ghost)d.ghost.remove();
    document.body.classList.remove('gdragging');
    if(drop&&d.ph&&d.ph.parentNode){
      const ids=[];
      Array.from(wrap.children).forEach(function(n){ if(n===d.ph)ids.push(d.id); else if(n!==d.el)ids.push(n.dataset.group); });
      ideaSetGroupOrder(ids);
    }
    ideaUI.gdrag=null;
    drawIdeas();
  }
  wrap.addEventListener('pointerdown',function(e){
    if(e.button>0||ideaUI.drag||ideaUI.gdrag)return;
    const grip=e.target.closest('.idea-ggrip'); if(!grip)return;
    const gid=grip.closest('.idea-group').dataset.group;
    const a=document.activeElement;
    if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA')&&wrap.contains(a))a.blur(); // save what's being typed first (that may redraw)
    const live=Array.from(wrap.querySelectorAll('.idea-group')).find(function(n){ return n.dataset.group===gid; });
    if(!live)return;
    e.preventDefault();
    ideaUI.gdrag={id:gid,el:live,sx:e.clientX,sy:e.clientY,pid:e.pointerId,active:false};
  });
  document.addEventListener('pointermove',function(e){
    const d=ideaUI.gdrag; if(!d||e.pointerId!==d.pid)return;
    if(!d.active){ if(Math.abs(e.clientX-d.sx)+Math.abs(e.clientY-d.sy)<5)return; start(d); }
    d.ghost.style.left=(e.clientX-d.dx)+'px'; d.ghost.style.top=(e.clientY-d.dy)+'px';
    placeAt(d,e.clientX,e.clientY);
    if(e.clientY<50)window.scrollBy(0,-12); else if(e.clientY>window.innerHeight-50)window.scrollBy(0,12);
  });
  document.addEventListener('touchmove',function(e){ if(ideaUI.gdrag&&ideaUI.gdrag.active)e.preventDefault(); },{passive:false});
  document.addEventListener('pointerup',function(e){
    const d=ideaUI.gdrag; if(!d||e.pointerId!==d.pid)return;
    if(d.active)finish(d,true); else ideaUI.gdrag=null;
  });
  document.addEventListener('pointercancel',function(e){
    const d=ideaUI.gdrag; if(!d||e.pointerId!==d.pid)return;
    if(d.active)finish(d,false); else ideaUI.gdrag=null;
  });
})();
