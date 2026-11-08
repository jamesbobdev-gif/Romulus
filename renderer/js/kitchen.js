/* The Kitchen tab: what food he has (the pantry), the recipes he makes (and which ones he likes), meals he
   could make from what's there, and a shopping list for the meals he plans to make.
   "Made it" takes a recipe's ingredients out of the pantry; what runs out can go on his grocery list.
   What the Agent buys on a grocery order goes back into the pantry (grocery-list.js applyListUpdate).
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them.
   The top half has no DOM in it, so test/kitchen.test.js can load it in Node.

   state.kitchen = {items, recipes, tombstones}
     item:   {id, name, qty (number, or null = "some, amount not known"), unit, updatedAt}
     recipe: {id, name, ingredients:[{name, qty|null, unit}], liked, planned, made:['YYYY-MM-DD'], updatedAt}
   It syncs through its own row next to the personal list (syncKey+':kitchen'), merged like the Hours log:
   per id the newer updatedAt wins, a tombstone beats older copies. */
'use strict';

/* ── units ── */
const KITCHEN_UNITS={
  tsp:['tsp','tsps','teaspoon','teaspoons'], tbsp:['tbsp','tbsps','tbs','tablespoon','tablespoons'],
  cup:['cup','cups'], floz:['fl oz','fluid ounce','fluid ounces'], pt:['pt','pint','pints'], qt:['qt','quart','quarts'],
  gal:['gal','gallon','gallons'], ml:['ml','milliliter','milliliters','millilitre','millilitres'], l:['l','liter','liters','litre','litres'],
  oz:['oz','ounce','ounces'], lb:['lb','lbs','pound','pounds'], g:['g','gram','grams'], kg:['kg','kilogram','kilograms'],
  dozen:['dozen'], can:['can','cans'], clove:['clove','cloves'], pkg:['pkg','package','packages','pack','packs'],
  bag:['bag','bags'], box:['box','boxes'], jar:['jar','jars'], bottle:['bottle','bottles'], bunch:['bunch','bunches'],
  slice:['slice','slices'], stick:['stick','sticks'], head:['head','heads'], loaf:['loaf','loaves'], piece:['piece','pieces']
};
// how much of the family's base each unit is: volume in ml, weight in g, a count in ones
const KITCHEN_BASE={tsp:['v',4.929],tbsp:['v',14.787],cup:['v',236.59],floz:['v',29.574],pt:['v',473.18],qt:['v',946.35],gal:['v',3785.4],ml:['v',1],l:['v',1000],
  oz:['w',28.35],lb:['w',453.59],g:['w',1],kg:['w',1000],'':['n',1],dozen:['n',12]};
const KITCHEN_UNIT_OF=(function(){ const m={}; Object.keys(KITCHEN_UNITS).forEach(function(u){ KITCHEN_UNITS[u].forEach(function(a){ m[a]=u; }); }); return m; })();
function kUnit(s){ const k=String(s||'').toLowerCase().replace(/\.$/,'').trim(); return KITCHEN_UNIT_OF[k]||(k===''?'':null); }
// qty in `from` units as `to` units, or null when they can't be compared (a can against cups)
function kConvert(qty,from,to){
  from=from||''; to=to||'';
  if(from===to)return qty;
  const a=KITCHEN_BASE[from], b=KITCHEN_BASE[to];
  if(!a||!b||a[0]!==b[0])return null;
  return qty*a[1]/b[1];
}
const kRound=function(n){ return Math.round(n*100)/100; };
function kFmtQty(qty,unit){
  if(qty==null)return '';
  const whole=Math.floor(qty+1e-9), frac=kRound(qty-whole);
  const F={0.25:'1/4',0.33:'1/3',0.5:'1/2',0.67:'2/3',0.75:'3/4'};
  const n=F[frac]?(whole?whole+' ':'')+F[frac]:String(kRound(qty));
  return unit?n+' '+unit:n;
}

/* ── names ── "Large Eggs" and "egg" are the same food; "rice vinegar" isn't rice */
function kSingular(w){
  if(w.length>4&&/ies$/.test(w))return w.slice(0,-3)+'y';
  if(w.length>4&&/(ches|shes|xes|oes)$/.test(w))return w.slice(0,-2);
  if(w.length>3&&/s$/.test(w)&&!/(ss|us|is)$/.test(w))return w.slice(0,-1);
  return w;
}
function foodKey(s){
  return String(s||'').toLowerCase().replace(/\(.*?\)/g,' ').replace(/[^a-z0-9 ]+/g,' ').split(/\s+/).filter(Boolean).map(kSingular).join(' ');
}
function sameFood(a,b){
  const ka=foodKey(a), kb=foodKey(b);
  if(!ka||!kb)return false;
  if(ka===kb)return true;
  const wa=ka.split(' '), wb=kb.split(' ');
  const short=wa.length<=wb.length?wa:wb, long=short===wa?wb:wa;
  // the shorter name's words are all in the longer one, and they name the same thing (the last word)
  return short[short.length-1]===long[long.length-1]&&short.every(function(w){ return long.indexOf(w)!==-1; });
}
// always in the kitchen: never missing, never used up
const KITCHEN_STAPLES=['salt','pepper','black pepper','salt and pepper','water','ice'];
const isStaple=function(name){ const k=foodKey(name); return KITCHEN_STAPLES.some(function(s){ return foodKey(s)===k; }); };

