/* The Kitchen tab's "Plan your week" (top of Meals, kitchen.js kDrawMeals): one big cook on Sunday that covers
   Monday to Sunday, built by his AIs from the whole pantry and sized to his Food plan (main/kitchen-ai.js
   kitchen:week, agent/meal-prep.js). He picks which meals it covers (breakfast, lunch, dinner, snack). It shows the
   Sunday dishes (portions, numbers, where each keeps), each day's meals with the day's total against the plan, and
   what to buy, with a button that puts that on his grocery list. Desktop only, like Suggest meals.
   The week is kept on this device (localStorage) until he plans again.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists
   them. The top part has no DOM in it, so test/kitchen-week.test.js can load it in Node. */
'use strict';

const KWEEK_SLOTS=[['breakfast','Breakfast'],['lunch','Lunch'],['dinner','Dinner'],['snack','Snack']];
const KWEEK_DAYS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

// the Sunday the cook is on: today when it's Sunday, else the coming one → a Date at noon
function kWeekCookDay(now){
  const d=new Date(now); d.setHours(12,0,0,0);
  d.setDate(d.getDate()+(7-d.getDay())%7);
  return d;
}
// the cook day → the 7 days it covers: [{day:'Mon', label:'Mon Nov 16'}, ...]
function kWeekDays(cook){
  return KWEEK_DAYS.map(function(day,i){
    const d=new Date(cook); d.setDate(d.getDate()+1+i);
    return {day:day,label:day+' '+d.toLocaleDateString('en-US',{month:'short',day:'numeric'})};
  });
}
// a day's numbers next to the plan's: "1,850 kcal of 2,100 · 140 g protein of 160"
function kWeekSayTotal(total,plan){
  const t=total||{}, p=plan||{}, bits=[];
  [['kcal',' kcal'],['protein',' g protein'],['carbs',' g carbs'],['fat',' g fat']].forEach(function(x){
    if(t[x[0]]==null)return;
    const v=x[0]==='kcal'?t[x[0]].toLocaleString('en-US'):t[x[0]];
    bits.push(v+x[1]+(p[x[0]]?' of '+(x[0]==='kcal'?p[x[0]].toLocaleString('en-US'):p[x[0]]):''));
  });
  return bits.join(' · ');
}

if(typeof module!=='undefined'&&module.exports)module.exports={kWeekCookDay,kWeekDays,kWeekSayTotal};

/* ── the section (page only) ── */
const KWEEK_KEY='kitchen.week.v1', KWEEK_SLOTS_KEY='kitchen.week.slots.v1';
const kWeekUI={busy:false,why:''};
function kWeekLoad(k,dflt){ try{ const v=JSON.parse(localStorage.getItem(k)||'null'); return v==null?dflt:v; }catch(e){ return dflt; } }
function kWeekKeep(k,v){ try{ if(v==null)localStorage.removeItem(k); else localStorage.setItem(k,JSON.stringify(v)); }catch(e){} }
function kWeekSlots(){ const s=kWeekLoad(KWEEK_SLOTS_KEY,null); return Array.isArray(s)&&s.length?s:['breakfast','lunch','dinner']; }

