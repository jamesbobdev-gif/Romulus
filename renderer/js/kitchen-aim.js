/* The Kitchen tab's "what to aim for" box (Ideas from your pantry, kitchen.js kDrawIdeas): a list of suggestions
   drops down under it as he types, like a search box's. They come from what he asked for before (newest first),
   a few common aims sized to his Food plan when he has one, and "Something with ..." for each pantry food.
   Below the box, a row of bubbles shows the first few of them without typing.
   Arrow keys move through them, Enter or a click picks one and asks for ideas right away, Escape closes the list.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists
   them. kAimSuggest has no DOM in it, so test/kitchen-aim.test.js can load it in Node. */
'use strict';

const KAIM_MAX=8, KAIM_RECENT_KEEP=10;

// the common aims; a Food plan (per day: {kcal, protein, ...}) sizes the first two to one meal's share of it
function kAimPresets(plan){
  const p=plan||{};
  return [
    p.protein?'High protein, about '+Math.round(p.protein/3)+' g':'High protein',
    p.kcal?'Under '+Math.round(p.kcal/3/10)*10+' calories':'Under 600 calories',
    'Quick, under 20 minutes','Breakfast','Lunch','Dinner','A snack','Low carb','One pan, few dishes',
    'Cook once, eat for 3 days','Vegetarian','Something I haven’t made before',
  ];
}

