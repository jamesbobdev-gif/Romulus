/* The Settings page.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── settings panel (all platforms) ── */
function syncFillForm(){
  const c=syncState.cfg||{};
  const p=c.personal||{};
  $('syncUrl').value=p.url||'';
  $('syncAnonKey').value=p.key||'';
  $('syncKey').value=p.syncKey||'';
  // a list's own key shows; one made from the personal key shows as blank ("automatic")
  [['work','syncKeyW'],['agent','syncKeyA'],['school','syncKeyS']].forEach(function(x){ const l=c[x[0]]; $(x[1]).value=l&&!l.derived?l.syncKey||'':''; });
  $('syncOffBtn').hidden=!syncEnabled();
  const rb=$('syncRotateBtn'); if(rb)rb.hidden=!(syncState.cfg&&validProfile(syncState.cfg.personal));
}
// every Settings panel folds shut by its title; the ones he leaves open stay open next time
const SETTINGS_OPEN_KEY='tasks.settingsOpen';
(function(){
  let open={}; try{ open=JSON.parse(localStorage.getItem(SETTINGS_OPEN_KEY)||'{}')||{}; }catch(e){}
  document.querySelectorAll('#settingsPanel details.settings-collapse[id]').forEach(function(d){
    if(open[d.id])d.open=true;
    d.addEventListener('toggle',function(){
      open[d.id]=d.open; if(!d.open)delete open[d.id];
      try{ localStorage.setItem(SETTINGS_OPEN_KEY,JSON.stringify(open)); }catch(e){}
    });
  });
})();
// a group panel shows only while one of its settings does (each script unhides its own as it finds it applies)
(function(){
  const groups=document.querySelectorAll('#settingsPanel details.settings-group');
  const fit=function(){ groups.forEach(function(g){ const h=!g.querySelector('.settings-sub:not([hidden])'); if(g.hidden!==h)g.hidden=h; }); };
  fit();
  new MutationObserver(fit).observe($('settingsPanel'),{subtree:true,attributes:true,attributeFilter:['hidden']});
})();
/* Anything disconnected (each script marks its own with data-disconnected="what's wrong") is listed at the
   top of Settings; clicking one opens its panel, scrolls down to where it is and flashes it */
