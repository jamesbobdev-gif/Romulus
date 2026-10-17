/* His usual groceries, kept on his grocery tasks (not shown as a list: he sees the order as picture
   cards), each with how often it's needed. The agent marks what it bought; "we're out of eggs" (typed or said) flags an item for the
   next order. One of the page scripts in renderer/js: they share one global scope.
   An item: {name, every (weeks), last ('YYYY-MM-DD' bought, or null), out (needed next order)} */
'use strict';

function listItem(x){
  if(typeof x==='string')return {name:x.trim(),every:1,last:null,out:false}; // the first version kept plain lines
  if(!x||!String(x.name||'').trim())return null;
  const every=Math.max(1,Math.min(52,Math.round(Number(x.every)||1)));
  return {name:String(x.name).trim().slice(0,120),every:every,last:/^\d{4}-\d{2}-\d{2}$/.test(x.last)?x.last:null,out:!!x.out};
}
function normList(list){ return (Array.isArray(list)?list:[]).map(listItem).filter(Boolean).slice(0,200); }
const sameItem=function(a,b){ const n=function(s){ return String(s).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }; return n(a)===n(b); };
// on the next order? out, never bought, or its weeks are up (counting from the day it was bought)
function itemDue(it,now){
  if(it.out||!it.last)return true;
  const next=new Date(it.last+'T00:00:00'); next.setDate(next.getDate()+7*it.every-2); // a couple of days' slack for the weekly run
  return next.getTime()<=(now||Date.now());
}
const GROCERY_WORDS=/\b(grocer(y|ies)|ebt|food stamps)\b/i; // asking for any of these starts the 2 weeks over
const isGroceryTask=function(t){ return taskWs(t)==='agent'&&(GROCERY_WORDS.test(t.title)||(Array.isArray(t.list)&&t.list.length>0)); };

// the agent's changes: {add:[{name,every}], bought:[names], remove:[names]}. Never a whole new list,
// so what he added or removed while it worked stays as he left it
function applyListUpdate(t,ch){
  if(!ch||typeof ch!=='object')return;
  if(!normList(t.list).length){ const k=groceryTask(); if(k&&k!==t)t.list=normList(k.list); } // a new grocery task starts from his list
  const list=normList(t.list), today=new Date().toISOString().slice(0,10);
  (Array.isArray(ch.remove)?ch.remove:[]).forEach(function(n){ for(let i=list.length-1;i>=0;i--)if(sameItem(list[i].name,n))list.splice(i,1); });
  (Array.isArray(ch.add)?ch.add:[]).forEach(function(a){ const it=listItem(a); if(it&&!list.some(function(x){ return sameItem(x.name,it.name); }))list.push(it); });
  (Array.isArray(ch.bought)?ch.bought:[]).forEach(function(n){ list.forEach(function(x){ if(sameItem(x.name,n)){ x.last=today; x.out=false; } }); });
  t.list=list.length?list:null;
}

// "we're out of eggs and milk" / "add eggs to groceries" → ['eggs','milk'], or null
function outOfNames(text){
  const m=String(text||'').match(/^\s*(?:we(?:'|’)?re|we are|i(?:'|’)?m|i am)\s+(?:all\s+|running\s+)?out of\s+(.+?)[.!]?\s*$/i)
    ||String(text||'').match(/^\s*(?:add|put)\s+(.+?)\s+(?:to|on)\s+(?:the\s+|my\s+)?grocer(?:y|ies)(?:\s+list)?[.!]?\s*$/i);
  if(!m)return null;
  const names=m[1].split(/\s*(?:,|\band\b|&)\s*/i).map(function(s){ return s.replace(/^(some|more|the|a|an|any)\s+/i,'').trim(); }).filter(Boolean).slice(0,12);
  // "I'm out of time on this essay" isn't groceries: short item names only, none of the usual sayings
  if(!names.length||names.some(function(n){ return n.split(' ').length>4||/^(time|money|patience|luck|here|town|the office|office|breath|ideas|options|it|this|that|control|order|reach|line|my\b)/i.test(n); }))return null;
  return names;
}
// where his list lives: the newest grocery task that has one (a new one each order, so done ones count),
// else the newest open grocery task
const groceryTask=function(){
  const g=state.tasks.filter(isGroceryTask).sort(function(a,b){ return (b.created||0)-(a.created||0); });
  return g.find(function(x){ return normList(x.list).length; })||g.find(function(x){ return !x.done; })||null;
};
// flag them on his grocery task (added if they're new), for the next order. → {task, names}, or null
function addToGroceries(text){
  const names=outOfNames(text), t=groceryTask();
  if(!names||!t)return null;
  const list=normList(t.list);
  names.forEach(function(n){
    const hit=list.find(function(x){ return sameItem(x.name,n)||sameItem(x.name.split(',')[0],n); });
    if(hit)hit.out=true; else list.push({name:n.charAt(0).toUpperCase()+n.slice(1),every:1,last:null,out:true});
  });
  t.list=list; touch();
  return {task:t,names:names};
}

