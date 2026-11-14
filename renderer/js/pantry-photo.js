/* Pantry photos (the Kitchen tab, kitchen-photo.js): what one picture is asked, and how the answer is read.
   - 'food': groceries he's putting away, or the receipt for them. The answer is the food in the picture (or on
     the receipt, spelled out) with a rough amount each; he ticks off what to add before anything goes in.
   - 'shop': something to buy more of: a handwritten or typed shopping list, an empty package, a recipe, a
     screenshot. The answer is what to buy, shaped like 'food'; he ticks what goes on the shopping list.
   Both of those also say when the picture let them down: retake (nothing could be read: why, so he takes it
   again) or more (some of it read, the rest hidden, turned away or cut off: what another picture should show,
   like the back of a package). The page shows a Retake button, or the list with a Take another picture button
   whose picture joins the list (kitchen-photo.js). pantryPhotoResult turns a parsed answer into what the page gets.
   - 'meal': a plate of food he made, or what he typed he made (said, no picture). The answer is which pantry foods it used and about how much for that
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

/* said: what he typed he made ("chicken and rice", "2 eggs and toast"), asked with no picture */
function pantryPhotoPrompt(mode,pantry,said){
  if(mode==='meal'&&said){
    return 'One person just made this at home, in his own words: "'+ppClean(said,300)+'". Work out which foods '+
      'from his pantry went into it and about how much, for one serving unless he says more.\n'+
      '- Use the pantry names exactly as written below. Leave out salt, pepper, water and oil, and anything '+
      'not in the pantry.\n'+
      '- Amounts are short and shopping-style: "6 oz", "1 cup", "2" (for eggs, tortillas, slices). Use his '+
      'amount when he gives one, otherwise a usual serving. Use the same kind of unit the pantry uses for that '+
      'food when you can.\n'+
      '- sure is true only when he named that food, or it is plainly the main part of the dish he named. A '+
      'sauce, spice or side you are guessing at is sure: false.\n'+
      '- meal is a short name for the dish, plain words, no emoji.\n'+
      'Answer with ONLY a JSON object, no other words and no code fence:\n'+
      '{"meal":"...","used":[{"name":"<pantry name>","amount":"...","sure":true}]}\n\n'+
      '## His pantry\n'+ppPantryLines(pantry);
  }
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
  if(mode==='shop'){
    return 'Someone wants to add to their shopping list from this picture. It may be a handwritten or typed '+
      'shopping list, an empty or nearly empty package, a recipe or ingredient list, a screenshot of a product, '+
      'or a shelf or fridge with gaps. List each thing to buy.\n'+
      '- name: short and plain, the way it goes on a shopping list: "eggs", "paper towels", "whole milk". No '+
      'brand names unless the brand is the point (a specific product in a screenshot), no emoji. Household '+
      'things like soap or paper towels count too.\n'+
      '- amount: only when the picture says one ("2 lb", "3 cans", "1 gal", "12"). Empty otherwise.\n'+
      '- For a recipe, list its ingredients, leaving out salt, pepper, water and oil. For a list, keep its order, '+
      'and skip a word you can\'t read rather than guess. Leave out crossed-off lines.\n'+
      ppUnclearRule('the list is out of focus, or it is so far away the words can\'t be made out',
        'Too blurry to read the words. Hold the phone still, closer to the list.',
        'the bottom of the list is cut off, a line is covered by a thumb, a package\'s name is on the side facing away',
        'The last few lines are cut off at the bottom. Take another picture of the end of the list.')+
      'Answer with ONLY a JSON object, no other words and no code fence:\n'+
      '{"items":[{"name":"...","amount":"..."}],"retake":"","more":""}';
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
    ppUnclearRule('it is too dark, blurry or far away to make out any food or any line of the receipt',
      'Too dark to read the labels. Take it again with the light on.',
      'labels turned away from the camera, food hidden behind other food, the bottom of the receipt cut off, '+
      'a size you can\'t see because it is printed on the back of the package',
      'The two cans at the back have their labels turned away. Take another picture with the labels facing you.')+
    'Answer with ONLY a JSON object, no other words and no code fence:\n'+
    '{"items":[{"name":"...","amount":"..."}],"retake":"","more":""}\n'+
    (have?'\n## His pantry\n'+ppPantryLines(pantry):'');
}
/* the rule, for food and shop, on a picture that let it down: retake when nothing could be read, more when some
   of it could and the rest needs another picture. bad/badSay: when to retake and an example; part/partSay: the
   same for more */
function ppUnclearRule(bad,badSay,part,partSay){
  return '- If '+bad+', items is empty and retake is one short sentence to the person holding the camera: what '+
    'was wrong and how to take it again ("'+badSay+'").\n'+
    '- If you can read some of it but part of it can\'t be read ('+part+'), list what you can read and make more '+
    'one short sentence saying what another picture should show ("'+partSay+'"). Only when something is plainly '+
    'unreadable, not to double-check what you read.\n'+
    '- Otherwise retake and more are empty strings.\n';
}

// the first {...} in an answer, parsed; null when there's none
function ppPickJson(text){
  const t=String(text||''), a=t.indexOf('{'), b=t.lastIndexOf('}');
  if(a<0||b<=a)return null;
  try{ const j=JSON.parse(t.slice(a,b+1)); return j&&typeof j==='object'?j:null; }catch(e){ return null; }
}

/* the AI's text → 'food' and 'shop': {items:[{name, amount}], retake, more}; 'meal': {meal, used:[{name, amount, sure}]}.
   No repeats, at most 40; an empty list when the answer is unusable. retake and more are the AI's one sentence
   each about the picture, or '' (a sentence that only says the picture is fine counts as none). */
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
  return mode==='meal'?{meal:ppClean(j.meal,80),used:list}:{items:list,retake:ppSentence(j.retake),more:ppSentence(j.more)};
}
// the AI's sentence about the picture, or '' for none, null, "none", "n/a", "no" and the like
function ppSentence(v){
  const s=typeof v==='string'?ppClean(v,200):'';
  return /^(none|n\/?a|no|null|nothing|-|ok|fine|clear)?\.?$/i.test(s)?'':s;
}

/* a parsed answer (and who gave it) → what the page gets. food and shop: {items, via} plus retake (nothing could
   be read: the AI's reason, or a plain one when it gave none, so a new picture is the next step) or more (what
   another picture should show, when something was read and something couldn't). meal: {meal, used, via}, or
   {why} when nothing matched. */
function pantryPhotoResult(mode,out,via){
  via=via||'The AI';
  if(mode==='meal')return out.used.length?{meal:out.meal,used:out.used,via:via}:{why:via+' couldn’t match that meal to anything in the pantry.'};
  if(!out.items.length)return {items:[],via:via,
    retake:out.retake||(mode==='shop'?via+' didn’t see anything to buy in that picture.':via+' didn’t see any food in that picture or receipt.')};
  return {items:out.items,via:via,more:out.more||out.retake||''}; // a retake beside a list it still read is a more
}

if(typeof module!=='undefined'&&module.exports)module.exports={prompt:pantryPhotoPrompt,parse:pantryPhotoParse,result:pantryPhotoResult};
