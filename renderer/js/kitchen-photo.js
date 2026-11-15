/* Pantry photos, in the Kitchen tab (kitchen.js draws the tab and calls kpDraw):
   - Pantry → "Add from a photo or receipt": a picture of groceries, or the receipt for them. His AIs list the food in it; he ticks what to add and
     fixes any amount, then it goes in the way the Agent's orders do (stockPantry: a known size adds to what's there).
   - Meals → "Made something? Say what": he types what he made (or picks "Photo" for a picture of it). His AIs say which pantry foods it used and about how
     much; the sure ones come out of the pantry right away (usePantry), with an Undo. The rest become one short
     to-do ("Rice is used up" to check off), which pantryAnswers reads back here or after a sync from the phone.
   On a computer the asking is main/kitchen-ai.js kitchen:photo (prompt in renderer/js/pantry-photo.js). The phone has
   no AI of its own: with his keys copied over (phone-ai.js) it asks them itself; without, it uploads the picture (agent-attachments, like a task's photos) and leaves an ask in the
   synced kitchen row; a computer with AI connections, or Lupa, reads it on its next sync (kpServe) and writes
   the answer back, and the phone uses it (kpCollect): the same checklist, or the meal taken out of the pantry.
   - Shopping list → "Photo": a handwritten list, an empty package, a recipe page or a screenshot. His AIs list what
     to buy; he ticks what to add and it goes on the shopping list (kitchen.js addToShop). Mode 'shop', same asks.
   When a pantry or shopping picture can't be read (too dark, blurry, far away) the answer says so (retake) and the
   card has a Retake button in place of the list. When part of it can't be read (labels turned away, the receipt
   cut off, a size on the back of the package) the list comes with that (more) and a "Take another picture" button:
   the next picture is read the same way and its items join the list (kpJoin), so the back of a package or the other
   shelf adds to what the first picture found. Both work the same through a computer (the ask's result carries them).
   The phone's "Suggest meals" (kitchen.js kAskIdeas) rides the same asks, mode 'ideas', when the phone has no keys
   of its own: the computer that takes it asks main/kitchen-ai.js kitchen:ideas and puts the meals in
   state.kitchen.ideas, which syncs to every device. With his keys on the phone it asks them itself (kIdeasFromPhone). */

// food, shop: {items:[{line, on, have}], via, retake, more, askId?, moreAskId?}; meal: {name, took, asked, todoId, before, via}
const kpUI={busy:'',why:'',whyFor:'',food:null,meal:null,shop:null};

function kpAvailable(){ return kpLocal()||kpPhoneAi()||kpRemote(); }
// the phone with his AI keys copied over (phone-ai.js): it reads the photo itself, no computer needed
function kpPhoneAi(){ return !kpLocal()&&!!(window.phoneAi&&window.phoneAi.ready()); }
/* one picture → food: {items, via}; meal: {meal, used, via}; or {why}. The computer asks in its main process
   (main/kitchen-ai.js), the phone asks its own keys with the same prompt (pantry-photo.js) */