/* "2 cups rice", "1 1/2 lb ground beef", "3 eggs", "1 onion, diced", "salt" → {name, qty|null, unit} */
const K_FRAC={'½':0.5,'¼':0.25,'¾':0.75,'⅓':1/3,'⅔':2/3,'⅛':0.125};
function kNum(s){
  s=String(s).trim();
  let m=/^(\d+)\s*([½¼¾⅓⅔⅛])$/.exec(s); if(m)return +m[1]+K_FRAC[m[2]];
  if(K_FRAC[s]!=null)return K_FRAC[s];
  m=/^(\d+)\s+(\d+)\/(\d+)$/.exec(s); if(m)return +m[1]+(+m[2])/(+m[3]||1);
  m=/^(\d+)\/(\d+)$/.exec(s); if(m)return (+m[1])/(+m[2]||1);
  return isFinite(+s)?+s:null;
}
function parseIngredient(line){
  let s=String(line||'').replace(/^\s*(?:[-*•]|\d+[.)])\s+/,'').trim();
  if(!s)return null;
  let qty=null, unit='';
  const m=/^(\d+\s*[½¼¾⅓⅔⅛]|[½¼¾⅓⅔⅛]|\d+\s+\d+\/\d+|\d+\/\d+|\d*\.\d+|\d+)(?:\s*-\s*\d+(?:\.\d+)?)?\s*/.exec(s); // "2-3 cloves": the first number
  if(m){
    qty=kNum(m[1]); s=s.slice(m[0].length);
    const two=/^([a-z]+\.?\s+[a-z]+\.?)\b\s*/i.exec(s), one=/^([a-z]+\.?)(?=\s|$)\s*/i.exec(s);
    if(two&&kUnit(two[1].replace(/\.\s*/,' '))){ unit=kUnit(two[1].replace(/\.\s*/,' ')); s=s.slice(two[0].length); }
    else if(one&&kUnit(one[1])&&s.slice(one[0].length).trim()){ unit=kUnit(one[1]); s=s.slice(one[0].length); }
    s=s.replace(/^of\s+/i,'');
  }
  const name=s.split(',')[0].replace(/\s+/g,' ').trim().slice(0,80);
  if(!name)return null;
  if(unit==='dozen'){ qty=qty*12; unit=''; }
  return {name:name,qty:qty!=null&&qty>0?kRound(qty):null,unit:unit};
}
const fmtIngredient=function(i){ return (i.qty!=null?kFmtQty(i.qty,i.unit)+' ':'')+i.name; };

/* ── the data ── */
function kItem(x){
  if(!x||!x.id||!String(x.name||'').trim())return null;
  const q=x.qty==null||x.qty===''?null:Number(x.qty);
  return {id:String(x.id),name:String(x.name).trim().slice(0,80),qty:q!=null&&isFinite(q)&&q>0?kRound(q):null,unit:kUnit(x.unit)||'',updatedAt:x.updatedAt||0};
}
function kRecipe(x){
  if(!x||!x.id||!String(x.name||'').trim())return null;
  const ings=(Array.isArray(x.ingredients)?x.ingredients:[]).map(function(i){
    if(typeof i==='string')return parseIngredient(i);
    if(!i||!String(i.name||'').trim())return null;
    const q=i.qty==null?null:Number(i.qty);
    return {name:String(i.name).trim().slice(0,80),qty:q!=null&&isFinite(q)&&q>0?kRound(q):null,unit:kUnit(i.unit)||''};
  }).filter(Boolean).slice(0,60);
  const made=(Array.isArray(x.made)?x.made:[]).filter(function(d){ return /^\d{4}-\d{2}-\d{2}$/.test(d); }).slice(-30);
  return {id:String(x.id),name:String(x.name).trim().slice(0,100),ingredients:ings,liked:!!x.liked,planned:!!x.planned,made:made,updatedAt:x.updatedAt||0};
}
function normKitchen(raw){
  const r=raw||{};
  return {
    items:(Array.isArray(r.items)?r.items:[]).map(kItem).filter(Boolean).slice(0,500),
    recipes:(Array.isArray(r.recipes)?r.recipes:[]).map(kRecipe).filter(Boolean).slice(0,500),
    tombstones:(Array.isArray(r.tombstones)?r.tombstones:[]).filter(function(t){ return t&&t.id; })
  };
}
function kitchenDoc(k){ return {v:1,items:k.items,recipes:k.recipes,tombstones:k.tombstones}; }
const kStable=function(v){ return Array.isArray(v)?'['+v.map(kStable).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(function(x){ return JSON.stringify(x)+':'+kStable(v[x]); }).join(',')+'}':JSON.stringify(v); };
const kCanon=function(k){ const by=function(a,b){ return a.id<b.id?-1:1; }; return kStable([k.items.slice().sort(by),k.recipes.slice().sort(by)]); };
// → {merged, changedLocal, changedRemote}
function mergeKitchenDocs(localRaw,remoteRaw,now){
  const local=normKitchen(localRaw), remote=normKitchen(remoteRaw);
  const tombs={};
  local.tombstones.concat(remote.tombstones).forEach(function(x){ if(!tombs[x.id]||x.deletedAt>tombs[x.id])tombs[x.id]=x.deletedAt; });
  const pick=function(a,b){
    const by={};
    a.concat(b).forEach(function(it){ const p=by[it.id]; if(!p||(it.updatedAt||0)>(p.updatedAt||0))by[it.id]=it; });
    return Object.keys(by).map(function(id){ return by[id]; }).filter(function(it){ return !(tombs[it.id]&&tombs[it.id]>=(it.updatedAt||0)); });
  };
  const cutoff=(now||Date.now())-60*86400000;
  const merged={items:pick(local.items,remote.items),recipes:pick(local.recipes,remote.recipes),
    tombstones:Object.keys(tombs).filter(function(id){ return tombs[id]>cutoff; }).map(function(id){ return {id:id,deletedAt:tombs[id]}; })};
  return {merged:merged,changedLocal:kCanon(merged)!==kCanon(local),
    changedRemote:kCanon(merged)!==kCanon(remote)||merged.tombstones.length!==remote.tombstones.length};
}

