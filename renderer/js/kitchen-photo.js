/* Pantry photos, in the Kitchen tab (kitchen.js draws the tab and calls kpDraw):
   - Pantry → "Add from a photo or receipt": a picture of groceries, or the receipt for them. His AIs list the food in it; he ticks what to add and
     fixes any amount, then it goes in the way the Agent's orders do (stockPantry: a known size adds to what's there).
   - Meals → "Photo of a meal": a picture of what he made. His AIs say which pantry foods it used and about how
     much; the sure ones come out of the pantry right away (usePantry), with an Undo. The rest become one short
     to-do ("Rice is used up" to check off), which pantryAnswers reads back here or after a sync from the phone.
   On a computer the asking is main/kitchen-ai.js kitchen:photo (prompt in renderer/js/pantry-photo.js). The phone has
   no AI of its own: with his keys copied over (phone-ai.js) it asks them itself; without, it uploads the picture (agent-attachments, like a task's photos) and leaves an ask in the
   synced kitchen row; a computer with AI connections, or Lupa, reads it on its next sync (kpServe) and writes
   the answer back, and the phone uses it (kpCollect): the same checklist, or the meal taken out of the pantry. */

const kpUI={busy:'',why:'',whyFor:'',food:null,meal:null}; // food: {items:[{line, on, have}], via}; meal: {name, took, asked, todoId, before, via}

function kpAvailable(){ return kpLocal()||kpPhoneAi()||kpRemote(); }
// the phone with his AI keys copied over (phone-ai.js): it reads the photo itself, no computer needed
function kpPhoneAi(){ return !kpLocal()&&!!(window.phoneAi&&window.phoneAi.ready()); }
/* one picture → food: {items, via}; meal: {meal, used, via}; or {why}. The computer asks in its main process
   (main/kitchen-ai.js), the phone asks its own keys with the same prompt (pantry-photo.js) */
async function kpRead(mode,image,pantry){
  if(kpLocal())return window.desktop.kitchenPhoto({mode:mode,image:image,pantry:pantry});
  if(mode==='meal'&&!pantry.length)return {why:'The pantry is empty, so there is nothing to take out.'};
  const r=await window.phoneAi.ask(pantryPhotoPrompt(mode,pantry),image);
  if(!r||!r.text)return {why:(r&&r.why)||'No answer.'};
  const out=pantryPhotoParse(mode,r.text), n=mode==='meal'?out.used.length:out.items.length;
  if(!n)return {why:mode==='meal'?r.via+' couldn’t match that meal to anything in the pantry.':r.via+' didn’t see any food in that picture or receipt.'};
  return Object.assign(out,{via:r.via});
}
function kpLocal(){ return !!(window.desktop&&window.desktop.kitchenPhoto); }
// the phone: through a computer, which needs the kitchen to sync and somewhere to put the picture
function kpRemote(){
  return !kpLocal()&&typeof window.kitchenProfile==='function'&&!!window.kitchenProfile()&&typeof attachProfile==='function'&&!!attachProfile()&&typeof uploadAttachment==='function';
}
function kpMe(){ try{ return typeof window.deviceId==='function'?window.deviceId():'this-device'; }catch(e){ return 'this-device'; } }
function kpMyAsks(){ const me=kpMe(); return (state.kitchen.asks||[]).filter(function(a){ return a.from===me; }); }
function kpSetAsk(a,ch){ Object.assign(a,ch,{updatedAt:Date.now()}); }

// a photo he picked → {mime, b64}, at most 1600 px on its long side
function kpShrink(file){
  return new Promise(function(ok,fail){
    const url=URL.createObjectURL(file), im=new Image();
    im.onload=function(){
      const k=Math.min(1,1600/Math.max(im.naturalWidth,im.naturalHeight));
      const c=document.createElement('canvas'); c.width=Math.max(1,Math.round(im.naturalWidth*k)); c.height=Math.max(1,Math.round(im.naturalHeight*k));
      c.getContext('2d').drawImage(im,0,0,c.width,c.height); URL.revokeObjectURL(url);
      ok({mime:'image/jpeg',b64:c.toDataURL('image/jpeg',0.85).split(',')[1]});
    };
    im.onerror=function(){ URL.revokeObjectURL(url); fail(new Error('not a picture')); };
    im.src=url;
  });
}
function kpRedraw(){ if(typeof window.renderKitchen==='function')window.renderKitchen(); }
function kpPantryList(){ return state.kitchen.items.map(function(i){ return {name:i.name,qty:i.qty,unit:i.unit}; }); }

