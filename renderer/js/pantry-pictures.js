/* Pictures for pantry items that came in without one. An item the Agent bought, or found on an order he placed
   himself, is matched by name to that order's item: its picture if the order had one, otherwise the picture on
   its product page (main: agent/previews.js kitchen:picture). Runs on the computer a little after start-up and
   every half hour; the phone gets the pictures through sync. Items he typed in himself and that no order has
   keep their letter. */

/* the pantry items with no picture that an order can give one: [{id, image}] when the order item had a picture,
   [{id, url}] when only its product page is known. same(a, b): whether two food names are the same food */
function ppSources(items,tasks,same){
  const https=function(s){ return !!s&&/^https:\/\//i.test(String(s)); };
  const ordered=[];
  (Array.isArray(tasks)?tasks:[]).forEach(function(t){
    if(!t)return;
    const orders=(Array.isArray(t.orders)?t.orders:[]).concat(t.lastOrder?[t.lastOrder]:[]);
    orders.forEach(function(o){ (o&&Array.isArray(o.items)?o.items:[]).forEach(function(it){ if(it&&it.name)ordered.push(it); }); });
  });
  const out=[];
  (Array.isArray(items)?items:[]).forEach(function(p){
    if(!p||!p.id||!p.name||https(p.image))return;
    const match=ordered.filter(function(it){ return same(p.name,String(it.name).split(',')[0].trim()); });
    const pic=match.find(function(it){ return https(it.image); });
    if(pic){ out.push({id:p.id,image:String(pic.image)}); return; }
    const page=match.find(function(it){ return https(it.url); });
    if(page)out.push({id:p.id,url:String(page.url)});
  });
  return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { ppSources };

if (typeof document !== 'undefined') {
  const ppTried=new Set(); // product pages already asked this session, picture or not
  let ppBusy=false;
  const ppFill=async function(){
    if(ppBusy||typeof state==='undefined'||!state.kitchen||typeof sameFood!=='function')return;
    ppBusy=true;
    try{
      const ask=window.desktop&&window.desktop.kitchenPicture;
      let changed=false, asked=0;
      for(const s of ppSources(state.kitchen.items,state.tasks,sameFood)){
        let img=s.image||null;
        if(!img&&s.url&&ask&&!ppTried.has(s.url)&&asked<25){
          ppTried.add(s.url); asked++;
          img=await ask(s.url).catch(function(){ return null; });
        }
        const p=img&&/^https:\/\//i.test(String(img))&&state.kitchen.items.find(function(i){ return i.id===s.id; });
        if(p&&!p.image){ p.image=String(img).slice(0,600); p.updatedAt=Date.now(); changed=true; }
      }
      if(changed&&typeof kSave==='function')kSave();
    }finally{ ppBusy=false; }
  };
  window.addEventListener('load',function(){
    setTimeout(ppFill,8000); // after start-up and the first sync
    setInterval(ppFill,30*60*1000);
  });
}
