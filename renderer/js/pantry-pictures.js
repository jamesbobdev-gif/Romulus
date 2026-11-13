/* Pictures for pantry items that came in without one. An item the Agent bought, or found on an order he placed
   himself, is matched by name to that order's item: its picture if the order had one, otherwise the picture on
   its product page (main: agent/previews.js kitchen:picture). An order read from his Instacart account can come
   with neither, so once he has an Instacart order, anything still without a picture is looked up there by name
   (kitchen:pictureFor: the closest product's picture). Runs on the computer a little after start-up and every
   half hour; the phone gets the pictures through sync. With no Instacart order, items he typed in himself keep
   their letter. The same pass moves a size left in a name into the amount (kitchen.js kFixSized) and, once,
   gives amounts to items that came from an order with none (ppAmounts). */

// a store's product name without its size: "Salmon, Skin On (2 lb)" → "Salmon"
const ppBase=function(n){ return String(n||'').replace(/\s*\([^()]*\)\s*$/,'').split(',')[0].trim(); };
// every item on every order the tasks keep, newest order first
function ppOrdered(tasks){
  const orders=[];
  (Array.isArray(tasks)?tasks:[]).forEach(function(t){
    if(!t)return;
    (Array.isArray(t.orders)?t.orders:[]).concat(t.lastOrder?[t.lastOrder]:[]).forEach(function(o){ if(o&&Array.isArray(o.items))orders.push(o); });
  });
  orders.sort(function(a,b){ return (b.at||0)-(a.at||0); });
  const out=[];
  orders.forEach(function(o){ o.items.forEach(function(it){ if(it&&it.name)out.push(it); }); });
  return out;
}
/* the pantry items with no picture and where one can come from: [{id, image}] when the order item had a picture,
   [{id, url}] when only its product page is known, [{id, find: name}] to look up by name when he shops on
   Instacart. same(a, b): whether two food names are the same food */