// what he typed, plus {recent:[aims, newest first], pantry:[food names], plan} → up to 8 {text, kind}, kind being
// 'recent' | 'idea' | 'pantry'. Empty: his recent aims, then the common ones. Typed: every word he typed has to start
// one of the suggestion's words, like a search box; ones that start with all of what he typed come first.
function kAimSuggest(typed,ctx){
  ctx=ctx||{};
  const t=String(typed||'').toLowerCase().replace(/\s+/g,' ').trim();
  const seen=new Set(), all=[];
  const add=function(text,kind){
    text=String(text||'').replace(/\s+/g,' ').trim(); const k=text.toLowerCase();
    if(!text||seen.has(k)||k===t)return; seen.add(k); all.push({text:text,kind:kind});
  };
  (ctx.recent||[]).forEach(function(x){ add(x,'recent'); });
  kAimPresets(ctx.plan).forEach(function(x){ add(x,'idea'); });
  if(!t)return all.filter(function(s){ return s.kind!=='pantry'; }).slice(0,KAIM_MAX);
  (ctx.pantry||[]).forEach(function(x){ add('Something with '+String(x||'').toLowerCase(),'pantry'); });
  const words=t.split(' ');
  const starts=function(s){ // every word he typed starts one of the suggestion's words
    const ws=s.text.toLowerCase().split(/[^a-z0-9’']+/);
    return words.every(function(w){ return ws.some(function(x){ return x.indexOf(w)===0; }); });
  };
  return all.filter(starts)
    .map(function(s,i){ return {s:s,r:s.text.toLowerCase().indexOf(t)===0?0:1,i:i}; })
    .sort(function(a,b){ return a.r-b.r||a.i-b.i; })
    .slice(0,KAIM_MAX).map(function(x){ return x.s; });
}

// an aim he just asked with goes to the front of the recent list (no repeats, at most 10)
function kAimRemember(list,aim){
  aim=String(aim||'').replace(/\s+/g,' ').trim().slice(0,300);
  const rest=(list||[]).filter(function(x){ return typeof x==='string'&&x.toLowerCase()!==aim.toLowerCase(); });
  return (aim?[aim]:[]).concat(rest).slice(0,KAIM_RECENT_KEEP);
}

if(typeof module!=='undefined'&&module.exports)module.exports={kAimSuggest,kAimRemember,kAimPresets};

/* ── the drop-down (page only) ── */
const KAIM_KEY='kitchen.aims.v1'; // this device's recent aims
function kAimRecent(){ try{ const a=JSON.parse(localStorage.getItem(KAIM_KEY)||'[]'); return Array.isArray(a)?a:[]; }catch(e){ return []; } }
function kAimSave(aim){ try{ localStorage.setItem(KAIM_KEY,JSON.stringify(kAimRemember(kAimRecent(),aim))); }catch(e){} }

// the bubbles under the box: his recent aims, then common ones; a tap fills the box and asks. ctx: {pantry, plan}
function kAimChips(ctx,onPick){
  const row=el('div','kit-aim-chips');
  kAimSuggest('',{recent:kAimRecent(),plan:(ctx||{}).plan}).slice(0,6).forEach(function(s){
    const b=el('button','kit-aim-chip',s.text); b.type='button';
    b.addEventListener('click',function(){ onPick(s.text); });
    row.appendChild(b);
  });
  return row;
}

// input: the aim box, already in the page. getCtx() → {pantry, plan}. onPick(text): he chose or pressed Enter.
function kAimBox(input,getCtx,onPick){
  const wrap=input.parentNode, list=document.createElement('ul');
  list.className='kit-aim-list'; list.id='kitAimList'; list.setAttribute('role','listbox'); list.hidden=true;
  wrap.appendChild(list);
  input.setAttribute('role','combobox'); input.setAttribute('aria-autocomplete','list');
  input.setAttribute('aria-controls','kitAimList'); input.setAttribute('aria-expanded','false'); input.autocomplete='off';
  let items=[], at=-1;
  const close=function(){ list.hidden=true; at=-1; input.setAttribute('aria-expanded','false'); input.removeAttribute('aria-activedescendant'); };
  const mark=function(){
    Array.prototype.forEach.call(list.children,function(li,i){ li.classList.toggle('on',i===at); li.setAttribute('aria-selected',String(i===at)); });
    if(at>=0)input.setAttribute('aria-activedescendant','kitAimOpt'+at); else input.removeAttribute('aria-activedescendant');
  };
  const pick=function(text){ input.value=text; close(); onPick(text); };
  const open=function(){
    const c=getCtx()||{};
    items=kAimSuggest(input.value,{recent:kAimRecent(),pantry:c.pantry,plan:c.plan}); at=-1;
    list.innerHTML='';
    if(!items.length){ close(); return; }
    const typed=input.value.trim().toLowerCase();
    items.forEach(function(s,i){
      const li=document.createElement('li'); li.id='kitAimOpt'+i; li.setAttribute('role','option'); li.className='kit-aim-opt kit-aim-'+s.kind;
      // what he typed stays plain, the rest of the suggestion is bold, like a search box's
      const k=s.text.toLowerCase().indexOf(typed), txt=el('span','kit-aim-text');
      if(typed&&k>=0){
        if(k)txt.appendChild(el('b','',s.text.slice(0,k)));
        txt.appendChild(document.createTextNode(s.text.slice(k,k+typed.length)));
        if(k+typed.length<s.text.length)txt.appendChild(el('b','',s.text.slice(k+typed.length)));
      } else txt.appendChild(document.createTextNode(s.text));
      li.appendChild(txt);
      if(s.kind==='recent')li.appendChild(el('span','kit-aim-tag','recent'));
      li.addEventListener('mousedown',function(e){ e.preventDefault(); }); // keep focus in the box
      li.addEventListener('click',function(){ pick(s.text); });
      list.appendChild(li);
    });
    list.hidden=false; input.setAttribute('aria-expanded','true');
  };
  input.addEventListener('focus',open);
  input.addEventListener('input',open);
  input.addEventListener('blur',close);
  input.addEventListener('keydown',function(e){
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      e.preventDefault();
      if(list.hidden){ open(); return; }
      if(!items.length)return;
      at=e.key==='ArrowDown'?(at+1)%items.length:(at<=0?items.length-1:at-1);
      mark();
    } else if(e.key==='Enter'){
      e.preventDefault();
      if(!list.hidden&&at>=0)pick(items[at].text); else { close(); onPick(input.value); }
    } else if(e.key==='Escape'){ if(!list.hidden){ e.preventDefault(); close(); } }
    else if(e.key==='Tab')close();
  });
}