async function kpRead(mode,image,pantry,said){
  if(kpLocal())return window.desktop.kitchenPhoto({mode:mode,image:image,pantry:pantry,said:said||''});
  if(mode==='meal'&&!pantry.length)return {why:'The pantry is empty, so there is nothing to take out.'};
  const r=await window.phoneAi.ask(pantryPhotoPrompt(mode,pantry,said),said?null:image);
  if(!r||!r.text)return {why:(r&&r.why)||'No answer.'};
  return pantryPhotoResult(mode,pantryPhotoParse(mode,r.text),r.via);
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

// into: the food or shop checklist already up, when this is the other picture it asked for (its items join it)
async function kpAsk(mode,file,into){
  if(kpUI.busy||!file)return;
  kpUI.busy=mode; kpUI.why=''; kpUI.whyFor=mode;
  if(mode==='food'){ if(!into)kpUI.food=null; kpUI.foodFile=into?null:file; }
  if(mode==='shop'&&!into)kpUI.shop=null;
  kpRedraw();
  if(!kpLocal()&&!kpPhoneAi()){
    const id=await kpSend(mode,file);
    if(into&&id)into.moreAskId=id; // the list waits for it (kpCollect joins the answer)
    kpUI.busy=''; kpRedraw(); return;
  }
  try{
    const image=await kpShrink(file);
    const r=await kpRead(mode,image,kpPantryList());
    if(!r||r.why)kpUI.why=(r&&r.why)||'No answer. Try again.';
    else if(mode==='food'||mode==='shop')kpUI[mode]=into?kpJoin(into,kpChecklist(mode,r)):kpChecklist(mode,r);
    else kpMealApply(r);
  }catch(e){ kpUI.why=e&&e.message==='not a picture'?'That file isn’t a picture.':'Couldn’t read the picture: '+(e&&e.message||e); }
  kpUI.busy=''; kpRedraw();
}
// Retake: the unreadable picture's card goes (and its ask is done with), and the new picture is read fresh
function kpRetake(mode,file){ if(kpUI.busy||!file)return; kpDone(mode); kpAsk(mode,file); }
/* the other picture's list joins the one up: a food the list already has stays as he left it, the rest go on
   the end. What that picture said about itself (unclear again, or more still hidden) becomes the list's more. */
function kpJoin(cur,add){
  cur.items=cur.items.concat(add.items.filter(function(x){
    const n=(parseIngredient(x.line)||{name:x.line}).name;
    return !cur.items.some(function(y){ return sameFood((parseIngredient(y.line)||{name:y.line}).name,n); });
  }));
  cur.more=add.retake||add.more||'';
  if(add.via)cur.via=add.via;
  cur.moreAskId=null;
  return cur;
}
// the other picture a list asked for is still out with a computer (so its button waits)
function kpMoreLive(f){
  return !!(f.moreAskId&&(state.kitchen.asks||[]).some(function(a){ return a.id===f.moreAskId&&(a.state==='waiting'||a.state==='reading'); }));
}

// a meal he typed ("chicken and rice"): the same as a photo of it, with no picture
async function kpAskSaid(said){
  said=String(said||'').trim().slice(0,300);
  if(kpUI.busy||!said)return false;
  kpUI.busy='meal'; kpUI.why=''; kpUI.whyFor='meal'; kpRedraw();
  if(!kpLocal()&&!kpPhoneAi()){ kpSendSaid(said); kpUI.busy=''; kpRedraw(); return true; }
  let ok=false;
  try{
    const r=await kpRead('meal',null,kpPantryList(),said);
    if(!r||r.why)kpUI.why=(r&&r.why)||'No answer. Try again.';
    else{ kpMealApply(r); ok=true; }
  }catch(e){ kpUI.why='Couldn’t work it out: '+(e&&e.message||e); }
  kpUI.busy=''; kpRedraw();
  return ok;
}
function kpSendSaid(said){
  const now=Date.now();
  if(!Array.isArray(state.kitchen.asks))state.kitchen.asks=[];
  state.kitchen.asks.push({id:uid(),mode:'meal',url:'',said:said,from:kpMe(),at:now,updatedAt:now,state:'waiting',reader:'',readAt:0,why:''});
  persist(); if(typeof schedulePush==='function')schedulePush();
  voiceToast('Sent to your computer to work out');
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
// what a picture listed → the checklist he ticks: {via, items:[{line, on, have}], retake, more}. have: in the pantry
// already (food), or on the shopping list already (shop). retake: the picture couldn't be read (no items); more:
// what another picture should show
function kpChecklist(mode,r,askId){
  const k=state.kitchen;
  const out={via:r.via||'',items:(Array.isArray(r.items)?r.items:[]).map(function(x){
    const have=mode==='shop'?(k.extra||[]).some(function(e){ return sameFood(e.name,x.name); }):!!pantryFind(k.items,x.name);
    return {line:(x.amount?x.amount+' ':'')+x.name,on:true,have:have};
  }),retake:String(r.retake||'').slice(0,200),more:String(r.more||'').slice(0,200)};
  if(out.items.length)out.retake=''; else if(!out.retake)out.retake='Nothing in that picture could be read.';
  if(askId)out.askId=askId;
  return out;
}
function kpShopAdd(){
  const f=kpUI.shop; if(!f)return;
  const added=addToShop(state.kitchen,f.items.filter(function(x){ return x.on; }).map(function(x){ return x.line; }),Date.now(),uid);
  kpDone('shop'); persist();
  voiceToast(added.length?'On the shopping list: '+added.join(', '):'Nothing added');
  kpRedraw();
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
  // a picture of just one food: that is the item's picture too, kept like one he took of it (kitchen.js kSetOwnPic)
  const ask=f.askId&&(state.kitchen.asks||[]).find(function(a){ return a.id===f.askId; });
  const shot=f.items.length===1&&added.length===1?(ask&&ask.url)||(!f.askId&&kpUI.foodFile)||null:null;
  const one=shot&&pantryFind(state.kitchen.items,added[0]);
  if(one&&!one.picOwn&&typeof kSetOwnPic==='function')kSetOwnPic(one.id,shot).then(function(ok){ if(ok)kpRedraw(); },function(){});
  kpUI.foodFile=null;
  kpDone('food'); persist();
  voiceToast(added.length?'Added to the pantry: '+added.join(', '):'Nothing added');
  kpRedraw();
}

// onPick(mode, file): what the picture is for; kpAsk, a fresh read, unless told otherwise
function kpPickBtn(mode,label,title,onPick){
  const pick=document.createElement('input'); pick.type='file'; pick.accept='image/*'; pick.hidden=true;
  pick.setAttribute('capture','environment'); // the camera on a phone or tablet; a file picker on a computer
  const b=el('button',mode==='meal'?'btn-accent':'ghost',kpUI.busy===mode?'Reading the picture…':label);
  b.title=title; b.disabled=!!kpUI.busy;
  b.addEventListener('click',function(){ pick.click(); });
  pick.addEventListener('change',function(){ const f=pick.files&&pick.files[0]; pick.value=''; (onPick||kpAsk)(mode,f); });
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

// mode 'food' (the Pantry view), 'meal' (the Meals view) or 'shop' (the Shopping list: the button in box, the rest in under)
function kpDraw(mode,box,under){
  if(!box)return; box.innerHTML='';
  if(!kpAvailable())return;
  if(mode==='shop'){
    const pick=kpPickBtn('shop','Photo','Add from a photo: a handwritten list, an empty package, a recipe or a screenshot. Lupa reads it if it’s set up, otherwise your AI connections');
    box.appendChild(pick);
    under=under||box;
    kpDrawWaiting('shop',under);
    if(kpUI.why&&kpUI.busy===''&&kpUI.whyFor==='shop')under.appendChild(el('div','kit-empty',kpUI.why)); // with a list up too: its other picture failed
    const f=kpUI.shop; if(!f)return;
    if(f.retake)kpDrawRetake(under,'shop',f,'Take it again closer, holding the phone still, with the whole list in the picture.');
    else kpDrawChecklist(under,'shop',f,'Found in the picture','Untick anything you don’t want, and fix an amount if it’s off.','already on the list','Add to shopping list',kpShopAdd,function(){ kpDone('shop'); persist(); kpRedraw(); });
    return;
  }
  if(mode==='food'){
    const plus=kpPickBtn('food','+','Add from a photo or receipt: a picture of groceries you’re putting away, or of the receipt. Lupa reads it if it’s set up, otherwise your AI connections');
    const pb=plus.querySelector('button'); pb.className='ghost kp-plus'; pb.setAttribute('aria-label','Add from a photo or receipt');
    if(kpUI.busy==='food')pb.textContent='…';
    box.appendChild(plus);
    kpDrawWaiting('food',box);
    if(kpUI.why&&kpUI.busy===''&&kpUI.whyFor==='food')box.appendChild(el('div','kit-empty',kpUI.why));
    const f=kpUI.food; if(!f)return;
    if(f.retake)kpDrawRetake(box,'food',f,'Take it again closer, with the light on and the labels facing the camera.');
    else kpDrawChecklist(box,'food',f,'Found in the picture','Untick anything you don’t want added, and fix an amount if it’s off.','adds to what you have','Add to pantry',kpFoodAdd,function(){ kpDone('food'); persist(); kpRedraw(); });
    return;
  }
  // typing what he made is the main way; a photo is there for anyone who'd rather
  const row=el('div','kit-form kp-row');
  const said=el('input','sm kit-grow'); said.placeholder='Made something? Say what: chicken and rice, 2 eggs and toast';
  said.setAttribute('aria-label','What you made'); said.maxLength=300; said.disabled=!!kpUI.busy;
  const go=el('button','btn-accent',kpUI.busy==='meal'?'Working it out…':'Take out of pantry');
  go.title='Your AIs work out which pantry foods it used, and those come out of the pantry'; go.disabled=!!kpUI.busy;
  const send=async function(){ const v=said.value; if(!v.trim())return; if(await kpAskSaid(v))said.value=''; };
  go.addEventListener('click',send);
  said.addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); send(); } });
  row.appendChild(said); row.appendChild(go);
  const photo=kpPickBtn('meal','Photo','Or a picture of what you made instead of typing it');
  photo.querySelector('button').className='ghost';
  row.appendChild(photo);
  box.appendChild(row);
  kpDrawWaiting('meal',box);
  if(!state.kitchen.items.length&&!kpUI.meal){ row.querySelectorAll('button,input').forEach(function(b){ b.disabled=true; }); said.placeholder='Add food to the Pantry first, then say what you made here'; return; }
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
// the ticklist a picture came back as, with its one button; and, when part of the picture couldn't be read, what
// another picture should show with a button to take it (that picture's items join this list)
function kpDrawChecklist(box,mode,f,title,hint,haveText,addText,onAdd,onClose){
  const card=kpCard(title+(f.via?' (read by '+f.via+')':''),onClose);
  card.appendChild(el('div','kit-hint',hint));
  f.items.forEach(function(x){
    const r=el('label','kit-after-row kp-item');
    const c=document.createElement('input'); c.type='checkbox'; c.checked=x.on;
    c.addEventListener('change',function(){ x.on=c.checked; });
    const t=el('input','sm kit-grow'); t.value=x.line; t.setAttribute('aria-label','Item and amount');
    t.addEventListener('input',function(){ x.line=t.value.slice(0,120); });
    r.appendChild(c); r.appendChild(t);
    if(x.have)r.appendChild(el('span','kit-hint',haveText));
    card.appendChild(r);
  });
  if(f.more&&!kpMoreLive(f)){
    const row=el('div','kit-after-row kp-more');
    row.appendChild(el('span','kit-hint','Not all of it could be read. '+f.more));
    row.appendChild(kpPickBtn(mode,'Take another picture','What it finds is added to this list',function(m,file){ kpAsk(m,file,f); }));
    card.appendChild(row);
  }
  const btns=el('div','kit-card-btns');
  const add=el('button','btn-accent',addText); add.addEventListener('click',onAdd);
  btns.appendChild(add); card.appendChild(btns);
  box.appendChild(card);
}
// a picture nothing could be read from: why, how to take it again, and a Retake button in place of the list
function kpDrawRetake(box,mode,f,how){
  const card=kpCard('Couldn’t read that picture'+(f.via?' (read by '+f.via+')':''),function(){ kpDone(mode); persist(); kpRedraw(); });
  card.appendChild(el('div','kit-after-row',f.retake));
  card.appendChild(el('div','kit-hint',how));
  const btns=el('div','kit-card-btns');
  const again=kpPickBtn(mode,'Retake','Take the picture again',kpRetake);
  again.querySelector('button').className='btn-accent';
  btns.appendChild(again); card.appendChild(btns);
  box.appendChild(card);
}
// the checklist closed (added, or he closed it): a phone's ask for it is done with
function kpDone(mode){
  const f=kpUI[mode]; kpUI[mode]=null;
  const a=f&&f.askId&&(state.kitchen.asks||[]).find(function(x){ return x.id===f.askId; });
  if(a)kpSetAsk(a,{state:'applied',result:null});
}