async function kpAsk(mode,file){
  if(kpUI.busy||!file)return;
  kpUI.busy=mode; kpUI.why=''; kpUI.whyFor=mode; if(mode==='food')kpUI.food=null; kpRedraw();
  if(!kpLocal()&&!kpPhoneAi()){ await kpSend(mode,file); kpUI.busy=''; kpRedraw(); return; }
  try{
    const image=await kpShrink(file);
    const r=await kpRead(mode,image,kpPantryList());
    if(!r||r.why)kpUI.why=(r&&r.why)||'No answer. Try again.';
    else if(mode==='food')kpUI.food={via:r.via||'',items:r.items.map(function(x){
      const line=(x.amount?x.amount+' ':'')+x.name;
      return {line:line,on:true,have:!!pantryFind(state.kitchen.items,x.name)};
    })};
    else kpMealApply(r);
  }catch(e){ kpUI.why=e&&e.message==='not a picture'?'That file isn’t a picture.':'Couldn’t read the picture: '+(e&&e.message||e); }
  kpUI.busy=''; kpRedraw();
}

// the meal's foods out of the pantry now; the unsure ones on a to-do
function kpMealApply(r){ kpUI.meal=kpMealUse(r); persist(); voiceToast(kpMealToast(kpUI.meal)); }
function kpMealToast(m){ return m.name+': '+(m.took.length?'took '+m.took.join(', ')+' out of the pantry':'nothing taken out')+(m.todoId?'. One question in To do.':''); }
function kpMealUse(r){
  const k=state.kitchen;
  const before=k.items.map(function(i){ return Object.assign({},i); });
  const ings=r.used.map(function(u){
    const p=parseIngredient((u.amount?u.amount+' ':'')+u.name)||{name:u.name,qty:null,unit:''};
    return {name:u.name,qty:p.qty,unit:p.unit,sure:u.sure};
  });
  const res=usePantry(k,ings,Date.now());
  const meal=r.meal||'that meal';
  const todo=pantryAskTodo(k,res.unsure,meal,uid);
  if(todo)state.tasks.push(todo);
  return {name:meal,via:r.via||'',took:res.used.concat(res.ranOut),ranOut:res.ranOut,asked:todo?res.unsure:[],todoId:todo?todo.id:null,before:before};
}
// Undo: the pantry as it was (newer than the deletes, so a sync keeps them) and the to-do gone
function kpMealUndo(){
  const m=kpUI.meal; if(!m)return;
  const now=Date.now(), ids={};
  m.before.forEach(function(i){ ids[i.id]=true; });
  state.kitchen.items=state.kitchen.items.filter(function(i){ return !ids[i.id]; })
    .concat(m.before.map(function(i){ return Object.assign({},i,{updatedAt:now}); }));
  if(m.todoId)state.tasks=state.tasks.filter(function(t){ return t.id!==m.todoId; });
  kpUI.meal=null; persist(); voiceToast('Put back the way it was'); kpRedraw();
}
function kpFoodAdd(){
  const f=kpUI.food; if(!f)return;
  const names=[];
  f.items.forEach(function(x){
    if(!x.on)return;
    const p=parseIngredient(x.line); if(!p)return;
    names.push(p.name+(p.qty!=null?', '+p.qty+(p.unit?' '+p.unit:''):''));
  });
  const added=stockPantry(state.kitchen,names,Date.now(),uid);
  kpDoneFood(); persist();
  voiceToast(added.length?'Added to the pantry: '+added.join(', '):'Nothing added');
  kpRedraw();
}

function kpPickBtn(mode,label,title){
  const pick=document.createElement('input'); pick.type='file'; pick.accept='image/*'; pick.hidden=true;
  pick.setAttribute('capture','environment'); // the camera on a phone or tablet; a file picker on a computer
  const b=el('button',mode==='food'?'ghost':'btn-accent',kpUI.busy===mode?'Reading the picture…':label);
  b.title=title; b.disabled=!!kpUI.busy;
  b.addEventListener('click',function(){ pick.click(); });
  pick.addEventListener('change',function(){ const f=pick.files&&pick.files[0]; pick.value=''; kpAsk(mode,f); });
  const wrap=el('span'); wrap.appendChild(b); wrap.appendChild(pick);
  return wrap;
}
function kpCard(title,onClose){
  const card=el('div','kit-after');
  const head=el('div','kit-after-head'); head.appendChild(el('span','kit-k',title));
  const x=iconBtn(I.x,'Close'); x.addEventListener('click',onClose); head.appendChild(x);
  card.appendChild(head);
  return card;
}