function ppSources(items,tasks,same){
  const https=function(s){ return !!s&&/^https:\/\//i.test(String(s)); };
  const ordered=ppOrdered(tasks);
  const instacart=(Array.isArray(tasks)?tasks:[]).some(function(t){
    return t&&(Array.isArray(t.orders)?t.orders:[]).some(function(o){ return o&&/instacart/i.test(String(o.store||'')); });
  });
  const out=[];
  (Array.isArray(items)?items:[]).forEach(function(p){
    if(!p||!p.id||!p.name||https(p.image)||p.picOwn)return; // a picture he took himself stays, even one that won't load here
    const match=ordered.filter(function(it){ return same(p.name,ppBase(it.name)); });
    const pic=match.find(function(it){ return https(it.image); });
    if(pic){ out.push({id:p.id,image:String(pic.image)}); return; }
    const page=match.find(function(it){ return https(it.url); });
    if(page){ out.push({id:p.id,url:String(page.url)}); return; }
    if(instacart&&ppBase(p.name))out.push({id:p.id,find:ppBase(p.name)});
  });
  return out;
}
/* the pantry pictures to check again against the product page: ones taken from an order he placed himself (read
   off his order history, where an item could get the picture of the row next to it: the tuna showing the
   potatoes), when that order item has a page. Not a picture he took himself (picOwn). → [{id, url, old}] */
function ppRecheck(items,tasks,same){
  const self=[];
  (Array.isArray(tasks)?tasks:[]).forEach(function(t){
    (t&&Array.isArray(t.orders)?t.orders:[]).forEach(function(o){
      if(o&&o.self&&Array.isArray(o.items))o.items.forEach(function(it){ if(it&&it.name&&it.image&&it.url)self.push(it); });
    });
  });
  const out=[];
  (Array.isArray(items)?items:[]).forEach(function(p){
    if(!p||!p.id||!p.name||!p.image||p.picOwn)return;
    const it=self.find(function(x){ return String(x.image)===String(p.image)&&/^https:\/\//i.test(String(x.url))&&same(p.name,ppBase(x.name)); });
    if(it)out.push({id:p.id,url:String(it.url),old:String(p.image)});
  });
  return out;
}
/* the pantry items with no amount that an order gives one: [{id, qty, unit}], the size in the newest matching
   order item's name times how many he got. sized: kitchen.js kSized */
function ppAmounts(items,tasks,same,sized){
  const ordered=ppOrdered(tasks);
  const out=[];
  (Array.isArray(items)?items:[]).forEach(function(p){
    if(!p||!p.id||!p.name||p.qty!=null)return;
    for(const it of ordered){
      if(!same(p.name,ppBase(it.name)))continue;
      const s=sized(it.name);
      if(s.qty==null)continue;
      out.push({id:p.id,qty:Math.round(s.qty*(it.qty>1?it.qty:1)*100)/100,unit:s.unit});
      return;
    }
  });
  return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { ppSources, ppAmounts, ppRecheck };

if (typeof document !== 'undefined') {
  const ppTried=new Set(); // product pages already asked this session, picture or not
  let ppBusy=false;
  const ppFill=async function(){
    if(ppBusy||typeof state==='undefined'||!state.kitchen||typeof sameFood!=='function')return;
    ppBusy=true;
    try{
      const ask=window.desktop&&window.desktop.kitchenPicture, find=window.desktop&&window.desktop.kitchenPictureFor;
      let changed=false, asked=0;
      // amounts: a size still in a name, every pass; from the orders, once on this device (after that an amount
      // he clears stays cleared)
      if(typeof kFixSized==='function'&&kFixSized(state.kitchen,Date.now()))changed=true;
      let once=true; try{ once=localStorage.getItem('ppAmountsDone')!=='1'; }catch(e){}
      if(once&&typeof kSized==='function'){
        ppAmounts(state.kitchen.items,state.tasks,sameFood,kSized).forEach(function(a){
          const p=state.kitchen.items.find(function(i){ return i.id===a.id; });
          if(p&&p.qty==null){ p.qty=a.qty; p.unit=a.unit; p.updatedAt=Date.now(); changed=true; }
        });
        try{ localStorage.setItem('ppAmountsDone','1'); }catch(e){}
      }
      // once on the computer: order pictures that may be the neighbouring item's get the product page's own
      let recheck=false; try{ recheck=!!ask&&localStorage.getItem('ppRecheck1')!=='1'; }catch(e){}
      if(recheck){
        for(const r of ppRecheck(state.kitchen.items,state.tasks,sameFood)){
          const img=await ask(r.url).catch(function(){ return null; });
          if(!img||!/^https:\/\//i.test(String(img))||String(img)===r.old)continue;
          const p=state.kitchen.items.find(function(i){ return i.id===r.id; });
          if(p&&String(p.image)===r.old&&!p.picOwn){ p.image=String(img).slice(0,600); p.updatedAt=Date.now(); changed=true; }
          state.tasks.forEach(function(t){ (Array.isArray(t.orders)?t.orders:[]).forEach(function(o){ (o&&Array.isArray(o.items)?o.items:[]).forEach(function(it){
            if(it&&String(it.image)===r.old&&String(it.url)===r.url){ it.image=String(img).slice(0,500); t.updatedAt=Date.now(); changed=true; }
          }); }); });
        }
        try{ localStorage.setItem('ppRecheck1','1'); }catch(e){}
      }
      for(const s of ppSources(state.kitchen.items,state.tasks,sameFood)){
        let img=s.image||null;
        if(!img&&s.url&&ask&&!ppTried.has(s.url)&&asked<25){
          ppTried.add(s.url); asked++;
          img=await ask(s.url).catch(function(){ return null; });
        }
        if(!img&&s.find&&find&&!ppTried.has('find:'+s.find)&&asked<25){
          ppTried.add('find:'+s.find); asked++;
          img=await find(s.find).catch(function(){ return null; });
        }
        const p=img&&/^https:\/\//i.test(String(img))&&state.kitchen.items.find(function(i){ return i.id===s.id; });
        if(p&&!p.picOwn&&!p.image){ p.image=String(img).slice(0,600); p.updatedAt=Date.now(); changed=true; }
      }
      if(changed&&typeof kSave==='function')kSave();
    }finally{ ppBusy=false; }
  };
  window.addEventListener('load',function(){
    setTimeout(ppFill,8000); // after start-up and the first sync
    setInterval(ppFill,30*60*1000);
  });
}
