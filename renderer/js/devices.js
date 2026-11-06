/* Settings → Device sync → Devices: every device that syncs these lists, and taking one off.
   Every device holds the same sync key (the password to the lists), so the server can't tell devices apart
   and can't shut just one out. What this does instead:
   - Each device keeps an entry in the ':devices' row next to the personal list (encrypted like the list when
     the lists are v2): its name, kind, version, when it was last seen, and the public half of an ECDH P-256
     key pair it made for itself. The private half stays on the device, in IndexedDB, and can't be exported.
   - Removing a device (or Rotate sync key, which removes none) moves every list to a new sync key
     (syncRotateKey in settings.js), then leaves a hand-off in the OLD ':devices' row: the new settings sealed
     to each kept device's public key (ephemeral ECDH → HKDF → AES-GCM). A kept device reads its hand-off on
     its next sync and moves over by itself. The removed one finds no hand-off for itself, so it stops
     syncing: the new key never reached it. A device from before this (no key pair) has to be paired again.
   The pure parts (doc merge, labels, sealing) are module-loadable for test/devices.test.js. */
'use strict';

const DEVICES_SFX=':devices';
const DEVICES_BEAT_MS=60*60*1000; // seen at most once an hour: every write wakes the other devices
const DEVICES_SALT='romulus-device-handoff-v1';

// this device's entry in the doc ({name, kind, os, version, pub}) → the doc to write, other entries kept
function devicesWithMe(doc,id,me,now){
  const d=doc&&typeof doc==='object'?doc:{};
  const devices=Object.assign({},d.devices||{});
  const old=devices[id]||{};
  devices[id]=Object.assign({},old,me,{added:old.added||now,seen:now});
  const out=Object.assign({},d,{v:1,devices:devices});
  return out;
}
// does the doc need this device's heartbeat: missing, changed, or not seen for an hour
function devicesNeedBeat(doc,id,me,now){
  const e=doc&&doc.devices&&doc.devices[id];
  if(!e)return true;
  if(['name','kind','os','version'].some(function(k){ return (e[k]||null)!==(me[k]||null); }))return true;
  if(JSON.stringify(e.pub||null)!==JSON.stringify(me.pub||null))return true;
  return !(now-(e.seen||0)<DEVICES_BEAT_MS);
}
// the doc's devices, this one first, then the most recently seen
function devicesList(doc,myId){
  const d=(doc&&doc.devices)||{};
  return Object.keys(d).map(function(id){ return Object.assign({id:id,me:id===myId},d[id]); })
    .sort(function(a,b){ return (b.me-a.me)||((b.seen||0)-(a.seen||0)); });
}
function devicesSeenLabel(seen,now){
  if(!seen)return 'never seen';
  const m=Math.round((now-seen)/60000);
  if(m<DEVICES_BEAT_MS/60000+5)return 'active in the last hour';
  const h=Math.round(m/60);
  if(h<24)return 'seen '+h+' hours ago';
  const days=Math.round(h/24);
  return days===1?'seen yesterday':'seen '+days+' days ago';
}
function devicesKindLabel(e){
  const os=e.os||'';
  return e.kind==='phone'?(os?os+' phone':'Phone'):e.kind==='computer'?(os?os+' computer':'Computer'):'Browser';
}