/* ── what he has ── */
const pantryFind=function(items,name){ return items.find(function(i){ return sameFood(i.name,name); })||null; };
// one ingredient against the pantry → {have, need?, unit?}. An amount he never put in counts as enough.
function ingredientStatus(items,ing){
  if(isStaple(ing.name))return {have:true};
  const p=pantryFind(items,ing.name);
  if(!p)return {have:false,need:ing.qty,unit:ing.unit};
  if(p.qty==null||ing.qty==null)return {have:true};
  const avail=kConvert(p.qty,p.unit,ing.unit);
  if(avail==null||avail+1e-9>=ing.qty)return {have:true};
  return {have:false,need:kRound(ing.qty-avail),unit:ing.unit};
}
/* every recipe with what's missing for it: the ones he can make now first, liked before the rest,
   then the one he made longest ago → [{recipe, missing:[{name, need, unit}]}] */
function suggestMeals(k){
  return k.recipes.filter(function(r){ return r.ingredients.length; }).map(function(r){
    const missing=[];
    r.ingredients.forEach(function(i){ const s=ingredientStatus(k.items,i); if(!s.have)missing.push({name:i.name,need:s.need,unit:s.unit}); });
    return {recipe:r,missing:missing};
  }).sort(function(a,b){
    return a.missing.length-b.missing.length||(b.recipe.liked-a.recipe.liked)||
      String(a.recipe.made.slice(-1)[0]||'').localeCompare(String(b.recipe.made.slice(-1)[0]||''))||a.recipe.name.localeCompare(b.recipe.name);
  });
}
/* He made it: take what it used out of the pantry. Something with no amount (or one that can't be compared)
   stays, and is listed so he can say whether it ran out → {used, ranOut, unsure, missing} (names) */
function cookRecipe(k,recipeId,now){
  now=now||Date.now();
  const r=k.recipes.find(function(x){ return x.id===recipeId; });
  const out={used:[],ranOut:[],unsure:[],missing:[]};
  if(!r)return out;
  r.ingredients.forEach(function(i){
    if(isStaple(i.name))return;
    const p=pantryFind(k.items,i.name);
    if(!p){ out.missing.push(i.name); return; }
    const use=i.qty==null||p.qty==null?null:kConvert(i.qty,i.unit,p.unit);
    if(use==null){ if(out.unsure.indexOf(p.name)===-1)out.unsure.push(p.name); return; }
    p.qty=kRound(p.qty-use); p.updatedAt=now;
    if(p.qty<=0.001){
      k.items=k.items.filter(function(x){ return x!==p; });
      k.tombstones.push({id:p.id,deletedAt:now});
      out.ranOut.push(p.name);
    } else out.used.push(p.name);
  });
  const d=new Date(now), day=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  r.made=r.made.concat([day]).slice(-30); r.planned=false; r.updatedAt=now;
  return out;
}
/* The shopping list for the meals on his plan: everything they need, added up across meals, less what's
   in the pantry → [{name, qty|null, unit, for:[recipe names]}] */
