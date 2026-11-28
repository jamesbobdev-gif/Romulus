/* Settings that are the same on every device: the look (light / dark / custom, the custom CSS, saved themes),
   which tabs show, the Kitchen week plan and recent aims, the EBT switch, and the Romulus cloud always / never
   answer. Each used to live in one device's localStorage, so a phone and a computer drifted apart.
   They travel in their own row next to the personal list (<personal key>:settings,
   supabase/migrations/20261127_sync_settings_key.sql), sealed like the list when the lists are encrypted, as
   {v:1, s:{<localStorage key>: {v: the saved text or null, at: when it was last changed}}}.
   The code that saves each setting is untouched: before every sync this looks at what is saved now, and a
   value that differs from the one it saw last was changed here, at that moment. The newer change wins, key
   by key. What a device had before it first ran this counts as old (at 1), and a setting never touched
   counts as nothing, so a computer nobody set up can't overwrite the one he did.
   Keys and sign-ins are not here and never will be (main/store.js).
   The top part has no DOM in it, so test/shared-settings.test.js can load it in Node. */
'use strict';

const SHARED_KEYS=['tasks.themeMode.v1','tasks.theme.v1','tasks.themes.v1','tabsOff','tabsTouched',
  'kitchen.week.v1','kitchen.week.slots.v1','kitchen.aims.v1','ebt.on','tasks.cloudAgent'];
const SHARED_TAB_KEYS=['tabsOff','tabsTouched']; // left out on a device set to keep its own tabs
const SHARED_SFX=':settings';

/* stamps: {key: {at, seen}}: when this device last saw the key change, and the text it held then (null = not set).
   values: {key: text or null} as saved now. → the stamps, with every change since the last look marked now */
function sharedNote(stamps,values,keys,now){
  const out=Object.assign({},stamps);
  keys.forEach(function(k){
    const cur=values[k]==null?null:String(values[k]), s=out[k];
    if(!s)out[k]={at:cur==null?0:1,seen:cur}; // the first look: what was already here is old, and nothing is nothing
    else if(s.seen!==cur)out[k]={at:now,seen:cur};
  });
  return out;
}
/* this device's stamps against the shared record → {set: {key: text or null} to save here, stamps, doc: the
   record to upload, changedRemote}. The newer change wins; on a tie the shared one does, so every device lands
   on the same value */
function sharedMerge(stamps,doc,keys){
  const remote=(doc&&doc.s&&typeof doc.s==='object')?doc.s:{};
  const s=Object.assign({},remote), outStamps=Object.assign({},stamps), set={};
  let changedRemote=false;
  keys.forEach(function(k){
    const l=outStamps[k]||{at:0,seen:null}, r=remote[k];
    const rAt=r&&typeof r.at==='number'?r.at:0, rV=r&&r.v!=null?String(r.v):null;
    if(rAt>0&&(rAt>l.at||(rAt===l.at&&rV!==l.seen))){
      if(rV!==l.seen)set[k]=rV;
      outStamps[k]={at:rAt,seen:rV};
    } else if(l.at>rAt){
      s[k]={v:l.seen,at:l.at}; changedRemote=true;
    }
  });
  return {set:set,stamps:outStamps,doc:{v:1,s:s},changedRemote:changedRemote};
}