/* ── the 2-week grocery order ──
   Every 2 weeks the desktop opens a new "Groceries" task on its own: Romulus builds the order from his
   list and shows it as picture cards, his items selected and a few ideas to add. Asking for groceries
   himself ("order groceries", "can I get groceries", "EBT") starts the 2 weeks over. The timer needs
   nothing stored: it counts from the latest ask, which the tasks already hold. */
const GROCERY_EVERY=14*24*3600*1000;
function lastGroceryAsk(){
  let last=0;
  state.tasks.forEach(function(t){
    if(taskWs(t)!=='agent')return;
    if(GROCERY_WORDS.test(t.title))last=Math.max(last,t.created||0);
    (Array.isArray(t.history)?t.history:[]).forEach(function(h){ if(h.who==='you'&&GROCERY_WORDS.test(String(h.text||'')))last=Math.max(last,h.at||0); });
  });
  return last;
}
const nextGroceryAt=function(){ const l=lastGroceryAsk(); return l?l+GROCERY_EVERY:null; };
// desktop only (it runs Romulus), like runDueRepeats
function runGroceryTimer(){
  if(!window.desktop||!window.desktop.onAgentResults)return;
  const at=nextGroceryAt();
  if(!at||at>Date.now())return;
  const open=state.tasks.filter(function(t){ return isGroceryTask(t)&&!t.done; });
  if(open.some(function(t){ return t.status==='queued'||t.status==='working'; }))return; // one is already going
  open.forEach(function(t){ t.done=true; agentSay(t,'sys','Replaced by the next 2-week order'); }); // a stale cart
  const keep=groceryTask();
  const t={id:uid(),title:'Groceries',done:false,due:null,dueTime:null,tag:null,ws:'agent',subs:[],googleEventId:null,
    created:Date.now(),status:'queued',note:null,reply:null,options:null,history:[],repeatDue:true};
  if(keep&&keep.list)t.list=normList(keep.list);
  agentSay(t,'sys','2-week grocery order');
  state.tasks.push(t);
  touch();
}
if(window.desktop&&window.desktop.onAgentResults){ setTimeout(runGroceryTimer,15*1000); setInterval(runGroceryTimer,60*1000); }
// one line in a grocery task's panel: when the next order opens
function groceryNextLine(){
  const at=nextGroceryAt();
  const d=el('div','panel-meta grocery-next');
  d.appendChild(el('span','lbl','Next order'));
  d.appendChild(el('span','next',at&&at<=Date.now()?'Opening now (once the computer is on)':at?new Date(at).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})+' · asking for groceries starts the 2 weeks over':'2 weeks after you ask for groceries'));
  return d;
}

// the agent asked for a yes ("Reply yes to place this order"): one tap answers it
function wantsYes(t){
  if(taskWs(t)!=='agent'||t.done||t.status!=='needs-you')return false;
  const last=(Array.isArray(t.history)?t.history:[]).filter(function(h){ return h.who==='claude'; }).slice(-1)[0];
  return !!last&&/reply\s*\**\s*yes/i.test(String(last.text||''));
}
function yesButton(t){
  const b=el('button','btn-accent agent-yes',/order/i.test(t.note||'')?'Yes, place the order':'Yes');
  b.title='Answer yes to exactly what Romulus described above';
  b.addEventListener('click',function(e){
    e.stopPropagation();
    const lt=liveTask(t);
    lt.reply='yes'; agentSay(lt,'you','yes'); lt.status='queued';
    buzz('send'); touch();
  });
  return b;
}

/* ── the order, as a grid of pictures ──
   When Romulus has a cart ready (t.cart, sent with "Reply yes to place this order"), every item shows as
   a card, all selected. Tap a card to leave it out; the total follows. "Place order" answers yes, naming
   what to take out, so Romulus removes those and places it (groceries skill). What he left out is kept
   on the task (t.cartOff, by name) so it survives a re-render or a sync. */