(function(){
  const box=$('settingsAlerts'); let queued=false;
  const draw=function(){
    queued=false;
    const items=[].slice.call(document.querySelectorAll('#settingsPanel [data-disconnected]')).filter(function(x){
      return !box.contains(x)&&!x.closest('[hidden]:not(details)'); });
    const sig=items.map(function(x){ return x.dataset.disconnected; }).join('|');
    if(box.dataset.sig===sig)return;
    box.dataset.sig=sig; box.innerHTML=''; box.hidden=!items.length;
    items.forEach(function(x){
      const b=document.createElement('button'); b.className='settings-alert';
      b.textContent='⚠ '+x.dataset.disconnected; b.appendChild(document.createElement('span')).textContent='Fix ↓';
      b.addEventListener('click',function(){
        for(let d=x.closest('details');d;d=d.parentElement&&d.parentElement.closest('details'))d.open=true;
        x.scrollIntoView({behavior:'smooth',block:'center'});
        x.classList.remove('settings-flash'); void x.offsetWidth; x.classList.add('settings-flash');
      });
      box.appendChild(b);
    });
  };
  new MutationObserver(function(){ if(!queued){ queued=true; requestAnimationFrame(draw); } })
    .observe($('settingsPanel'),{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','data-disconnected']});
})();
// Settings is its own page: ⚙ opens it in place of the lists; ⚙ again, ← Back or Esc returns
function setSettingsOpen(open){
  const p=$('settingsPanel'); if(p.hidden===!open)return;
  p.hidden=!open;
  if(open)drawHowtos(); // new ones since it was last open
  document.body.classList.toggle('settings-open',open);
  $('settingsBtn').classList.toggle('active',open);
  if(open){
    syncFillForm();
    try{ $('themeCss').value=localStorage.getItem(THEME_KEY)||''; }catch(e){}
    if(gcalRefreshFn)gcalRefreshFn();
    prefsLoad();
  }
  window.scrollTo(0,0);
}
$('settingsBtn').addEventListener('click',function(){ setSettingsOpen($('settingsPanel').hidden); });
$('settingsBack').addEventListener('click',function(){ setSettingsOpen(false); });
// while it's open, the list's shortcuts (/, Ctrl+F, arrows, Space, Delete) stay off the hidden tasks
document.addEventListener('keydown',function(e){
  if($('settingsPanel').hidden)return;
  const a=document.activeElement, inField=a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.tagName==='SELECT');
  if(e.key==='Escape'&&!inField){ e.preventDefault(); e.stopImmediatePropagation(); setSettingsOpen(false); return; }
  if(!inField||((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'))e.stopImmediatePropagation();
},true);
/* Claude's preference notes: their own row next to the agent channel, so task
   sync (which rewrites the agent doc wholesale) can never clobber them */
function prefsProfile(){
  const a=syncState.cfg&&syncState.cfg.agent;
  return validProfile(a)?{url:a.url,key:a.key,syncKey:a.syncKey+':prefs'}:null;
}
// the locked profile: its own row; only the mini PC's local lane reads it (nothing on the Claude side does)
function lockedProfile(){
  const a=syncState.cfg&&syncState.cfg.agent;
  return validProfile(a)?{url:a.url,key:a.key,syncKey:a.syncKey+':locked',baseKey:a.syncKey}:null;
}
/* The Locked profile is encrypted here before it goes to Supabase, so the row is unreadable without the
   agent sync key, even to whoever can see the database: AES-256-GCM, its key made from the agent sync key
   by HKDF-SHA256 with 'romulus-locked-v1' as both salt and info. The row is {v:2, iv, ct} (base64; ct ends
   with the GCM tag, as WebCrypto writes it). agent/supabase.js readText undoes this on the computer that
   fills forms, with Node's hkdfSync and the same strings; test/locked-crypto.test.js holds the two together.
   A v:1 row (plain text, from before) still reads, and is re-saved encrypted the first time it is opened. */
const LOCKED_INFO='romulus-locked-v1';
function lockedCryptoOk(){ return !!(window.crypto&&crypto.subtle&&crypto.subtle.deriveKey); }
async function lockedKey(syncKey,usage){
  const enc=new TextEncoder();
  const raw=await crypto.subtle.importKey('raw',enc.encode(syncKey),'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:enc.encode(LOCKED_INFO),info:enc.encode(LOCKED_INFO)},raw,{name:'AES-GCM',length:256},false,[usage]);
}
function lockedB64(bytes){ let s=''; bytes.forEach(function(b){ s+=String.fromCharCode(b); }); return btoa(s); }
function lockedUnB64(s){ return Uint8Array.from(atob(s),function(c){ return c.charCodeAt(0); }); }
async function lockedEncrypt(syncKey,text){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv:iv},await lockedKey(syncKey,'encrypt'),new TextEncoder().encode(text));
  return {v:2,iv:lockedB64(iv),ct:lockedB64(new Uint8Array(ct))};
}
async function lockedDecrypt(syncKey,doc){
  const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:lockedUnB64(doc.iv)},await lockedKey(syncKey,'decrypt'),lockedUnB64(doc.ct));
  return new TextDecoder().decode(pt);
}
async function lockedRead(syncKey,doc){ // the text of a locked row, whichever version it is
  if(!doc)return '';
  if(doc.v===2&&doc.ct)return lockedDecrypt(syncKey,doc);
  return doc.text||'';
}
async function lockedLoad(){
  const p=lockedProfile(); $('lockedSection').hidden=!p; if(!p)return;
  $('lockedStatus').textContent='loading…';
  try{
    const d=await syncPull(p); const text=await lockedRead(p.baseKey,d);
    $('lockedText').value=text; $('lockedStatus').textContent='';
    if(d&&d.v!==2&&text&&lockedCryptoOk())await syncPushDoc(p,await lockedEncrypt(p.baseKey,text)); // a plain row from an older build: encrypted from now on
  }
  catch(e){ $('lockedStatus').textContent='could not load ('+e.message+')'; }
}
$('lockedSaveBtn').addEventListener('click',async function(){
  const p=lockedProfile(); if(!p)return;
  if(!lockedCryptoOk()){ $('lockedStatus').textContent='this device can’t encrypt; not saved'; return; }
  $('lockedStatus').textContent='saving…';
  try{ await syncPushDoc(p,await lockedEncrypt(p.baseKey,$('lockedText').value)); $('lockedStatus').textContent='saved'; }
  catch(e){ $('lockedStatus').textContent='save failed ('+e.message+')'; }
  setTimeout(function(){ $('lockedStatus').textContent=''; },2500);
});
// Form answers: the questions forms keep asking, answered once; the mini PC's form mode uses them as
// written, and a question left blank stays empty on the form. Added at the end, never over what's there.
const FORM_ANSWERS=`## Form answers
(Answer after each colon. Leave one blank and the local model leaves that question empty on forms.)
- Full legal name:
- Preferred first name:
- Email for applications:
- Phone:
- Mailing address (street, city, state, ZIP):
- Date of birth (only if forms need it):
- Legally authorized to work in the US:
- Will need visa sponsorship now or later:
- Willing to relocate:
- Earliest start date / availability:
- Hours available per week:
- School, major, expected graduation (month year):
- GPA (or "don't share"):
- LinkedIn / portfolio links:
- Emergency contact (name, relationship, phone):
- How did you hear about us (default):
- Gender / race / veteran / disability questions:
- Background check / drug test OK:
- T-shirt size:`;
$('lockedFormBtn').addEventListener('click',function(){
  const box=$('lockedText');
  if(/^## Form answers/m.test(box.value)){ $('lockedStatus').textContent='already there'; setTimeout(function(){ $('lockedStatus').textContent=''; },2500); return; }
  box.value=box.value.replace(/\s+$/,'')+(box.value.trim()?'\n\n':'')+FORM_ANSWERS+'\n';
  box.focus(); box.setSelectionRange(box.value.indexOf('## Form answers'),box.value.indexOf('## Form answers'));
  box.scrollTop=box.scrollHeight;
  $('lockedStatus').textContent='added below: fill it in, then Save';
});
// routing rules: their own row next to the agent list, {v, rules:[{words, lane}], default}; the desktop
// app applies them (main.js routeTask), and the same defaults live there
const ROUTING_START={v:2,default:'auto',rules:[
  {words:'email, send, outlook, gmail',lane:'claude'},{words:'buy, find, look up, search',lane:'claude'},
  {words:'fill, form, apply',lane:'local'},{words:'write, draft, essay',lane:'local'}]};
// same list as PRIVATE_DEFAULT in main.js
const PRIVATE_START='password, passcode, pin number, bank, bank account, credit card, debit card, ssn, social security, '+
  'passport, tax, taxes, salary, payslip, medical, doctor, health, therapy, therapist, prescription, grades, transcript, report card';
function routingProfile(){
  const a=syncState.cfg&&syncState.cfg.agent;
  return validProfile(a)?{url:a.url,key:a.key,syncKey:a.syncKey+':routing'}:null;
}
function routingRow(rule){
  const r=el('div','settings-row routing-rule');
  const w=el('input','settings-inp'); w.value=rule.words||''; w.placeholder='words, like: apply, form'; w.style.flex='1';
  const sel=document.createElement('select'); sel.className='settings-inp'; sel.style.width='auto';
  [['claude','→ Claude'],['local','→ the local model']].forEach(function(o){ const op=document.createElement('option'); op.value=o[0]; op.textContent=o[1]; sel.appendChild(op); });
  sel.value=rule.lane==='local'?'local':'claude';
  const up=el('button','ghost mono','↑'); up.title='Move up (checked earlier)';
  up.addEventListener('click',function(){ const p=r.previousElementSibling; if(p)r.parentNode.insertBefore(r,p); });
  const del=el('button','ghost mono danger','✕'); del.title='Remove this rule';
  del.addEventListener('click',function(){ r.remove(); });
  r.appendChild(w); r.appendChild(sel); r.appendChild(up); r.appendChild(del);
  return r;
}
async function routingLoad(){
  const p=routingProfile(); $('routingSection').hidden=!p; if(!p)return;
  $('routingStatus').textContent='loading…';
  let d=null; try{ d=await syncPull(p); }catch(e){ $('routingStatus').textContent='could not load ('+e.message+')'; return; }
  if(!d||!Array.isArray(d.rules))d=ROUTING_START;
  $('routingRules').innerHTML=''; d.rules.forEach(function(r){ $('routingRules').appendChild(routingRow(r)); });
  // before auto existed (v1) 'ask' was just the starting value: show auto, as the desktop app now uses
  $('routingDefault').value=['claude','local','ask'].indexOf(d.default)!==-1&&(d.v>=2||d.default!=='ask')?d.default:'auto';
  $('routingSites').value=(Array.isArray(d.sites)?d.sites:[]).join('\n');
  $('routingPrivate').value=typeof d.private==='string'?d.private:PRIVATE_START;
  $('routingStatus').textContent='';
}
$('routingAddBtn').addEventListener('click',function(){ const r=routingRow({words:'',lane:'local'}); $('routingRules').appendChild(r); r.querySelector('input').focus(); });
$('routingSaveBtn').addEventListener('click',async function(){
  const p=routingProfile(); if(!p)return;
  const rules=[...$('routingRules').querySelectorAll('.routing-rule')].map(function(r){
    return {words:r.querySelector('input').value.split(',').map(function(x){ return x.trim(); }).filter(Boolean).join(', '),lane:r.querySelector('select').value};
  }).filter(function(r){ return r.words; });
  $('routingStatus').textContent='saving…';
  try{
    const sites=$('routingSites').value.split(/[\n,]+/).map(function(x){ return x.trim().replace(/^https?:\/\//i,'').replace(/\/.*$/,''); }).filter(Boolean);
    const priv=$('routingPrivate').value.split(/[\n,]+/).map(function(x){ return x.trim(); }).filter(Boolean).join(', ');
    await syncPushDoc(p,{v:2,default:$('routingDefault').value,private:priv,rules:rules,sites:sites});
    if(window.desktop&&window.desktop.routingChanged)window.desktop.routingChanged();
    $('routingStatus').textContent='saved';
  }catch(e){ $('routingStatus').textContent='save failed ('+e.message+')'; }
  setTimeout(function(){ $('routingStatus').textContent=''; },2500);
});
// his files for forms (the resume): on this computer, where the agent browser runs (main/downloads.js);
// the phone has no window.desktop, so it never shows them
async function formFilesLoad(){
  const box=$('formFilesSection'); if(!box)return;
  if(!window.desktop||!window.desktop.formFiles){ box.hidden=true; return; }
  box.hidden=false;
  let r=null; try{ r=await window.desktop.formFiles(); }catch(e){}
  const list=$('formFilesList'); list.innerHTML='';
  const files=(r&&r.files)||[];
  if(!files.length){ list.appendChild(el('p','settings-hint','No files yet. Add your resume.')); return; }
  files.forEach(function(f){
    const row=el('div','settings-row');
    row.appendChild(el('span','mono','📄 '+f.name+' · '+(f.size>=1048576?(f.size/1048576).toFixed(1)+' MB':Math.max(1,Math.round(f.size/1024))+' KB')));
    const del=el('button','ghost mono danger','✕'); del.title='Remove this file';
    del.addEventListener('click',async function(){ try{ await window.desktop.formFileRemove(f.name); }catch(e){} formFilesLoad(); });
    row.appendChild(del); list.appendChild(row);
  });
}
$('formFileAddBtn').addEventListener('click',async function(){
  if(!window.desktop||!window.desktop.formFileAdd)return;
  $('formFilesStatus').textContent='';
  let r=null; try{ r=await window.desktop.formFileAdd(); }catch(e){ r={ok:false,error:e.message}; }
  if(r&&r.ok)$('formFilesStatus').textContent='added';
  else if(r&&r.error)$('formFilesStatus').textContent=r.error;
  setTimeout(function(){ $('formFilesStatus').textContent=''; },3000);
  formFilesLoad();
});
let prefsLoadedAt; // updated_at of the version in the box: Save only replaces that version (undefined = never loaded)
async function prefsLoad(){
  lockedLoad();
  routingLoad();
  formFilesLoad();
  if(typeof standingLoad==='function')standingLoad();
  const p=prefsProfile(); $('prefsSection').hidden=!p; if(!p)return;
  $('prefsStatus').textContent='loading…';
  try{ const r=await syncPullRow(p); $('prefsText').value=(r.doc&&r.doc.text)||''; prefsLoadedAt=r.updatedAt; $('prefsStatus').textContent=''; }
  catch(e){ $('prefsStatus').textContent='could not load ('+e.message+')'; }
}
$('prefsSaveBtn').addEventListener('click',async function(){
  const p=prefsProfile(); if(!p)return;
  if(prefsLoadedAt===undefined){ $('prefsStatus').textContent='not loaded yet: reopen ⚙ and try again'; return; }
  $('prefsStatus').textContent='saving…';
  try{
    // Claude (or the weekly tidy) may have added a line since this box was filled: don't erase it
    if(await syncPushCas(p,{v:1,text:$('prefsText').value},prefsLoadedAt)){
      const r=await syncPullRow(p); prefsLoadedAt=r.updatedAt; $('prefsStatus').textContent='saved';
    } else { $('prefsStatus').textContent='changed elsewhere since you opened this: copy your edit, reopen ⚙, and save again'; return; }
  }catch(e){ $('prefsStatus').textContent='save failed ('+e.message+')'; }
  setTimeout(function(){ $('prefsStatus').textContent=''; },2500);
});
$('themeApplyBtn').addEventListener('click',function(){
  const css=$('themeCss').value;
  try{ localStorage.setItem(THEME_KEY,css); }catch(e){}
  applyTheme(css);
  $('themeStatus').textContent=css.trim()?'applied':'cleared';
  setTimeout(function(){ $('themeStatus').textContent=''; },2000);
});
$('themeResetBtn').addEventListener('click',function(){
  $('themeCss').value='';
  try{ localStorage.removeItem(THEME_KEY); }catch(e){}
  applyTheme('');
  $('themeStatus').textContent='reset to default';
  setTimeout(function(){ $('themeStatus').textContent=''; },2000);
});
$('supabaseLink').addEventListener('click',function(e){
  e.preventDefault();
  if(window.desktop&&window.desktop.gcalOpenUrl)window.desktop.gcalOpenUrl('https://supabase.com');
  else window.open('https://supabase.com','_blank');
});
// one code carries the whole form to another device (the anon key box hides its text, so it can't be copied on its own)
const SYNC_CODE_PREFIX='tasks-sync:';
const SYNC_CODE_FIELDS=[['u','syncUrl'],['k','syncAnonKey'],['s','syncKey'],['w','syncKeyW'],['a','syncKeyA'],['c','syncKeyS']];
$('syncCopyBtn').addEventListener('click',function(){
  const o={}; SYNC_CODE_FIELDS.forEach(function(x){ const v=$(x[1]).value.trim(); if(v)o[x[0]]=v; });
  if(!o.u||!o.k||!o.s){ setSyncStatus('fill in the three fields first',true); return; }
  const code=SYNC_CODE_PREFIX+btoa(JSON.stringify(o));
  const done=function(){ setSyncStatus('sync code copied: paste it into the first box on the other device'); };
  const oldCopy=function(){ const ta=document.createElement('textarea'); ta.value=code; ta.style.cssText='position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); let ok=false; try{ ok=document.execCommand('copy'); }catch(e){} ta.remove(); if(ok)done(); else setSyncStatus('couldn’t copy',true); };
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(code).then(done,oldCopy); else oldCopy();
});
SYNC_CODE_FIELDS.slice(0,3).forEach(function(x){
  $(x[1]).addEventListener('paste',function(e){
    const t=((e.clipboardData&&e.clipboardData.getData('text'))||'').trim();
    if(t.indexOf(SYNC_CODE_PREFIX)!==0)return;
    e.preventDefault();
    let o; try{ o=JSON.parse(atob(t.slice(SYNC_CODE_PREFIX.length))); }catch(err){ setSyncStatus('that sync code is cut off: copy it again',true); return; }
    SYNC_CODE_FIELDS.forEach(function(f){ $(f[1]).value=o[f[0]]||''; });
    setSyncStatus('filled in from the sync code: press Save & sync');
  });
});
// what the database accepts as a key (supabase/setup.sql sync_put / sync_set check the same shape)
const SYNC_KEY_SHAPE=/^tk_[A-Za-z0-9_-]{13,}$/;
function newSyncKey(){ return 'tk_'+(window.crypto&&crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2,10)); }
$('syncGenBtn').addEventListener('click',function(){ $('syncKey').value=newSyncKey(); });
$('syncSaveBtn').addEventListener('click',function(){
  const url=$('syncUrl').value.trim(), key=$('syncAnonKey').value.trim(), sk=$('syncKey').value.trim();
  if(!url||!key||!sk){ setSyncStatus('fill in the three fields',true); return; }
  if(sk.length<16){ setSyncStatus('the sync key must be at least 16 characters (press Generate key)',true); return; }
  if(!SYNC_KEY_SHAPE.test(sk)){ setSyncStatus('a sync key starts with tk_ and has only letters, digits, - and _ (press Generate key)',true); return; }
  // the lists share the project; a key typed for one is its own, blank = made from the sync key
  const raw={personal:{url:url,key:key,syncKey:sk}};
  const own=[['work','syncKeyW'],['agent','syncKeyA'],['school','syncKeyS']];
  for(const x of own){ const v=$(x[1]).value.trim(); if(!v)continue; if(v===sk){ setSyncStatus('a list’s own key must differ from the sync key',true); return; } if(!SYNC_KEY_SHAPE.test(v)){ setSyncStatus('a list’s key starts with tk_ and has only letters, digits, - and _',true); return; } raw[x[0]]={url:url,key:key,syncKey:v}; }
  if(raw.agent&&!/^tk_agent_/.test(raw.agent.syncKey)){ setSyncStatus('an Agent key has to start with tk_agent_',true); return; }
  syncState.cfg=normalizeSyncCfg(raw);
  syncCfgPersist(syncState.cfg); // config.json on the desktop, localStorage on the phone (sync.js)
  $('syncOffBtn').hidden=false;
  render(); // workspace chips may appear/disappear
  startSyncLoop();
});
$('syncOffBtn').addEventListener('click',function(){
  syncState.cfg=null; syncCfgPersist(null);
  clearInterval(syncState.pollTimer); clearTimeout(syncState.pushTimer);
  syncFillForm(); setSyncStatus('sync is off'); render();
});
/* Rotate sync key: a new personal key, every list made from it moved under the new keys, the old rows
   blanked. The sync key is the password to the lists, so this is what to do when it may have leaked (a
   sync code sent somewhere it shouldn't have gone, a phone lost). Order: copy every row and read each copy
   back, only then switch this device, only then blank the old rows, so a failure half-way changes nothing.
   Lists with a key of their own (not made from the sync key) are not touched. */
const SYNC_SIDE_ROWS={personal:[':ideas',':hours'],agent:[':prefs',':locked',':routing',':standing'],work:[],school:[]};
const SYNC_TOMBSTONE={v:1,tasks:[],tombstones:[],rotated:true}; // what an old device finds under the old key
function syncRotateMoves(c,newKey){ // every row that follows the personal key: old profile → new profile
  const out=[];
  ['personal','work','agent','school'].forEach(function(ws){
    const prof=c[ws]; if(!validProfile(prof)||(ws!=='personal'&&!prof.derived))return;
    const nk=ws==='personal'?newKey:deriveSyncKey(newKey,ws);
    [''].concat(SYNC_SIDE_ROWS[ws]).forEach(function(sfx){
      out.push({ws:ws,sfx:sfx,oldBase:prof.syncKey,newBase:nk,from:{url:prof.url,key:prof.key,syncKey:prof.syncKey+sfx},to:{url:prof.url,key:prof.key,syncKey:nk+sfx}});
    });
  });
  return out;
}
async function syncRotateKey(){
  const c=syncState.cfg, p=c&&c.personal;
  if(!validProfile(p)){ setSyncStatus('save the sync settings first',true); return; }
  const moving=['Personal (with Ideas and Hours)'].concat(['work','agent','school'].filter(function(ws){ return validProfile(c[ws])&&c[ws].derived; }).map(function(ws){ return ws==='agent'?'Agent (with what Claude knows about you, the Locked profile and the routing rules)':ws[0].toUpperCase()+ws.slice(1); }));
  if(!confirm('Make a new sync key?\n\nThese lists move to keys made from the new one: '+moving.join(', ')+'. The old rows are blanked, so a device still on the old key sees empty lists.\n\nEvery other device (phone, mini PC, widgets) stops syncing until you pair it again: press Copy sync code here afterwards and paste it there. Lists with a key of their own are left alone.'))return;
  const newKey=newSyncKey();
  const rotateBtn=$('syncRotateBtn'); if(rotateBtn)rotateBtn.disabled=true;
  // nothing may upload to the old keys while the rows move
  clearInterval(syncState.pollTimer); clearTimeout(syncState.pushTimer);
  setSyncStatus('rotating the sync key…');
  try{
    for(let i=0;i<40&&syncState.busy;i++)await new Promise(function(r){ setTimeout(r,250); });
    await syncNow(); // this device's latest edits reach the old rows first, so the copies are complete
    clearTimeout(syncState.pushTimer); liveStop();
    const moves=syncRotateMoves(c,newKey);
    // 1. copy each row and read the copy back
    for(const m of moves){
      const rows=await syncRpc(m.from,'sync_get',{p_sync_key:m.from.syncKey});
      let doc=rows[0]?rows[0].doc:null;
      if(doc==null)continue; // no such row: nothing to move
      if(m.sfx===':locked'&&doc.v===2&&doc.ct)doc=await lockedEncrypt(m.newBase,await lockedDecrypt(m.oldBase,doc)); // its cipher key follows the agent key
      await syncPushDoc(m.to,doc);
      const back=await syncRpc(m.to,'sync_get',{p_sync_key:m.to.syncKey});
      if(JSON.stringify((back[0]||{}).doc)!==JSON.stringify(doc))throw new Error('the copy of '+m.ws+m.sfx+' did not read back');
    }
    // 2. this device switches to the new keys
    const raw={personal:{url:p.url,key:p.key,syncKey:newKey}};
    ['work','agent','school'].forEach(function(ws){ if(validProfile(c[ws])&&!c[ws].derived)raw[ws]=c[ws]; });
    syncState.cfg=normalizeSyncCfg(raw);
    await syncCfgPersist(syncState.cfg);
    // 3. the old rows are blanked (an old device then shows an empty list, never live data)
    let left=0;
    for(const m of moves){ try{ await syncPushDoc(m.from,m.sfx?Object.assign({text:''},SYNC_TOMBSTONE):SYNC_TOMBSTONE); }catch(e){ left++; } }
    syncFillForm();
    setSyncStatus('new sync key saved: pair your other devices again with Copy sync code'+(left?' ('+left+' old rows could not be blanked; try again later)':''));
  }catch(e){
    setSyncStatus('rotation stopped before switching keys: '+e.message+' (this device is unchanged)',true);
  }
  if(rotateBtn)rotateBtn.disabled=false;
  startSyncLoop();
}
(function(){ // the button sits with the other sync buttons and shows only while sync is on
  const b=document.createElement('button'); b.id='syncRotateBtn'; b.className='ghost mono'; b.textContent='Rotate sync key';
  b.title='Make a new sync key and move every list over to it; other devices must be paired again';
  $('syncGenBtn').insertAdjacentElement('afterend',b);
  b.addEventListener('click',syncRotateKey);
})();