function shoppingList(k){
  const need=[];
  k.recipes.filter(function(r){ return r.planned; }).forEach(function(r){
    r.ingredients.forEach(function(i){
      if(isStaple(i.name))return;
      let e=need.find(function(x){ return sameFood(x.name,i.name); });
      if(!e){ e={name:i.name,qty:i.qty,unit:i.unit,for:[]}; need.push(e); }
      else if(i.qty!=null){
        const add=e.qty==null?null:kConvert(i.qty,i.unit,e.unit);
        if(e.qty==null){ e.qty=i.qty; e.unit=i.unit; }
        else if(add!=null)e.qty=kRound(e.qty+add);
      }
      if(e.for.indexOf(r.name)===-1)e.for.push(r.name);
    });
  });
  const out=[];
  need.forEach(function(e){
    const p=pantryFind(k.items,e.name);
    if(!p){ out.push(e); return; }
    if(p.qty==null||e.qty==null)return; // he has some: count it as enough
    const avail=kConvert(p.qty,p.unit,e.unit);
    if(avail==null||avail+1e-9>=e.qty)return;
    out.push(Object.assign({},e,{qty:kRound(e.qty-avail)}));
  });
  return out.sort(function(a,b){ return a.name.localeCompare(b.name); });
}
/* Groceries the Agent bought ("Rice, 20 lb", "Eggs") go into the pantry. A known size adds to what's there;
   with no size the amount isn't known any more, so it's just "some". → the names added */
function stockPantry(k,names,now,newId){
  now=now||Date.now();
  const added=[];
  (Array.isArray(names)?names:[]).forEach(function(n){
    const parts=String(n||'').split(','), base=parts[0].trim();
    if(!base)return;
    const size=parts.length>1?parseIngredient(parts.slice(1).join(',')+' x'):null; // "20 lb" → 20 lb (the x stands in for the name)
    const qty=size&&size.qty!=null?size.qty:null, unit=size&&size.qty!=null?size.unit:'';
    const p=pantryFind(k.items,base);
    if(!p){ k.items.push({id:newId(),name:base.slice(0,80),qty:qty,unit:unit,updatedAt:now}); added.push(base); return; }
    const more=qty==null||p.qty==null?null:kConvert(qty,unit,p.unit);
    p.qty=more==null?null:kRound(p.qty+more); p.updatedAt=now; added.push(p.name);
  });
  return added;
}

if(typeof module!=='undefined'&&module.exports){
  module.exports={parseIngredient:parseIngredient,kConvert:kConvert,sameFood:sameFood,foodKey:foodKey,normKitchen:normKitchen,
    mergeKitchenDocs:mergeKitchenDocs,ingredientStatus:ingredientStatus,suggestMeals:suggestMeals,cookRecipe:cookRecipe,
    shoppingList:shoppingList,stockPantry:stockPantry,kFmtQty:kFmtQty};
}