// mode 'food' (the Pantry view) or 'meal' (the Meals view) into box
function kpDraw(mode,box){
  if(!box)return; box.innerHTML='';
  if(!kpAvailable())return;
  if(mode==='food'){
    const row=el('div','kit-form kp-row');
    row.appendChild(kpPickBtn('food','Add from a photo or receipt','A picture of groceries you’re putting away, or of the receipt. Lupa reads it if it’s set up, otherwise your AI connections'));
    row.appendChild(el('span','kit-hint','Take a picture of what you bought, or the receipt, and pick what to add.'));
    box.appendChild(row);
    kpDrawWaiting('food',box);
    if(kpUI.why&&kpUI.busy===''&&!kpUI.food&&kpUI.whyFor==='food')box.appendChild(el('div','kit-empty',kpUI.why));
    const f=kpUI.food; if(!f)return;
    const card=kpCard('Found in the picture'+(f.via?' (read by '+f.via+')':''),function(){ kpDoneFood(); persist(); kpRedraw(); });
    card.appendChild(el('div','kit-hint','Untick anything you don’t want added, and fix an amount if it’s off.'));
    f.items.forEach(function(x){
      const r=el('label','kit-after-row kp-item');
      const c=document.createElement('input'); c.type='checkbox'; c.checked=x.on;
      c.addEventListener('change',function(){ x.on=c.checked; });
      const t=el('input','sm kit-grow'); t.value=x.line; t.setAttribute('aria-label','Food and amount');
      t.addEventListener('input',function(){ x.line=t.value.slice(0,120); });
      r.appendChild(c); r.appendChild(t);
      if(x.have)r.appendChild(el('span','kit-hint','adds to what you have'));
      card.appendChild(r);
    });
    const btns=el('div','kit-card-btns');
    const add=el('button','btn-accent','Add to pantry'); add.addEventListener('click',kpFoodAdd);
    btns.appendChild(add); card.appendChild(btns);
    box.appendChild(card);
    return;
  }
  const row=el('div','kit-form kp-row');
  row.appendChild(kpPickBtn('meal','Photo of a meal','A picture of something you made. What it used comes out of the pantry'));
  row.appendChild(el('span','kit-hint','Made something? Take a picture and the pantry goes down.'));
  box.appendChild(row);
  kpDrawWaiting('meal',box);
  if(!state.kitchen.items.length&&!kpUI.meal){ row.querySelector('button').disabled=true; return; }
  if(kpUI.why&&kpUI.busy===''&&kpUI.whyFor==='meal')box.appendChild(el('div','kit-empty',kpUI.why));
  const m=kpUI.meal; if(!m)return;
  const card=kpCard(m.name+(m.via?' (read by '+m.via+')':''),function(){ kpUI.meal=null; kpRedraw(); });
  card.appendChild(el('div','kit-after-row',m.took.length?'Took out: '+m.took.join(', ')+(m.ranOut.length?'. Used up: '+m.ranOut.join(', '):''):'Nothing was sure enough to take out.'));
  if(m.asked.length)card.appendChild(el('div','kit-hint','Not sure about '+m.asked.join(', ')+'. There’s a to-do to check off anything that ran out.'));
  const btns=el('div','kit-card-btns');
  const undo=el('button','ghost','Undo'); undo.title='Put the pantry back and remove the to-do'; undo.addEventListener('click',kpMealUndo);
  btns.appendChild(undo); card.appendChild(btns);
  box.appendChild(card);
}
function kpDoneFood(){
  const f=kpUI.food; kpUI.food=null;
  const a=f&&f.askId&&(state.kitchen.asks||[]).find(function(x){ return x.id===f.askId; });
  if(a)kpSetAsk(a,{state:'applied',result:null});
}

