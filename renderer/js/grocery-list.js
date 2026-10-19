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
  open.forEach(function(t){ t.done=true; delete t.cart; delete t.cartOff; delete t.cartPick; agentSay(t,'sys','Replaced by the next 2-week order'); }); // a stale cart
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

// the agent asked for a yes ("Reply yes to place this order"): one tap answers it. An order it's waiting
// on (even for something else first, like "add your EBT card, then reply done") always shows its items
function asksYes(t){
  const last=(Array.isArray(t.history)?t.history:[]).filter(function(h){ return h.who==='claude'; }).slice(-1)[0];
  return !!last&&/reply\s*\**\s*yes/i.test(String(last.text||''));
}
function wantsYes(t){
  if(taskWs(t)!=='agent'||t.done||t.status!=='needs-you')return false;
  return asksYes(t)||(Array.isArray(t.cart)&&t.cart.length>0);
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
   on the task (t.cartOff, by name) so it survives a re-render or a sync. When Romulus is waiting on
   something else first ("add a payment method, then reply done"), the button answers "done" with the
   same picks instead, so it fixes the cart before asking for the yes. An item with other sizes/brands
   (it.options) has a menu on its card: what he switches to goes along as "swap: A → B". */
// an order that went through (or he checked off): what he kept on it, with pictures, is his last order.
// Claude shows it when he asks what's on his list (agent/grocery.js lastOrderFor). The last dozen stay in
// t.orders, with the store and total, so the Finance tab can show what a charge was for (order-match.js).
// note: what Romulus said about it (its total), when t.note has already moved on
function keepLastOrder(t,note){
  if(!Array.isArray(t.cart)||!t.cart.length)return;
  const off=Array.isArray(t.cartOff)?t.cartOff:[], pick=t.cartPick&&typeof t.cartPick==='object'?t.cartPick:{};
  const items=t.cart.filter(function(it){ return off.indexOf(it.name)===-1; }).slice(0,40).map(function(it){
    const op=pick[it.name]&&Array.isArray(it.options)&&it.options.find(function(o){ return o.name===pick[it.name]; }); // the size he switched to
    const s=op||it;
    return {name:s.name,qty:s.qty||undefined,price:s.price||undefined,image:s.image||undefined,url:s.url||undefined};
  });
  if(!items.length)return;
  t.lastOrder={at:Date.now(),items:items};
  const total=orderTotalFrom(note)||orderTotalFrom(t.note), store=orderStore(items,t.title);
  t.orders=(Array.isArray(t.orders)?t.orders:[]).concat([Object.assign({},t.lastOrder,total?{total:total}:{},store?{store:store}:{})]).slice(-12);
}
// the list cards after a change on his list: removed items go, added ones get a card (a letter until they're bought)
function listCardsChanged(cards,ch){
  const gone=Array.isArray(ch.remove)?ch.remove:[];
  const has=function(n){ return function(c){ return sameItem(c.name,n)||sameItem(c.name.split(',')[0],n)||sameItem(c.name,String(n).split(',')[0]); }; };
  const out=cards.filter(function(c){ return !gone.some(function(n){ return has(n)(c); }); });
  (Array.isArray(ch.add)?ch.add:[]).forEach(function(a){ const n=String(a&&a.name||a||'').trim(); if(n&&!out.some(has(n)))out.push({name:n.slice(0,120)}); });
  return out.length?out:null;
}
// things to look at, not pick (his grocery list): small picture cards, each opening its product page
function cardsStrip(t){
  const box=el('div','mini-cards');
  t.cards.slice(0,40).forEach(function(it){
    const c=el(it.url?'a':'div','mini-card');
    if(it.url){ c.href=it.url; c.target='_blank'; c.rel='noopener'; c.title='Open '+it.name; }
    c.addEventListener('click',function(e){ e.stopPropagation(); });
    const ph=el('div','mini-pic');
    if(it.image){ const im=document.createElement('img'); im.src=it.image; im.alt=''; im.loading='lazy'; im.referrerPolicy='no-referrer';
      im.onerror=function(){ ph.textContent=it.name.charAt(0); im.remove(); }; ph.appendChild(im); }
    else ph.textContent=it.name.charAt(0);
    c.appendChild(ph);
    c.appendChild(el('div','mini-name',it.name));
    if(it.price||it.qty>1)c.appendChild(el('div','mini-price',(it.qty>1?'×'+it.qty+' · ':'')+(it.price||'')));
    box.appendChild(c);
  });
  return box;
}
function cartPrice(p){ const m=String(p||'').replace(/,/g,'').match(/\d+(\.\d+)?/); return m?Number(m[0]):0; }
function cartStrip(t){
  const box=el('div','cart-box');
  const items=t.cart.slice(0,100).filter(function(it){ return !it.suggested; }).concat(t.cart.slice(0,100).filter(function(it){ return it.suggested; })); // ideas for the week go last
  const off=function(){ return Array.isArray(liveTask(t).cartOff)?liveTask(t).cartOff:[]; };
  // his switches to another size/brand Romulus found (t.cartPick: item name → option name)
  const picks=function(){ const p=liveTask(t).cartPick; return p&&typeof p==='object'?p:{}; };
  const shown=function(it){ // what this card stands for now: Romulus's pick, or the option he switched to
    const n=picks()[it.name], op=n&&Array.isArray(it.options)&&it.options.find(function(x){ return x.name===n; });
    return op?Object.assign({},it,{name:op.name,qty:op.qty||1,price:op.price,unit:op.unit,image:op.image,url:op.url,swap:null,picked:true}):it;
  };
  const head=el('div','cart-head'); box.appendChild(head);
  const strip=el('div','cart-strip'); box.appendChild(strip);
  const foot=el('div','cart-foot'); box.appendChild(foot);
  const all=el('button','cart-all','Reset'); foot.appendChild(all);
  const go=el('button','btn-accent agent-yes'); foot.appendChild(go);
  const sync=function(){
    const o=off();
    const kept=items.filter(function(it){ return o.indexOf(it.name)===-1; });
    const total=kept.reduce(function(s,it){ return s+cartPrice(shown(it).price); },0);
    const base=items.filter(function(it){ return !it.suggested; }).length, ideas=items.length-base, picked=kept.filter(function(it){ return it.suggested; }).length;
    head.textContent='Your order · '+kept.length+' items'+(ideas?' ('+picked+' of '+ideas+' ideas added)':'')+(total?' · about $'+total.toFixed(2):'');
    all.hidden=o.slice().sort().join('|')===startOff().sort().join('|')&&!Object.keys(picks()).length; // as Romulus set it: nothing to reset
    go.disabled=!kept.length;
    go.textContent=!kept.length?'Nothing selected':!asksYes(t)?'Done, use these '+kept.length+' items':o.length?'Place order ('+kept.length+' items)':'Yes, place the order';
    go.title=asksYes(t)?'':'Tell Romulus you did what it asked, and which items to keep';
    strip.querySelectorAll('.cart-card').forEach(function(c){ const on=o.indexOf(c.dataset.name)===-1; c.classList.toggle('off',!on); c.setAttribute('aria-pressed',String(on)); });
  };
  // a card is a div (it holds the options menu, which can't sit inside a button); tap or Enter toggles it
  const draw=function(c,it){
    const s=shown(it); c.innerHTML='';
    if(it.suggested)c.appendChild(el('span','cart-tag','idea'));
    const pic=el('div','cart-pic');
    if(s.image&&/^https:\/\//i.test(String(s.image))){ const im=document.createElement('img'); im.src=s.image; im.alt=''; im.loading='lazy'; im.referrerPolicy='no-referrer'; im.addEventListener('error',function(){ im.remove(); pic.textContent=s.name.charAt(0); }); pic.appendChild(im); }
    else pic.textContent=s.name.charAt(0);
    c.appendChild(pic);
    c.appendChild(el('span','cart-check','✓'));
    c.appendChild(el('div','cart-name',s.name));
    const bits=[(s.qty&&s.qty>1)?'×'+s.qty:'',s.price||'',s.unit||''].filter(Boolean);
    if(bits.length)c.appendChild(el('div','cart-meta',bits.join(' · ')));
    if(s.swap)c.appendChild(el('div','cart-swap','swap for '+s.swap));
    if(s.picked)c.appendChild(el('div','cart-swap','your pick (Romulus picked '+it.name+')'));
    else if(s.why)c.appendChild(el('div','cart-why',s.why));
    if(Array.isArray(it.options)&&it.options.length){
      const sel=el('select','cart-opt'); sel.title='Other sizes and brands Romulus found';
      sel.setAttribute('aria-label','Options for '+it.name);
      [it].concat(it.options).forEach(function(op,i){
        const o=el('option',null,(i?'':'★ ')+(op.qty>1?op.qty+'× ':'')+op.name+(op.price?' · '+op.price:'')+(op.unit?' ('+op.unit+')':''));
        o.value=i?op.name:''; sel.appendChild(o);
      });
      sel.value=s.picked?s.name:'';
      const stop=function(e){ e.stopPropagation(); };
      sel.addEventListener('click',stop); sel.addEventListener('keydown',stop);
      sel.addEventListener('change',function(e){
        e.stopPropagation();
        const lt=liveTask(t), p=Object.assign({},picks());
        if(sel.value)p[it.name]=sel.value; else delete p[it.name];
        lt.cartPick=p; buzz('tap'); draw(c,it); sync(); touch();
      });
      c.appendChild(el('div','cart-opt-n',it.options.length+' other option'+(it.options.length>1?'s':'')));
      c.appendChild(sel);
    }
  };
  items.forEach(function(it){
    const c=el('div','cart-card'+(it.suggested?' sugg':'')); c.dataset.name=it.name;
    c.setAttribute('role','button'); c.tabIndex=0;
    c.title=it.suggested?'Suggested for this week'+(it.why?': '+it.why:'')+'. Tap to add it to the order':'Tap to leave this out of the order (tap again to put it back)';
    draw(c,it);
    const toggle=function(e){
      e.stopPropagation();
      const lt=liveTask(t), o=off().slice(), i=o.indexOf(it.name);
      if(i===-1)o.push(it.name); else o.splice(i,1);
      lt.cartOff=o; buzz('tap'); sync(); touch();
    };
    c.addEventListener('click',toggle);
    c.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(e); } });
    strip.appendChild(c);
  });
  const startOff=function(){ return items.filter(function(it){ return it.suggested; }).map(function(it){ return it.name; }); };
  all.addEventListener('click',function(e){ e.stopPropagation(); const lt=liveTask(t); lt.cartOff=startOff(); delete lt.cartPick;
    strip.querySelectorAll('.cart-card').forEach(function(c){ const it=items.find(function(x){ return x.name===c.dataset.name; }); if(it)draw(c,it); });
    sync(); touch(); });
  go.addEventListener('click',function(e){
    e.stopPropagation();
    const lt=liveTask(t), o=off().filter(function(n){ return items.some(function(it){ return it.name===n; }); });
    const kept=items.length-o.length;
    const total=items.filter(function(it){ return o.indexOf(it.name)===-1; }).reduce(function(s,it){ return s+cartPrice(shown(it).price); },0);
    const swaps=items.filter(function(it){ return o.indexOf(it.name)===-1&&shown(it).picked; }).map(function(it){ const s=shown(it); return it.name+' → '+(s.qty>1?s.qty+'× ':'')+s.name; });
    const dropped=o.filter(function(n){ return items.some(function(it){ return it.name===n&&!it.suggested; }); });
    const skipped=o.filter(function(n){ return dropped.indexOf(n)===-1; });
    const added=items.filter(function(it){ return it.suggested&&o.indexOf(it.name)===-1; }).map(function(it){ return it.name; });
    const parts=[];
    if(dropped.length)parts.push('without: '+dropped.join('; '));
    if(skipped.length)parts.push('and take out the ideas I didn’t pick: '+skipped.join('; '));
    if(added.length)parts.push('keeping the ideas: '+added.join('; '));
    if(swaps.length)parts.push('swap: '+swaps.join('; '));
    const changed=o.length||added.length||swaps.length;
    const count=' ('+kept+' items'+(total?', about $'+total.toFixed(2):'')+')';
    const msg=!asksYes(t)?'done, '+(changed?'and update the cart, '+parts.join(', '):'keep the cart as it is')+count
      :changed?'yes, place it '+parts.join(', ')+count:'yes';
    lt.reply=msg; agentSay(lt,'you',msg); lt.status='queued';
    buzz('send'); touch();
  });
  sync();
  return box;
}