function cartPrice(p){ const m=String(p||'').replace(/,/g,'').match(/\d+(\.\d+)?/); return m?Number(m[0]):0; }
function cartStrip(t){
  const box=el('div','cart-box');
  const items=t.cart.slice(0,100).filter(function(it){ return !it.suggested; }).concat(t.cart.slice(0,100).filter(function(it){ return it.suggested; })); // ideas for the week go last
  const off=function(){ return Array.isArray(liveTask(t).cartOff)?liveTask(t).cartOff:[]; };
  const head=el('div','cart-head'); box.appendChild(head);
  const strip=el('div','cart-strip'); box.appendChild(strip);
  const foot=el('div','cart-foot'); box.appendChild(foot);
  const all=el('button','cart-all','Reset'); foot.appendChild(all);
  const go=el('button','btn-accent agent-yes'); foot.appendChild(go);
  const sync=function(){
    const o=off();
    const kept=items.filter(function(it){ return o.indexOf(it.name)===-1; });
    const total=kept.reduce(function(s,it){ return s+cartPrice(it.price); },0);
    const base=items.filter(function(it){ return !it.suggested; }).length, ideas=items.length-base, picked=kept.filter(function(it){ return it.suggested; }).length;
    head.textContent='Your order · '+kept.length+' items'+(ideas?' ('+picked+' of '+ideas+' ideas added)':'')+(total?' · about $'+total.toFixed(2):'');
    all.hidden=o.slice().sort().join('|')===startOff().sort().join('|'); // as Romulus set it: nothing to reset
    go.disabled=!kept.length;
    go.textContent=!kept.length?'Nothing selected':o.length?'Place order ('+kept.length+' items)':'Yes, place the order';
    strip.querySelectorAll('.cart-card').forEach(function(c){ const on=o.indexOf(c.dataset.name)===-1; c.classList.toggle('off',!on); c.setAttribute('aria-pressed',String(on)); });
  };
  items.forEach(function(it){
    const c=el('button','cart-card'+(it.suggested?' sugg':'')); c.dataset.name=it.name;
    c.title=it.suggested?'Suggested for this week'+(it.why?': '+it.why:'')+'. Tap to add it to the order':'Tap to leave this out of the order (tap again to put it back)';
    if(it.suggested)c.appendChild(el('span','cart-tag','idea'));
    const pic=el('div','cart-pic');
    if(it.image&&/^https:\/\//i.test(String(it.image))){ const im=document.createElement('img'); im.src=it.image; im.alt=''; im.loading='lazy'; im.referrerPolicy='no-referrer'; im.addEventListener('error',function(){ im.remove(); pic.textContent=it.name.charAt(0); }); pic.appendChild(im); }
    else pic.textContent=it.name.charAt(0);
    c.appendChild(pic);
    c.appendChild(el('span','cart-check','✓'));
    c.appendChild(el('div','cart-name',it.name));
    const bits=[(it.qty&&it.qty>1)?'×'+it.qty:'',it.price||'',it.unit||''].filter(Boolean);
    if(bits.length)c.appendChild(el('div','cart-meta',bits.join(' · ')));
    if(it.swap)c.appendChild(el('div','cart-swap','swap for '+it.swap));
    if(it.why)c.appendChild(el('div','cart-why',it.why));
    c.addEventListener('click',function(e){
      e.stopPropagation();
      const lt=liveTask(t), o=off().slice(), i=o.indexOf(it.name);
      if(i===-1)o.push(it.name); else o.splice(i,1);
      lt.cartOff=o; buzz('tap'); sync(); touch();
    });
    strip.appendChild(c);
  });
  const startOff=function(){ return items.filter(function(it){ return it.suggested; }).map(function(it){ return it.name; }); };
  all.addEventListener('click',function(e){ e.stopPropagation(); liveTask(t).cartOff=startOff(); sync(); touch(); });
  go.addEventListener('click',function(e){
    e.stopPropagation();
    const lt=liveTask(t), o=off().filter(function(n){ return items.some(function(it){ return it.name===n; }); });
    const kept=items.length-o.length;
    const total=items.filter(function(it){ return o.indexOf(it.name)===-1; }).reduce(function(s,it){ return s+cartPrice(it.price); },0);
    const dropped=o.filter(function(n){ return items.some(function(it){ return it.name===n&&!it.suggested; }); });
    const skipped=o.filter(function(n){ return dropped.indexOf(n)===-1; });
    const added=items.filter(function(it){ return it.suggested&&o.indexOf(it.name)===-1; }).map(function(it){ return it.name; });
    const parts=[];
    if(dropped.length)parts.push('without: '+dropped.join('; '));
    if(skipped.length)parts.push('and take out the ideas I didn’t pick: '+skipped.join('; '));
    if(added.length)parts.push('keeping the ideas: '+added.join('; '));
    const msg=o.length||added.length?'yes, place it '+parts.join(', ')+' ('+kept+' items'+(total?', about $'+total.toFixed(2):'')+')':'yes';
    lt.reply=msg; agentSay(lt,'you',msg); lt.status='queued';
    buzz('send'); touch();
  });
  sync();
  return box;
}