if(typeof module!=='undefined'&&module.exports){
  module.exports={sharedNote,sharedMerge,SHARED_KEYS,SHARED_TAB_KEYS};
} else {
  const SHARED_STAMPS_KEY='tasks.shared.stamps', SHARED_TABS_OWN_KEY='tabsOwn';
  const sharedState={unsupported:false,err:null};
  // this device keeps its own tabs (Settings > Tabs): a phone may want fewer than the computer
  function sharedTabsOwn(){ try{ return localStorage.getItem(SHARED_TABS_OWN_KEY)==='1'; }catch(e){ return false; } }
  function sharedSetTabsOwn(own){
    try{
      if(own)localStorage.setItem(SHARED_TABS_OWN_KEY,'1'); else localStorage.removeItem(SHARED_TABS_OWN_KEY);
      // back to shared: whatever the other devices show wins over what this one chose meanwhile
      if(!own){ const st=sharedStampsLoad(); SHARED_TAB_KEYS.forEach(function(k){ delete st[k]; }); localStorage.setItem(SHARED_STAMPS_KEY,JSON.stringify(st)); }
    }catch(e){}
    if(typeof syncNow==='function')syncNow();
  }
  window.sharedTabsOwn=sharedTabsOwn; window.sharedSetTabsOwn=sharedSetTabsOwn;
  function sharedKeys(){ return sharedTabsOwn()?SHARED_KEYS.filter(function(k){ return SHARED_TAB_KEYS.indexOf(k)<0; }):SHARED_KEYS; }
  function sharedStampsLoad(){ try{ const s=JSON.parse(localStorage.getItem(SHARED_STAMPS_KEY)||'{}'); return s&&typeof s==='object'?s:{}; }catch(e){ return {}; } }
  function sharedProfile(){
    const p=syncState.cfg&&syncState.cfg.personal;
    return validProfile(p)?{url:p.url,key:p.key,syncKey:p.syncKey+SHARED_SFX}:null;
  }
  // a setting that came from another device: show it now, the way its own Settings control would have
  function sharedApply(keys){
    const has=function(re){ return keys.some(function(k){ return re.test(k); }); };
    try{
      if(has(/^tasks\.theme/)){
        applyThemeMode(themeModeSaved());
        ['drawThemeModes','drawThemeColors','drawThemeSaved'].forEach(function(f){ if(typeof window[f]==='function')window[f](); });
      }
      if(has(/^tabs/)){ applyTabsOff(); drawTabPicker(); }
      if(has(/^kitchen\./)&&state.activeTab==='kitchen'&&typeof renderKitchen==='function')renderKitchen();
      if(keys.indexOf('ebt.on')>=0){
        let v=null; try{ v=localStorage.getItem('ebt.on'); }catch(e){}
        // the computer's Agent side follows the switch too (grocery-list.js setEbtOn)
        if(v!=null&&window.desktop&&window.desktop.financeSetEbtOn)window.desktop.financeSetEbtOn(v==='1').catch(function(){});
        if(typeof render==='function')render();
      }
    }catch(e){}
  }
  /* Called from sync.js on every sync. → true when a setting changed here. Never throws: the lists sync either
     way. Until the database takes the ':settings' row (that migration) each device keeps its own, as before. */
  async function sharedSync(){
    const p=sharedProfile(); if(!p||sharedState.unsupported)return false;
    let changed=false;
    try{
      for(let attempt=0;attempt<4;attempt++){
        const row=await syncPullRow(p);
        const keys=sharedKeys(), values={};
        keys.forEach(function(k){ try{ values[k]=localStorage.getItem(k); }catch(e){ values[k]=null; } });
        const r=sharedMerge(sharedNote(sharedStampsLoad(),values,keys,Date.now()),row.doc,keys);
        const got=Object.keys(r.set);
        got.forEach(function(k){ try{ if(r.set[k]==null)localStorage.removeItem(k); else localStorage.setItem(k,r.set[k]); }catch(e){} });
        try{ localStorage.setItem(SHARED_STAMPS_KEY,JSON.stringify(r.stamps)); }catch(e){}
        if(got.length){ changed=true; sharedApply(got); }
        if(!r.changedRemote)break;
        if(await syncPushCas(p,r.doc,row.updatedAt))break;
        if(attempt===0){ // refused outright: a database without the ':settings' key yet
          try{ const u=await syncRpc(p,'sync_usage',{p_sync_key:await syncRowKey(p)}); if(Array.isArray(u)&&u.length===0){ sharedState.unsupported=true; break; } }catch(e){}
        }
      }
      sharedState.err=null;
    }catch(e){ sharedState.err=String((e&&e.message)||e); }
    return changed;
  }
  window.sharedSync=sharedSync;
}