/* sealing the new settings to one device's public key */
function devB64(bytes){ let s=''; new Uint8Array(bytes).forEach(function(b){ s+=String.fromCharCode(b); }); return btoa(s); }
function devUnB64(s){ return Uint8Array.from(atob(String(s)),function(c){ return c.charCodeAt(0); }); }
async function devAesFrom(subtle,priv,pub){
  const bits=await subtle.deriveBits({name:'ECDH',public:pub},priv,256);
  const hk=await subtle.importKey('raw',bits,'HKDF',false,['deriveKey']);
  return subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new TextEncoder().encode(DEVICES_SALT),info:new Uint8Array(0)},hk,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function devicesSeal(pubJwk,text){
  const subtle=crypto.subtle;
  const pub=await subtle.importKey('jwk',pubJwk,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const eph=await subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const key=await devAesFrom(subtle,eph.privateKey,pub);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await subtle.encrypt({name:'AES-GCM',iv:iv},key,new TextEncoder().encode(text));
  const epk=await subtle.exportKey('jwk',eph.publicKey);
  return {epk:{kty:epk.kty,crv:epk.crv,x:epk.x,y:epk.y},iv:devB64(iv),ct:devB64(ct)};
}
async function devicesOpen(privKey,sealed){
  const subtle=crypto.subtle;
  const epk=await subtle.importKey('jwk',sealed.epk,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const key=await devAesFrom(subtle,privKey,epk);
  const pt=await subtle.decrypt({name:'AES-GCM',iv:devUnB64(sealed.iv)},key,devUnB64(sealed.ct));
  return new TextDecoder().decode(pt);
}
// the hand-off for every kept device that has a key pair: {handoff:{id: sealed}, left:[names without one]}
async function devicesHandoff(doc,keepIds,text){
  const d=(doc&&doc.devices)||{}, handoff={}, left=[];
  for(const id of keepIds){
    const e=d[id]; if(!e)continue;
    if(e.pub)handoff[id]=await devicesSeal(e.pub,text); else left.push(e.name||'a device');
  }
  return {handoff:handoff,left:left};
}

if(typeof module!=='undefined'&&module.exports){
  module.exports={devicesWithMe,devicesNeedBeat,devicesList,devicesSeenLabel,devicesKindLabel,devicesSeal,devicesOpen,devicesHandoff,DEVICES_BEAT_MS};
} else {
  /* ── this device ── */
  const DEV_ID_KEY='tasks.deviceId', DEV_NAME_KEY='tasks.deviceName';
  const devState={doc:null,unsupported:false,info:null,keys:null,drawn:false};
  window.devState=devState;
  function deviceId(){
    let id=null; try{ id=localStorage.getItem(DEV_ID_KEY); }catch(e){}
    if(!id){ id='d_'+(crypto.randomUUID?crypto.randomUUID():devB64(crypto.getRandomValues(new Uint8Array(16)))).replace(/[^A-Za-z0-9_-]/g,''); try{ localStorage.setItem(DEV_ID_KEY,id); }catch(e){} }
    return id;
  }
  // the key pair: kept in IndexedDB as CryptoKeys, the private one not exportable. null where there's no IndexedDB
  function devIdb(){
    return new Promise(function(res,rej){
      const r=indexedDB.open('romulus-device',1);
      r.onupgradeneeded=function(){ r.result.createObjectStore('keys'); };
      r.onsuccess=function(){ res(r.result); }; r.onerror=function(){ rej(r.error); };
    });
  }
  function devIdbDo(mode,fn){
    return devIdb().then(function(db){ return new Promise(function(res,rej){
      const tx=db.transaction('keys',mode), q=fn(tx.objectStore('keys'));
      tx.oncomplete=function(){ db.close(); res(q&&q.result); }; tx.onerror=function(){ db.close(); rej(tx.error); };
    }); });
  }
  async function deviceKeys(){
    if(devState.keys)return devState.keys;
    try{
      let k=await devIdbDo('readonly',function(s){ return s.get('ecdh'); });
      if(!k||!k.priv||!k.pub){
        const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
        const j=await crypto.subtle.exportKey('jwk',pair.publicKey);
        k={priv:pair.privateKey,pub:{kty:j.kty,crv:j.crv,x:j.x,y:j.y}};
        await devIdbDo('readwrite',function(s){ return s.put(k,'ecdh'); });
      }
      devState.keys=k;
    }catch(e){ devState.keys={priv:null,pub:null}; }
    return devState.keys;
  }
  async function deviceMe(){
    if(!devState.info){
      let info={};
      if(window.desktop&&window.desktop.syncDeviceInfo){ try{ info=await window.desktop.syncDeviceInfo(); }catch(e){} }
      const phone=!!(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform());
      devState.info={name:info.name||(phone?'Phone':'Browser'),kind:info.os?'computer':phone?'phone':'browser',os:info.os||(phone?'Android':''),version:info.version||null};
    }
    let name=null; try{ name=localStorage.getItem(DEV_NAME_KEY); }catch(e){}
    const k=await deviceKeys();
    return {name:(name||devState.info.name).slice(0,60),kind:devState.info.kind,os:devState.info.os,version:devState.info.version,pub:k.pub};
  }
  window.deviceId=deviceId;
  window.deviceMe=deviceMe;
  window.devicesProfileOf=function(p){ return validProfile(p)?Object.assign({},p,{syncKey:p.syncKey+DEVICES_SFX}):null; };
  function devicesProfile(){ return devicesProfileOf(syncState.cfg&&syncState.cfg.personal); }

  // the server takes no ':devices' row until supabase/migrations/20261106_sync_devices_key.sql is in
  async function devicesRowRefused(p){
    try{ const r=await syncRpc(p,'sync_usage',{p_sync_key:await syncRowKey(p)}); return Array.isArray(r)&&r.length===0; }catch(e){ return false; }
  }
  /* Called at the start of each sync (sync.js syncOnce). → 'moved' (this device switched to a new sync key: sync
     again), 'off' (it was removed: sync is off now), or null. Never throws: the lists sync either way. */
  window.devicesTick=async function(){
    const p=devicesProfile(); if(!p||devState.unsupported)return null;
    try{
      const id=deviceId(), me=await deviceMe();
      for(let attempt=0;attempt<3;attempt++){
        const row=await syncPullRow(p);
        if(row.doc&&row.doc.rotated)return await devicesFollow(row.doc,id);
        devState.doc=row.doc;
        if(!devicesNeedBeat(row.doc,id,me,Date.now()))break;
        const next=devicesWithMe(row.doc,id,me,Date.now());
        if(await syncPushCas(p,next,row.updatedAt)){ devState.doc=next; break; }
        if(attempt===0&&await devicesRowRefused(p)){ devState.unsupported=true; break; }
      }
    }catch(e){ /* the devices list is a nicety; the lists sync without it */ }
    devicesDraw();
    return null;
  };
  // the sync key changed on another device: take this device's hand-off, or stop syncing if there's none
  async function devicesFollow(doc,id){
    const r=doc.rotated||{}, by=(r.by&&r.by.name)||'another device';
    const sealed=r.handoff&&r.handoff[id];
    let raw=null;
    if(sealed){ try{ const k=await deviceKeys(); if(k.priv)raw=JSON.parse(await devicesOpen(k.priv,sealed)); }catch(e){ raw=null; } }
    clearInterval(syncState.pollTimer); clearTimeout(syncState.pushTimer); liveStop();
    syncState.docs={};
    if(raw&&normalizeSyncCfg(raw)){
      syncState.cfg=normalizeSyncCfg(raw);
      await syncCfgPersist(syncState.cfg);
      if(typeof syncFillForm==='function')syncFillForm();
      setSyncStatus('moved to the new sync key '+by+' made');
      return 'moved';
    }
    syncState.cfg=null; await syncCfgPersist(null);
    devState.doc=null;
    if(typeof syncFillForm==='function')syncFillForm();
    setSyncStatus(sealed?'the sync key changed and this device couldn’t open its copy: pair it again':'this device was taken off sync by '+by+'. Your tasks stay here; pair it again to sync',true);
    if(typeof render==='function')render();
    return 'off';
  }

  /* ── the list in Settings ── */
  function devicesDraw(){
    const box=document.getElementById('devicesBox'); if(!box)return;
    const on=!!devicesProfile();
    box.hidden=!on; if(!on)return;
    const list=document.getElementById('devicesList'), note=document.getElementById('devicesNote');
    list.textContent='';
    if(devState.unsupported){ note.textContent=(devState.notice&&devState.notice.until>Date.now()?devState.notice.text+' ':'')+'Your Supabase project needs one update before devices can show here: paste supabase/migrations/20261106_sync_devices_key.sql into its SQL Editor and press Run.'; return; }
    const items=devicesList(devState.doc,deviceId()), now=Date.now();
    // what the last Remove / Rotate did stays here a while (the sync status line is overwritten by the next sync)
    const said=devState.notice&&devState.notice.until>now?devState.notice.text+' ':'';
    note.textContent=said+(items.length?'Each device shows up once it has synced on this version or newer.':'Looking for devices…');
    items.forEach(function(e){
      const row=document.createElement('div'); row.className='device-row'; row.style.cssText='display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--hairline)';
      const txt=document.createElement('div'); txt.className='device-text'; txt.style.cssText='flex:1;min-width:0';
      const nm=document.createElement('div'); nm.className='device-name'; nm.style.cssText='color:var(--ink)'; nm.textContent=e.name||'Unnamed device';
      if(e.me){ const t=document.createElement('span'); t.className='device-me mono'; t.style.cssText='margin-left:8px;font-size:11px;color:var(--accent)'; t.textContent='this device'; nm.appendChild(t); }
      const sub=document.createElement('div'); sub.className='device-sub mono'; sub.style.cssText='font-size:11px;color:var(--muted);margin-top:2px';
      sub.textContent=[devicesKindLabel(e),e.version?'v'+e.version:null,e.me?null:devicesSeenLabel(e.seen,now),e.pub?null:'pairs again after a key change'].filter(Boolean).join(' · ');
      txt.append(nm,sub); row.appendChild(txt);
      const b=document.createElement('button'); b.className='ghost mono'+(e.me?'':' danger');
      b.textContent=e.me?'Rename':'Remove';
      b.addEventListener('click',function(){ if(e.me)devicesRename(row,e); else devicesRemove(e); });
      row.appendChild(b); list.appendChild(row);
    });
  }
  window.devicesDraw=devicesDraw;
  function devicesRename(row,e){
    row.textContent='';
    const inp=document.createElement('input'); inp.className='settings-inp'; inp.maxLength=60; inp.value=e.name||''; inp.style.flex='1';
    const save=document.createElement('button'); save.className='btn-accent'; save.textContent='Save';
    const done=async function(){
      const v=inp.value.trim();
      try{ if(v&&v!==devState.info.name)localStorage.setItem(DEV_NAME_KEY,v); else localStorage.removeItem(DEV_NAME_KEY); }catch(err){}
      devicesDraw(); syncNow(); // the new name goes up with this device's next heartbeat, which is now
    };
    save.addEventListener('click',done);
    inp.addEventListener('keydown',function(ev){ if(ev.key==='Enter')done(); else if(ev.key==='Escape')devicesDraw(); });
    row.append(inp,save); inp.focus(); inp.select();
  }
  function devicesRemove(e){
    const others=devicesList(devState.doc,deviceId()).filter(function(x){ return !x.me&&x.id!==e.id; });
    const old=others.filter(function(x){ return !x.pub; }).map(function(x){ return x.name; });
    if(!confirm('Remove '+(e.name||'this device')+' from sync?\n\nYour lists move to a new sync key that it never gets, so it stops syncing (what is already on it stays there). '+(others.length?'Your other devices move to the new key by themselves the next time they sync.':'')+(old.length?'\n\nThese need pairing again afterwards (they run an older version): '+old.join(', ')+'.':'')))return;
    syncRotateKey({remove:e.id,confirmed:true});
  }
  document.addEventListener('DOMContentLoaded',devicesDraw);
}