/* ══ the page ══ */
if(typeof document!=='undefined'){

const kitchenUI={view:'meals',editing:null,recipeFilter:'all',afterCook:null};
function kSave(){ persist(); renderKitchen(); }
function kTomb(id){ state.kitchen.tombstones.push({id:id,deletedAt:Date.now()}); }

/* ── sync: syncKey+':kitchen' next to the personal list ── */
const kitchenSyncState={unsupported:false,err:null};
function kitchenProfile(){
  const p=syncState.cfg&&syncState.cfg.personal;
  return validProfile(p)?{url:p.url,key:p.key,syncKey:p.syncKey+':kitchen'}:null;
}
/* Called from sync.js syncNow, like familySync. → true when the pantry or recipes changed here. Never throws:
   the lists sync either way. The server takes no ':kitchen' row until
   supabase/migrations/20261119_sync_kitchen_key.sql is in; the tab says so. */
async function kitchenSync(){
  const p=kitchenProfile(); if(!p||kitchenSyncState.unsupported)return false;
  let changed=false;
  try{
    for(let attempt=0;attempt<4;attempt++){
      const row=await syncPullRow(p);
      const r=mergeKitchenDocs(state.kitchen,row.doc);
      state.kitchen=r.merged;
      if(r.changedLocal)changed=true;
      const empty=!state.kitchen.items.length&&!state.kitchen.recipes.length;
      if(!(r.changedRemote||(!row.doc&&!empty)))break;
      if(!row.doc&&empty)break;
      if(await syncPushCas(p,kitchenDoc(state.kitchen),row.updatedAt))break;
      if(attempt===0){
        try{ const u=await syncRpc(p,'sync_usage',{p_sync_key:await syncRowKey(p)}); if(Array.isArray(u)&&u.length===0){ kitchenSyncState.unsupported=true; break; } }catch(e){}
      }
    }
    kitchenSyncState.err=null;
  }catch(e){ kitchenSyncState.err=String((e&&e.message)||e); }
  if(state.activeTab==='kitchen'&&!changed)kSyncNote();
  return changed;
}
function kSyncNote(){
  const n=$('kitSyncNote'); if(!n)return;
  const t=!kitchenProfile()?'':kitchenSyncState.unsupported?'Your kitchen is saved on this device. To see it on your other devices, the Supabase project needs one update: paste supabase/migrations/20261119_sync_kitchen_key.sql into its SQL Editor and press Run.'
    :kitchenSyncState.err?'Kitchen sync: '+kitchenSyncState.err:'';
  n.textContent=t; n.hidden=!t;
}

/* ── his grocery list (grocery-list.js) ── */
// put them on the Agent's grocery list for the next order → how many, or -1 when there's no grocery task
function kitchenToGroceries(entries){
  const t=typeof groceryTask==='function'?groceryTask():null;
  if(!t)return -1;
  const list=normList(t.list);
  entries.forEach(function(e){
    const hit=list.find(function(x){ return sameFood(x.name.split(',')[0],e.name); });
    if(hit)hit.out=true;
    // a new one is for these meals, not a usual: it comes up again only if he adds it again (every 52 weeks)
    else list.push({name:e.name.charAt(0).toUpperCase()+e.name.slice(1)+(e.qty!=null?', '+kFmtQty(e.qty,e.unit):''),every:52,last:null,out:true});
  });
  t.list=list; touch();
  return entries.length;
}
// or as a to-do with a checklist, for the store run he does himself
function kitchenToTodo(entries,meals){
  const t={id:uid(),title:'Shopping list'+(meals.length?' for '+meals.slice(0,3).join(', ')+(meals.length>3?' and more':''):''),done:false,due:null,dueTime:null,tag:null,ws:'personal',
    pin:null,googleEventId:null,created:Date.now(),subs:entries.map(function(e){ return {id:uid(),title:(e.qty!=null?kFmtQty(e.qty,e.unit)+' ':'')+e.name,done:false,due:null}; })};
  state.tasks.push(t); persist();
  return t;
}
// grocery-list.js applyListUpdate: what the Agent bought
window.kitchenBought=function(names){
  if(!state.kitchen||!Array.isArray(names)||!names.length)return;
  if(stockPantry(state.kitchen,names,Date.now(),uid).length)persist();
};

/* ── drawing ── */
function renderKitchen(){
  const view=$('kitchenView'); if(!view)return;
  if(!view.firstChild)kBuild(view); // built once, so what he's typing survives a sync landing mid-entry
  view.querySelectorAll('.kit-tab').forEach(function(b){ const on=b.dataset.v===kitchenUI.view; b.classList.toggle('on',on); b.setAttribute('aria-selected',String(on)); });
  ['meals','pantry','recipes','shop'].forEach(function(v){ $('kit-'+v).hidden=kitchenUI.view!==v; });
  kSyncNote();
  if(kitchenUI.view==='meals')kDrawMeals();
  else if(kitchenUI.view==='pantry')kDrawPantry();
  else if(kitchenUI.view==='recipes')kDrawRecipes();
  else kDrawShop();
}
function kBuild(view){
  view.innerHTML=
    '<div class="kit-tabs" role="tablist" aria-label="Kitchen">'+
      '<button type="button" class="kit-tab" data-v="meals" role="tab">Meals</button>'+
      '<button type="button" class="kit-tab" data-v="pantry" role="tab">Pantry</button>'+
      '<button type="button" class="kit-tab" data-v="recipes" role="tab">Recipes</button>'+
      '<button type="button" class="kit-tab" data-v="shop" role="tab">Shopping list</button>'+
    '</div>'+
    '<div id="kitSyncNote" class="kit-note" hidden></div>'+
    '<section id="kit-meals"><div id="kitAfter"></div><div id="kitMeals"></div></section>'+
    '<section id="kit-pantry" hidden>'+
      '<div class="kit-form"><input id="kitAddItem" class="sm kit-grow" placeholder="Add food you have: 2 lb chicken, eggs, 1 bag rice" aria-label="Add food">'+
      '<button id="kitAddItemBtn" class="btn-accent">Add</button></div>'+
      '<div class="kit-hint">Put an amount in to have it go down when you cook. Food with no amount counts as there until you mark it out.</div>'+
      '<div id="kitPantry"></div></section>'+
    '<section id="kit-recipes" hidden>'+
      '<div class="kit-form kit-recipe-form">'+
        '<input id="kitRecName" class="sm kit-grow" placeholder="Recipe name" aria-label="Recipe name">'+
        '<textarea id="kitRecIngs" class="sm" rows="5" placeholder="Ingredients, one per line:&#10;1 lb ground beef&#10;1 can kidney beans&#10;1 onion" aria-label="Ingredients"></textarea>'+
        '<label class="kit-check"><input id="kitRecLiked" type="checkbox"> I like this one</label>'+
        '<div class="kit-form-btns"><button id="kitRecCancel" class="ghost" hidden>Cancel</button><button id="kitRecSave" class="btn-accent">Save recipe</button></div>'+
      '</div>'+
      '<div class="kit-filter" role="radiogroup" aria-label="Which recipes">'+
        '<button type="button" class="kit-chip" data-f="all" role="radio">All</button>'+
        '<button type="button" class="kit-chip" data-f="liked" role="radio">Liked</button>'+
      '</div>'+
      '<div id="kitRecipes"></div></section>'+
    '<section id="kit-shop" hidden><div id="kitShop"></div></section>';
  view.querySelectorAll('.kit-tab').forEach(function(b){ b.addEventListener('click',function(){ kitchenUI.view=b.dataset.v; renderKitchen(); }); });
  view.querySelectorAll('.kit-chip').forEach(function(b){ b.addEventListener('click',function(){ kitchenUI.recipeFilter=b.dataset.f; renderKitchen(); }); });
  const addItem=function(){
    const inp=$('kitAddItem'), lines=inp.value.split(/\n|;/).map(parseIngredient).filter(Boolean);
    if(!lines.length){ inp.focus(); return; }
    const now=Date.now();
    lines.forEach(function(i){
      const p=pantryFind(state.kitchen.items,i.name);
      if(!p){ state.kitchen.items.push({id:uid(),name:i.name,qty:i.qty,unit:i.unit,updatedAt:now}); return; }
      const more=i.qty==null||p.qty==null?null:kConvert(i.qty,i.unit,p.unit);
      if(more!=null)p.qty=kRound(p.qty+more); else if(i.qty!=null&&p.qty==null){ p.qty=i.qty; p.unit=i.unit; }
      p.updatedAt=now;
    });
    inp.value=''; kSave(); $('kitAddItem').focus();
  };
  $('kitAddItemBtn').addEventListener('click',addItem);
  $('kitAddItem').addEventListener('keydown',function(e){ if(e.key==='Enter')addItem(); });
  $('kitRecSave').addEventListener('click',kSaveRecipe);
  $('kitRecCancel').addEventListener('click',function(){ kEditRecipe(null); });
  $('kitRecName').addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); $('kitRecIngs').focus(); } });
}
function kEmpty(text){ return el('div','kit-empty',text); }
function kLikeBtn(r){
  const b=el('button','kit-like'+(r.liked?' on':''),r.liked?'Liked':'Like');
  b.setAttribute('aria-pressed',String(r.liked)); b.title=r.liked?'You like this one (tap to undo)':'Mark as a meal you like';
  b.addEventListener('click',function(){ r.liked=!r.liked; r.updatedAt=Date.now(); kSave(); });
  return b;
}
function kPlanBtn(r){
  const b=el('button','kit-plan'+(r.planned?' on':''),r.planned?'On the plan':'Plan it');
  b.setAttribute('aria-pressed',String(r.planned)); b.title=r.planned?'Take it off the shopping list':'Buy what this needs (it goes on the shopping list)';
  b.addEventListener('click',function(){ r.planned=!r.planned; r.updatedAt=Date.now(); kSave(); });
  return b;
}
function kMadeBtn(r){
  const b=el('button','btn-accent','Made it');
  b.title='Take what it used out of the pantry';
  b.addEventListener('click',function(){
    const res=cookRecipe(state.kitchen,r.id);
    kitchenUI.afterCook={name:r.name,ranOut:res.ranOut,unsure:res.unsure};
    kSave();
    voiceToast(r.name+': pantry updated'+(res.ranOut.length?'. Used up: '+res.ranOut.join(', '):''));
  });
  return b;
}
function kLastMade(r){
  const d=r.made.slice(-1)[0]; if(!d)return 'not made yet';
  const p=d.split('-').map(Number), days=Math.round((todayStart()-new Date(p[0],p[1]-1,p[2]))/864e5);
  return 'made '+(days<=0?'today':days===1?'yesterday':days+' days ago')+(r.made.length>1?' · '+r.made.length+' times':'');
}
// after "Made it": what ran out can go on the grocery list, and what had no amount can be marked out
function kDrawAfter(){
  const box=$('kitAfter'); box.innerHTML='';
  const a=kitchenUI.afterCook; if(!a)return;
  const still=a.unsure.filter(function(n){ return pantryFind(state.kitchen.items,n); });
  if(!a.ranOut.length&&!still.length){ kitchenUI.afterCook=null; return; }
  const card=el('div','kit-after');
  const head=el('div','kit-after-head'); head.appendChild(el('span','kit-k','After '+a.name));
  const x=iconBtn(I.x,'Close'); x.addEventListener('click',function(){ kitchenUI.afterCook=null; renderKitchen(); }); head.appendChild(x);
  card.appendChild(head);
  if(a.ranOut.length){
    const row=el('div','kit-after-row'); row.appendChild(el('span',null,'Used up: '+a.ranOut.join(', ')));
    const g=el('button','ghost','Add to grocery list');
    g.addEventListener('click',function(){
      const n=kitchenToGroceries(a.ranOut.map(function(n){ return {name:n,qty:null,unit:''}; }));
      voiceToast(n<0?'No grocery list yet: ask the Agent for groceries once, then this adds to it.':'On your grocery list for the next order');
      if(n>=0){ a.ranOut=[]; renderKitchen(); }
    });
    row.appendChild(g); card.appendChild(row);
  }
  if(still.length){
    card.appendChild(el('div','kit-hint','No amount for these. Did any run out?'));
    still.forEach(function(n){
      const row=el('div','kit-after-row'); row.appendChild(el('span',null,n));
      const out=el('button','ghost','It ran out');
      out.addEventListener('click',function(){ const p=pantryFind(state.kitchen.items,n); if(p)kOut(p); a.unsure=a.unsure.filter(function(x){ return x!==n; }); });
      row.appendChild(out); card.appendChild(row);
    });
  }
  box.appendChild(card);
}
function kDrawMeals(){
  kDrawAfter();
  const box=$('kitMeals'); box.innerHTML='';
  if(!state.kitchen.recipes.length){ box.appendChild(kEmpty('No recipes yet. Add the meals you make under Recipes, and what food you have under Pantry: this shows what you can make.')); return; }
  const all=suggestMeals(state.kitchen);
  const now=all.filter(function(s){ return !s.missing.length; }), close=all.filter(function(s){ return s.missing.length&&s.missing.length<=3; });
  const sec=function(title,list,empty){
    box.appendChild(el('div','kit-k kit-sec',title));
    if(!list.length){ box.appendChild(kEmpty(empty)); return; }
    list.forEach(function(s){
      const r=s.recipe, card=el('div','kit-card');
      const top=el('div','kit-card-top'); top.appendChild(el('span','kit-card-name',r.name)); top.appendChild(kLikeBtn(r)); card.appendChild(top);
      card.appendChild(el('div','kit-card-sub',s.missing.length?'Need: '+s.missing.map(function(m){ return (m.need!=null?kFmtQty(m.need,m.unit)+' ':'')+m.name; }).join(', '):kLastMade(r)));
      const btns=el('div','kit-card-btns'); if(!s.missing.length)btns.appendChild(kMadeBtn(r)); btns.appendChild(kPlanBtn(r)); card.appendChild(btns);
      box.appendChild(card);
    });
  };
  sec('You can make now',now,'Nothing yet with what’s in the pantry.');
  if(close.length)sec('A few things short',close,'');
}
function kOut(p){
  state.kitchen.items=state.kitchen.items.filter(function(x){ return x.id!==p.id; }); kTomb(p.id);
  const n=kitchenToGroceries([{name:p.name,qty:null,unit:''}]);
  voiceToast(n<0?p.name+' is out of the pantry':p.name+' is out: it’s on your grocery list for the next order');
  kSave();
}
function kDrawPantry(){
  const box=$('kitPantry'); box.innerHTML='';
  const items=state.kitchen.items.slice().sort(function(a,b){ return a.name.localeCompare(b.name); });
  if(!items.length){ box.appendChild(kEmpty('The pantry is empty. Add what you have above; groceries the Agent buys come in here on their own.')); return; }
  items.forEach(function(p){
    const row=el('div','kit-row');
    row.appendChild(el('span','kit-row-name',p.name));
    const q=el('input','sm kit-qty'); q.value=p.qty!=null?kFmtQty(p.qty,p.unit):''; q.placeholder='some'; q.setAttribute('aria-label','How much '+p.name);
    q.title='How much you have, like 2 lb or 6';
    const setQ=function(){
      const v=q.value.trim(), i=v?parseIngredient(v+' x'):null;
      const nq=i&&i.qty!=null?i.qty:null, nu=i&&i.qty!=null?i.unit:'';
      if(nq===p.qty&&nu===p.unit)return;
      p.qty=nq; p.unit=nu; p.updatedAt=Date.now(); kSave();
    };
    q.addEventListener('change',setQ); q.addEventListener('keydown',function(e){ if(e.key==='Enter')q.blur(); });
    row.appendChild(q);
    const out=el('button','ghost','Out'); out.title='Ran out: take it off and put it on the grocery list';
    out.addEventListener('click',function(){ kOut(p); });
    row.appendChild(out);
    const del=iconBtn(I.x,'Remove '+p.name); del.addEventListener('click',function(){ state.kitchen.items=state.kitchen.items.filter(function(x){ return x.id!==p.id; }); kTomb(p.id); kSave(); });
    row.appendChild(del);
    box.appendChild(row);
  });
}
function kEditRecipe(r){
  kitchenUI.editing=r?r.id:null;
  $('kitRecName').value=r?r.name:''; $('kitRecIngs').value=r?r.ingredients.map(fmtIngredient).join('\n'):''; $('kitRecLiked').checked=!!(r&&r.liked);
  $('kitRecSave').textContent=r?'Save changes':'Save recipe'; $('kitRecCancel').hidden=!r;
  if(r){ $('kitRecName').focus(); $('kitRecName').scrollIntoView({block:'nearest'}); }
}
function kSaveRecipe(){
  const name=$('kitRecName').value.trim();
  if(!name){ $('kitRecName').classList.add('bad'); $('kitRecName').focus(); return; }
  $('kitRecName').classList.remove('bad');
  const ings=$('kitRecIngs').value.split('\n').map(parseIngredient).filter(Boolean).slice(0,60);
  const now=Date.now(), r=kitchenUI.editing&&state.kitchen.recipes.find(function(x){ return x.id===kitchenUI.editing; });
  if(r)Object.assign(r,{name:name.slice(0,100),ingredients:ings,liked:$('kitRecLiked').checked,updatedAt:now});
  else state.kitchen.recipes.push({id:uid(),name:name.slice(0,100),ingredients:ings,liked:$('kitRecLiked').checked,planned:false,made:[],updatedAt:now});
  kEditRecipe(null); kSave();
}
function kDrawRecipes(){
  document.querySelectorAll('#kitchenView .kit-chip').forEach(function(b){ const on=b.dataset.f===kitchenUI.recipeFilter; b.classList.toggle('on',on); b.setAttribute('aria-checked',String(on)); });
  const box=$('kitRecipes'); box.innerHTML='';
  const list=state.kitchen.recipes.filter(function(r){ return kitchenUI.recipeFilter!=='liked'||r.liked; })
    .sort(function(a,b){ return (b.liked-a.liked)||a.name.localeCompare(b.name); });
  if(!list.length){ box.appendChild(kEmpty(kitchenUI.recipeFilter==='liked'?'No liked recipes yet. Tap Like on the ones you want again.':'No recipes yet. Add one above.')); return; }
  list.forEach(function(r){
    const card=el('div','kit-card');
    const top=el('div','kit-card-top'); top.appendChild(el('span','kit-card-name',r.name)); top.appendChild(kLikeBtn(r)); card.appendChild(top);
    card.appendChild(el('div','kit-card-sub',r.ingredients.map(fmtIngredient).join(', ')||'No ingredients yet'));
    card.appendChild(el('div','kit-card-meta',kLastMade(r)));
    const btns=el('div','kit-card-btns'); btns.appendChild(kPlanBtn(r));
    const ed=iconBtn(I.pen,'Edit '+r.name); ed.addEventListener('click',function(){ kEditRecipe(r); }); btns.appendChild(ed);
    const del=iconBtn(I.x,'Delete '+r.name); del.addEventListener('click',function(){
      if(!confirm('Delete the recipe "'+r.name+'"?'))return;
      state.kitchen.recipes=state.kitchen.recipes.filter(function(x){ return x.id!==r.id; }); kTomb(r.id);
      if(kitchenUI.editing===r.id)kEditRecipe(null);
      kSave(); });
    btns.appendChild(del);
    card.appendChild(btns);
    box.appendChild(card);
  });
}
function kDrawShop(){
  const box=$('kitShop'); box.innerHTML='';
  const plan=state.kitchen.recipes.filter(function(r){ return r.planned; });
  box.appendChild(el('div','kit-k kit-sec','Meals you’re buying for'));
  if(!plan.length){
    box.appendChild(kEmpty('No meals planned. Tap Plan it on a recipe (your liked ones are a good start) and what it needs shows up here.'));
    const liked=state.kitchen.recipes.filter(function(r){ return r.liked; });
    if(liked.length){
      const b=el('button','ghost','Plan all '+liked.length+' liked meals');
      b.addEventListener('click',function(){ const now=Date.now(); liked.forEach(function(r){ r.planned=true; r.updatedAt=now; }); kSave(); });
      box.appendChild(b);
    }
    return;
  }
  const chips=el('div','kit-chips');
  plan.forEach(function(r){
    const c=el('span','kit-meal'+(r.liked?' liked':''),r.name);
    const x=iconBtn(I.x,'Take '+r.name+' off the plan'); x.addEventListener('click',function(){ r.planned=false; r.updatedAt=Date.now(); kSave(); });
    c.appendChild(x); chips.appendChild(c);
  });
  box.appendChild(chips);
  const list=shoppingList(state.kitchen);
  box.appendChild(el('div','kit-k kit-sec','To buy'));
  if(!list.length){ box.appendChild(kEmpty('You have everything these meals need.')); return; }
  list.forEach(function(e){
    const row=el('div','kit-row');
    row.appendChild(el('span','kit-row-qty',e.qty!=null?kFmtQty(e.qty,e.unit):''));
    row.appendChild(el('span','kit-row-name',e.name));
    row.appendChild(el('span','kit-row-for','for '+e.for.join(', ')));
    box.appendChild(row);
  });
  const btns=el('div','kit-card-btns kit-shop-btns');
  const g=el('button','btn-accent','Add to grocery order');
  g.title='Put these on the Agent’s grocery list for the next order';
  g.addEventListener('click',function(){
    const n=kitchenToGroceries(list);
    voiceToast(n<0?'No grocery list yet: ask the Agent for groceries once (or use Make a to-do).':n+' item'+(n===1?'':'s')+' on your grocery list for the next order');
  });
  const td=el('button','ghost','Make a to-do');
  td.title='A to-do with each item to check off, for shopping yourself';
  td.addEventListener('click',function(){ kitchenToTodo(list,plan.map(function(r){ return r.name; })); voiceToast('Shopping list added to To do'); });
  btns.appendChild(g); btns.appendChild(td); box.appendChild(btns);
}
window.renderKitchen=renderKitchen;
window.kitchenSync=kitchenSync;
window.kitchenProfile=kitchenProfile;
}