/* ── the phone: send the picture to a computer ── */
// → the ask's id, or null when the picture couldn't be sent
async function kpSend(mode,file){
  try{
    const blob=await shrinkImage(file);
    const url=await uploadAttachment(blob);
    const now=Date.now(), id=uid();
    if(!Array.isArray(state.kitchen.asks))state.kitchen.asks=[];
    state.kitchen.asks.push({id:id,mode:mode,url:url,from:kpMe(),at:now,updatedAt:now,state:'waiting',reader:'',readAt:0,why:''});
    persist(); if(typeof schedulePush==='function')schedulePush();
    voiceToast('Sent to your computer to read');
    return id;
  }catch(e){ kpUI.why='Couldn’t send the picture: '+(e&&e.message||e); return null; }
}
// his photos still out with a computer, with a way to stop waiting
function kpDrawWaiting(mode,box){
  kpMyAsks().filter(function(a){ return a.mode===mode&&(a.state==='waiting'||a.state==='reading'); }).forEach(function(a){
    const row=el('div','kit-after-row kp-wait');
    const mins=Math.round((Date.now()-a.at)/60000);
    const ideas=a.mode==='ideas', what=a.said?'“'+a.said+'”':'your photo';
    row.appendChild(el('span','kit-hint',a.state==='reading'?(a.reader||'Your computer')+(ideas?' is thinking of meals…':' is reading '+what+'…')
      :(ideas?'Waiting for your computer to think of meals':'Waiting for your computer to read '+what)+(mins>=10?'. Romulus needs to be open on your computer or on Lupa.':'…')));
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
      if(a.mode==='ideas'){ if(typeof window.kitchenIdeasFailed==='function')window.kitchenIdeasFailed('Your computer couldn’t suggest meals: '+(a.why||'no answer')); }
      else{ kpUI.why='Your computer couldn’t read the photo: '+(a.why||'no answer'); kpUI.whyFor=a.mode; }
      kpSetAsk(a,{state:'applied'}); changed=true; return;
    }
    if(a.state!=='done'||!a.result)return;
    if(a.mode==='meal'){
      kpUI.meal=kpMealUse(a.result); voiceToast(kpMealToast(kpUI.meal));
      kpSetAsk(a,{state:'applied',result:null}); changed=true;
    } else if(a.mode==='food'||a.mode==='shop'){ // the checklist; the ask is applied once he adds or closes it
      const cur=kpUI[a.mode];
      if(cur&&cur.moreAskId===a.id){ // the other picture a list asked for: its items join the list, which this ask now carries
        const first=cur.askId&&(state.kitchen.asks||[]).find(function(x){ return x.id===cur.askId; });
        if(first){ kpSetAsk(first,{state:'applied',result:null}); changed=true; }
        kpJoin(cur,kpChecklist(a.mode,a.result,a.id)); cur.askId=a.id;
        voiceToast('Your other photo is read: check the list under Kitchen, '+(a.mode==='shop'?'Shopping list':'Pantry'));
      } else if(!cur){
        kpUI[a.mode]=kpChecklist(a.mode,a.result,a.id);
        voiceToast(kpUI[a.mode].retake?'Your photo couldn’t be read: see Kitchen, '+(a.mode==='shop'?'Shopping list':'Pantry')
          :'Your photo is read: check what to add under Kitchen, '+(a.mode==='shop'?'Shopping list':'Pantry'));
      }
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
    if(a.mode==='ideas'){ // the phone's Suggest meals: this computer's pantry is the same synced one
      r=window.desktop.kitchenIdeas?await window.desktop.kitchenIdeas({pantry:kpPantryList(),
        recipes:state.kitchen.recipes.map(function(x){ return {name:x.name,liked:x.liked}; }),aim:a.said}):{why:'Romulus on that computer needs an update first.'};
      if(r&&!r.why&&!(r.meals&&r.meals.length))r={why:'No ideas came back.'};
    }
    else if(a.mode==='meal'&&a.said)r=await window.desktop.kitchenPhoto({mode:'meal',said:a.said,pantry:kpPantryList()});
    else if(!kpOwnPic(a.url))r={why:'That picture isn’t in your own storage.'};
    else{
      const res=await fetch(a.url);
      if(!res.ok)r={why:'The picture couldn’t be downloaded ('+res.status+').'};
      else r=await window.desktop.kitchenPhoto({mode:a.mode,image:await kpShrink(await res.blob()),pantry:kpPantryList()});
    }
    const cur=(state.kitchen.asks||[]).find(function(x){ return x.id===a.id; }); // still there, and not moved on elsewhere
    if(cur&&cur.state==='reading'){
      if(!r||r.why)kpSetAsk(cur,{state:'failed',why:String((r&&r.why)||'No answer.').slice(0,200)});
      else if(a.mode==='ideas'){ // nothing for the phone to collect: the ideas themselves sync
        state.kitchen.ideas={at:Date.now(),via:r.via||'',aim:a.said,meals:r.meals};
        kpSetAsk(cur,{state:'applied'}); kpRedraw();
      }
      else kpSetAsk(cur,{state:'done',result:a.mode==='meal'?{meal:r.meal,used:r.used,via:r.via}:{items:r.items,via:r.via,retake:r.retake||'',more:r.more||''}});
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