/* ── the phone: send the picture to a computer ── */
async function kpSend(mode,file){
  try{
    const blob=await shrinkImage(file);
    const url=await uploadAttachment(blob);
    const now=Date.now();
    if(!Array.isArray(state.kitchen.asks))state.kitchen.asks=[];
    state.kitchen.asks.push({id:uid(),mode:mode,url:url,from:kpMe(),at:now,updatedAt:now,state:'waiting',reader:'',readAt:0,why:''});
    persist(); if(typeof schedulePush==='function')schedulePush();
    voiceToast('Sent to your computer to read');
  }catch(e){ kpUI.why='Couldn’t send the picture: '+(e&&e.message||e); }
}
// his photos still out with a computer, with a way to stop waiting
function kpDrawWaiting(mode,box){
  kpMyAsks().filter(function(a){ return a.mode===mode&&(a.state==='waiting'||a.state==='reading'); }).forEach(function(a){
    const row=el('div','kit-after-row kp-wait');
    const mins=Math.round((Date.now()-a.at)/60000);
    row.appendChild(el('span','kit-hint',a.state==='reading'?(a.reader||'Your computer')+' is reading your photo…'
      :'Waiting for your computer to read your photo'+(mins>=10?'. Romulus needs to be open on your computer or on Lupa.':'…')));
    const x=el('button','ghost','Cancel');
    x.addEventListener('click',function(){ kpSetAsk(a,{state:'applied'}); persist(); kpRedraw(); });
    row.appendChild(x); box.appendChild(row);
  });
}
// the phone that asked: use what came back → true when the pantry or the to-dos changed
function kpCollect(){
  let changed=false;
  kpMyAsks().forEach(function(a){
    if(a.state==='failed'){
      kpUI.why='Your computer couldn’t read the photo: '+(a.why||'no answer'); kpUI.whyFor=a.mode;
      kpSetAsk(a,{state:'applied'}); changed=true; return;
    }
    if(a.state!=='done'||!a.result)return;
    if(a.mode==='meal'){
      kpUI.meal=kpMealUse(a.result); voiceToast(kpMealToast(kpUI.meal));
      kpSetAsk(a,{state:'applied',result:null}); changed=true;
    } else if(!kpUI.food){ // the checklist; the ask is applied once he adds or closes it
      const items=Array.isArray(a.result.items)?a.result.items:[];
      kpUI.food={askId:a.id,via:a.result.via||'',items:items.map(function(x){
        return {line:(x.amount?x.amount+' ':'')+x.name,on:true,have:!!pantryFind(state.kitchen.items,x.name)};
      })};
      voiceToast('Your photo is read: check what to add under Kitchen, Pantry');
    }
  });
  return changed;
}

/* ── a computer: read a phone's photo ── */
let kpServing=false;
// only pictures in his own agent-attachments folder on his own Supabase
function kpOwnPic(url){
  const a=typeof attachProfile==='function'&&attachProfile(); if(!a)return false;
  try{
    const u=new URL(url), base=new URL(a.url);
    return u.protocol==='https:'&&u.host===base.host&&/^\/storage\/v1\/object\/public\/agent-attachments\/[\w.-]+\/[\w.-]+$/.test(u.pathname);
  }catch(e){ return false; }
}
async function kpServe(){
  if(kpServing||!kpLocal())return;
  const a=askToServe(state.kitchen,kpMe(),Date.now());
  if(!a)return;
  kpServing=true;
  try{
    kpSetAsk(a,{state:'reading',reader:(window.devState&&devState.info&&devState.info.name)||'Your computer',readAt:Date.now()});
    persist(); if(typeof schedulePush==='function')schedulePush(); // other computers see it's taken
    let r;
    if(!kpOwnPic(a.url))r={why:'That picture isn’t in your own storage.'};
    else{
      const res=await fetch(a.url);
      if(!res.ok)r={why:'The picture couldn’t be downloaded ('+res.status+').'};
      else r=await window.desktop.kitchenPhoto({mode:a.mode,image:await kpShrink(await res.blob()),pantry:kpPantryList()});
    }
    const cur=(state.kitchen.asks||[]).find(function(x){ return x.id===a.id; }); // still there, and not moved on elsewhere
    if(cur&&cur.state==='reading'){
      if(!r||r.why)kpSetAsk(cur,{state:'failed',why:String((r&&r.why)||'No answer.').slice(0,200)});
      else kpSetAsk(cur,{state:'done',result:a.mode==='meal'?{meal:r.meal,used:r.used,via:r.via}:{items:r.items,via:r.via}});
      persist();
    }
  }catch(e){
    const cur=(state.kitchen.asks||[]).find(function(x){ return x.id===a.id; });
    if(cur&&cur.state==='reading'){ kpSetAsk(cur,{state:'failed',why:String(e&&e.message||e).slice(0,200)}); persist(); }
  }finally{
    kpServing=false;
    if(typeof schedulePush==='function')schedulePush();
  }
}
// kitchen.js kitchenSync, after each merge → true when this device's pantry or to-dos changed
function kpAfterSync(){
  if(!state.kitchen)return false;
  let changed=pruneAsks(state.kitchen,Date.now())>0;
  if(kpCollect())changed=true;
  if(kpLocal())setTimeout(kpServe,0);
  if(changed)persist();
  return changed;
}