/* box: where it goes. h: {items, recipes, plan, aim, redraw(), toGroceries(entries) → n or -1} */
function kWeekDraw(box,h){
  box.innerHTML='';
  if(!(window.desktop&&window.desktop.kitchenWeek))return;
  box.appendChild(el('div','kit-k kit-sec','Plan your week'));
  const cook=kWeekCookDay(Date.now()), saved=kWeekLoad(KWEEK_KEY,null), slots=kWeekSlots();
  const form=el('div','kit-form kit-week-form');
  const picks=el('div','kit-aim-chips kit-week-slots'); picks.setAttribute('role','group'); picks.setAttribute('aria-label','Meals to plan');
  KWEEK_SLOTS.forEach(function(x){
    const on=slots.indexOf(x[0])>=0, b=el('button','kit-aim-chip kit-week-slot'+(on?' on':''),x[1]);
    b.type='button'; b.setAttribute('role','checkbox'); b.setAttribute('aria-checked',String(on));
    b.addEventListener('click',function(){
      const now=kWeekSlots(), i=now.indexOf(x[0]);
      if(i>=0){ if(now.length>1)now.splice(i,1); } else now.push(x[0]);
      kWeekKeep(KWEEK_SLOTS_KEY,KWEEK_SLOTS.map(function(s){ return s[0]; }).filter(function(s){ return now.indexOf(s)>=0; }));
      kWeekDraw(box,h);
    });
    picks.appendChild(b);
  });
  form.appendChild(picks);
  const go=el('button','btn-accent',kWeekUI.busy?'Planning…':saved?'Plan again':'Plan my week');
  go.disabled=kWeekUI.busy||!h.items.length;
  go.addEventListener('click',async function(){
    if(kWeekUI.busy)return;
    kWeekUI.busy=true; kWeekUI.why=''; kWeekDraw(box,h);
    try{
      const r=await window.desktop.kitchenWeek({
        pantry:h.items.map(function(i){ return {name:i.name,qty:i.qty,unit:i.unit}; }),
        recipes:h.recipes.map(function(x){ return {name:x.name,liked:x.liked}; }),
        aim:h.aim, plan:h.plan, slots:kWeekSlots()});
      if(r&&r.week)kWeekKeep(KWEEK_KEY,{week:r.week,via:r.via||'',at:Date.now(),cook:cook.getTime()});
      else kWeekUI.why=(r&&r.why)||'No plan came back. Try again.';
    }catch(e){ kWeekUI.why='Couldn’t ask your AIs: '+(e&&e.message||e); }
    kWeekUI.busy=false; h.redraw();
  });
  form.appendChild(go);
  box.appendChild(form);
  if(!h.items.length){ box.appendChild(el('div','kit-empty','Add food under Pantry, then this plans a week of meal prep from all of it.')); return; }
  const cookSay=cook.toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
  box.appendChild(el('div','kit-hint','One cook on '+cookSay+' for Monday to Sunday, from your whole pantry'+
    (h.plan?', each day adding up to your Food plan.':'. Set a Food plan on the Health tab and each day adds up to it.')+
    (kWeekUI.busy?' This takes a minute.':'')));
  if(kWeekUI.why)box.appendChild(el('div','kit-empty',kWeekUI.why));
  if(!saved||!saved.week)return;
  const w=saved.week, days=kWeekDays(new Date(saved.cook||cook.getTime()));
  // Sunday: what to cook
  const sun=new Date(saved.cook||cook.getTime()).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  box.appendChild(el('div','kit-k kit-sec','Cook on '+sun));
  w.prep.forEach(function(d){
    const card=el('div','kit-card');
    const top=el('div','kit-card-top'); top.appendChild(el('span','kit-card-name',d.name)); card.appendChild(top);
    const bits=[]; if(d.portions)bits.push('Makes '+d.portions); if(d.portion)bits.push(d.portion);
    const nums=kWeekSayTotal({kcal:d.kcal,protein:d.protein,carbs:d.carbs,fat:d.fat},null); if(nums)bits.push(nums+' each');
    if(bits.length)card.appendChild(el('div','kit-card-sub',bits.join(' · ')));
    if(d.store)card.appendChild(el('div','kit-card-sub','Keeps: '+d.store));
    const more=document.createElement('details'); more.className='kit-idea-more';
    const sum=document.createElement('summary'); sum.textContent='Ingredients and steps'; more.appendChild(sum);
    more.appendChild(el('div','kit-card-sub',d.ingredients.join(', ')));
    if(d.steps.length){ const ol=document.createElement('ol'); ol.className='kit-idea-steps'; d.steps.forEach(function(s){ ol.appendChild(el('li','',s)); }); more.appendChild(ol); }
    card.appendChild(more);
    box.appendChild(card);
  });
  // the week, day by day
  box.appendChild(el('div','kit-k kit-sec','The week'));
  const grid=el('div','kit-card kit-week');
  w.days.forEach(function(d){
    const lab=(days.find(function(x){ return x.day===d.day; })||{label:d.day}).label;
    const row=el('div','kit-week-day');
    row.appendChild(el('div','kit-week-label',lab));
    const meals=el('div','kit-week-meals');
    d.meals.forEach(function(m){
      const line=el('div','kit-week-meal');
      line.appendChild(el('span','kit-week-slot-name',m.slot.charAt(0).toUpperCase()+m.slot.slice(1)));
      line.appendChild(el('span','',m.dish));
      meals.appendChild(line);
    });
    const tot=kWeekSayTotal(d.total,h.plan);
    if(tot)meals.appendChild(el('div','kit-card-meta',tot));
    row.appendChild(meals);
    grid.appendChild(row);
  });
  box.appendChild(grid);
  // what to buy
  if(w.buy.length){
    box.appendChild(el('div','kit-k kit-sec','To buy for this week'));
    const card=el('div','kit-card');
    const ul=document.createElement('ul'); ul.className='kit-week-buy';
    w.buy.forEach(function(b){ ul.appendChild(el('li','',b)); });
    card.appendChild(ul);
    const btns=el('div','kit-card-btns'), g=el('button','btn-accent','Add to grocery list');
    g.title='Put these on the Agent’s grocery list for the next order';
    g.addEventListener('click',function(){
      const n=h.toGroceries(w.buy.map(function(b){ return typeof parseIngredient==='function'?parseIngredient(b):null; }).filter(Boolean));
      voiceToast(n<0?'No grocery list yet: ask the Agent for groceries once.':n+' item'+(n===1?'':'s')+' on your grocery list for the next order');
    });
    btns.appendChild(g); card.appendChild(btns);
    box.appendChild(card);
  } else box.appendChild(el('div','kit-hint','Your pantry covers the whole week: nothing to buy.'));
  (w.notes||[]).forEach(function(n){ box.appendChild(el('div','kit-hint',n)); });
  if(saved.via)box.appendChild(el('div','kit-hint','Planned by '+saved.via+' on '+new Date(saved.at).toLocaleDateString('en-US',{month:'short',day:'numeric'})+'.'));
}
