/* Pantry photos (the Kitchen tab, kitchen-photo.js): what one picture is asked, and how the answer is read.
   - 'food': groceries he's putting away, or the receipt for them. The answer is the food in the picture (or on
     the receipt, spelled out) with a rough amount each; he ticks off what to add before anything goes in.
   - 'meal': a plate of food he made. The answer is which pantry foods it used and about how much for that
     plate, each marked sure or not. The page takes the sure ones out and asks him about the rest in a to-do.
   Shared by the computer (main/kitchen-ai.js requires it: Lupa first, then his cloud AIs) and the phone, which
   asks with its own copy of his AI keys (phone-ai.js). A page script, so no require here, and every top-level
   name starts with pp or pantryPhoto. */
'use strict';

const ppClean=function(s,n){ return String(s==null?'':s).replace(/\p{Extended_Pictographic}\u{FE0F}?/gu,'').replace(/\s+/g,' ').trim().slice(0,n||80); };
const ppAmt=function(x){ return x.qty!=null?x.qty+(x.unit?' '+x.unit:'')+' ':''; };
const ppPantryLines=function(pantry){
  return (pantry||[]).filter(function(x){ return x&&ppClean(x.name); }).slice(0,300)
    .map(function(x){ return '- '+ppAmt(x)+ppClean(x.name); }).join('\n')||'(empty)';
};

function pantryPhotoPrompt(mode,pantry){
  if(mode==='meal'){
    return 'The picture is a meal one person just made at home and is about to eat. Work out which foods from '+
      'his pantry went into it and about how much, for what is on the plate.\n'+
      '- Use the pantry names exactly as written below. Leave out salt, pepper, water and oil, and anything '+
      'not in the pantry.\n'+
      '- Amounts are short and shopping-style: "6 oz", "1 cup", "2" (for eggs, tortillas, slices). Use the '+
      'same kind of unit the pantry uses for that food when you can.\n'+
      '- sure is true only when the food is plainly visible in the picture. A sauce, spice or ingredient you '+
      'are guessing at is sure: false.\n'+
      '- meal is a short name for the dish, plain words, no emoji.\n'+
      'Answer with ONLY a JSON object, no other words and no code fence:\n'+
      '{"meal":"...","used":[{"name":"<pantry name>","amount":"...","sure":true}]}\n\n'+
      '## His pantry\n'+ppPantryLines(pantry);
  }
  const have=(pantry||[]).filter(function(x){ return x&&ppClean(x.name); }).length;
  return 'The picture is one of two things. Either food someone is putting away at home (groceries, a fridge '+
    'shelf, a cupboard), or a store receipt for groceries they just bought (paper, or a screenshot of an order). '+
    'List each food or drink in it.\n'+
    '- name: short and plain, the way it goes on a shopping list: "eggs", "chicken breast", "black beans", '+
    '"whole milk". No brand names, no emoji.'+(have?' When it is a food already in his pantry (listed below), use '+
    'that exact name.':'')+'\n'+
    '- amount: what you can see or read on the package: "12" for a dozen eggs, "2 lb", "1 gal", "3 cans", '+
    '"16 oz". Empty when you can\'t tell.\n'+
    '- On a receipt, store lines are shortened, so spell them out: "GV WHL MLK GAL" is whole milk, 1 gal; '+
    '"BNLS SKNLS CHKN BRST" is chicken breast. A line bought more than once ("2 @ 1.98", "QTY 3") is one item '+
    'with that count ("2", or "2 cans"); a weighed line ("1.32 lb @ 0.58/lb") uses that weight. Leave out prices, '+
    'tax, totals, coupons, savings, bag fees, deposits, the store name and payment lines. Skip a line you can\'t '+
    'read rather than guess.\n'+
    '- Leave out things that are not food or drink (bags, paper towels, cleaning products, medicine) and salt, '+
    'pepper, water and oil.\n'+
    'Answer with ONLY a JSON object, no other words and no code fence:\n'+
    '{"items":[{"name":"...","amount":"..."}]}\n'+
    (have?'\n## His pantry\n'+ppPantryLines(pantry):'');
}

// the first {...} in an answer, parsed; null when there's none
function ppPickJson(text){
  const t=String(text||''), a=t.indexOf('{'), b=t.lastIndexOf('}');
  if(a<0||b<=a)return null;
  try{ const j=JSON.parse(t.slice(a,b+1)); return j&&typeof j==='object'?j:null; }catch(e){ return null; }
}

/* the AI's text → 'food': {items:[{name, amount}]}; 'meal': {meal, used:[{name, amount, sure}]}.
   No repeats, at most 40; an empty list when the answer is unusable. */
function pantryPhotoParse(mode,text){
  const j=ppPickJson(text)||{}, seen=new Set(), raw=mode==='meal'?j.used:j.items;
  const list=(Array.isArray(raw)?raw:[]).map(function(x){
    if(typeof x==='string')x={name:x};
    if(!x||typeof x!=='object')return null;
    const name=ppClean(x.name).replace(/^[-*\s]+/,''), amount=ppClean(x.amount,30);
    if(!name)return null;
    const k=name.toLowerCase(); if(seen.has(k))return null; seen.add(k);
    return mode==='meal'?{name:name,amount:amount,sure:x.sure!==false&&x.sure!=='false'}:{name:name,amount:amount};
  }).filter(Boolean).slice(0,40);
  return mode==='meal'?{meal:ppClean(j.meal,80),used:list}:{items:list};
}

if(typeof module!=='undefined'&&module.exports)module.exports={prompt:pantryPhotoPrompt,parse:pantryPhotoParse};
