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
  $('syncKeyF').value=c.family&&c.family.syncKey||''; // the family list's key rides along with the sync code to this person's other devices
  $('syncOffBtn').hidden=!syncEnabled();
  const rb=$('syncRotateBtn'); if(rb)rb.hidden=!(syncState.cfg&&validProfile(syncState.cfg.personal));
  const ob=$('syncOneKeyBtn'); if(ob)ob.hidden=!(validProfile(p)&&syncOwnKeyLists(c).length);
  const eb=$('syncV2Btn'); if(eb)eb.hidden=!(validProfile(p)&&!p.v2); // gone once the lists are encrypted
  if(typeof devicesDraw==='function')devicesDraw();
  syncShowFirstSteps();
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
      b.textContent=x.dataset.disconnected; b.appendChild(document.createElement('span')).textContent='Fix ↓';
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
// Settings is its own page: the gear opens it in place of the lists; the gear again, ← Back or Esc returns
function setSettingsOpen(open){
  const p=$('settingsPanel'); if(p.hidden===!open)return;
  p.hidden=!open;
  if(open)drawHowtos(); // new ones since it was last open
  document.body.classList.toggle('settings-open',open);
  $('settingsBtn').classList.toggle('active',open);
  if(open){
    syncFillForm();
    try{ $('themeCss').value=localStorage.getItem(THEME_KEY)||''; }catch(e){}
    $('themeName').value=themeSavedNameOf($('themeCss').value);
    drawThemeColors(); drawThemeSaved();
    if(gcalRefreshFn)gcalRefreshFn();
    if(typeof drawSetupList==='function')drawSetupList();
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
    row.appendChild(el('span','mono',f.name+' · '+(f.size>=1048576?(f.size/1048576).toFixed(1)+' MB':Math.max(1,Math.round(f.size/1024))+' KB')));
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
/* His Link wallet (Stripe's Link, desktop only: agent/link-wallet.js): connect by a device code he approves in the
   Link app, watch that sign-in finish, disconnect, and test mode */
if(window.desktop&&window.desktop.linkStatus){
  $('linkSection').hidden=false;
  let linkPoll=null, linkPolls=0;
  const money=function(c){ return '$'+(Number(c)/100).toFixed(Number(c)%100?2:0); };
  const stopPoll=function(){ if(linkPoll){ clearInterval(linkPoll); linkPoll=null; } };
  const showCode=function(p){ // where he signs in, and the phrase the Link app asks for
    const box=$('linkCode'); box.hidden=false; box.innerHTML='';
    box.appendChild(document.createTextNode('Open '));
    const a=el('a','',p.url.replace(/^https?:\/\//,'').split('?')[0]); a.href='#';
    a.addEventListener('click',function(ev){ ev.preventDefault(); window.desktop.linkOpen(p.url); });
    box.appendChild(a);
    box.appendChild(document.createTextNode(', sign in to Link and, when it asks, enter the phrase '));
    box.appendChild(el('b','mono',p.phrase||''));
    box.appendChild(document.createTextNode('. This updates by itself once it goes through.'));
  };
  const linkDraw=function(s){
    $('linkConnectBtn').hidden=!!s.connected; $('linkDisconnectBtn').hidden=!s.connected;
    $('linkConnectBtn').textContent=s.installed?'Connect Link':'Install and connect Link';
    $('linkTest').checked=!!s.test;
    const lim=s.limits&&s.limits.per_transaction&&s.limits.per_transaction.limit!=null?' · up to '+money(s.limits.per_transaction.limit)+' a purchase':'';
    $('linkStatus').textContent=!s.node?'needs Node.js (see Setup)':s.connected?'connected'+(s.email?' as '+s.email:'')+lim+(s.test?' · test mode':''):s.pending?'waiting for your approval in Link…':'not connected';
    if(s.connected){ $('linkCode').hidden=true; stopPoll(); }
    else if(s.pending&&s.pending.url){ showCode(s.pending); startPoll(); }
    else $('linkCode').hidden=true;
  };
  const startPoll=function(){ // a sign-in waits: ask every few seconds whether he has approved it
    if(linkPoll)return; linkPolls=0;
    linkPoll=setInterval(async function(){
      if(++linkPolls>75){ stopPoll(); $('linkStatus').textContent='the sign-in timed out: press Connect again'; $('linkCode').hidden=true; return; }
      try{ linkDraw(await window.desktop.linkStatus({poll:true})); }catch(e){}
    },4000);
  };
  window.linkLoad=async function(){ try{ linkDraw(await window.desktop.linkStatus()); }catch(e){} };
  $('linkConnectBtn').addEventListener('click',async function(){
    $('linkStatus').textContent='getting Link ready…'; $('linkConnectBtn').disabled=true;
    let r=null; try{ r=await window.desktop.linkConnect(); }catch(e){ r={ok:false,error:e.message}; }
    $('linkConnectBtn').disabled=false;
    if(!r||!r.ok){ $('linkStatus').textContent=(r&&r.error)||'could not start the sign-in'; return; }
    $('linkStatus').textContent='waiting for your approval in Link…';
    showCode(r); window.desktop.linkOpen(r.url); startPoll();
  });
  $('linkDisconnectBtn').addEventListener('click',async function(){
    $('linkStatus').textContent='disconnecting…'; stopPoll();
    try{ linkDraw(await window.desktop.linkDisconnect()); }catch(e){ $('linkStatus').textContent='could not disconnect'; }
  });
  $('linkTest').addEventListener('change',async function(){ try{ linkDraw(await window.desktop.linkSave({test:this.checked})); }catch(e){} });
}
let prefsLoadedAt; // updated_at of the version in the box: Save only replaces that version (undefined = never loaded)
async function prefsLoad(){
  lockedLoad();
  routingLoad();
  formFilesLoad();
  if(typeof linkLoad==='function')linkLoad();
  if(typeof standingLoad==='function')standingLoad();
  const p=prefsProfile(); $('prefsSection').hidden=!p; if(!p)return;
  $('prefsStatus').textContent='loading…';
  try{ const r=await syncPullRow(p); $('prefsText').value=(r.doc&&r.doc.text)||''; prefsLoadedAt=r.updatedAt; $('prefsStatus').textContent=''; }
  catch(e){ $('prefsStatus').textContent='could not load ('+e.message+')'; }
}
$('prefsSaveBtn').addEventListener('click',async function(){
  const p=prefsProfile(); if(!p)return;
  if(prefsLoadedAt===undefined){ $('prefsStatus').textContent='not loaded yet: reopen Settings and try again'; return; }
  $('prefsStatus').textContent='saving…';
  try{
    // Claude (or the weekly tidy) may have added a line since this box was filled: don't erase it
    if(await syncPushCas(p,{v:1,text:$('prefsText').value},prefsLoadedAt)){
      const r=await syncPullRow(p); prefsLoadedAt=r.updatedAt; $('prefsStatus').textContent='saved';
    } else { $('prefsStatus').textContent='changed elsewhere since you opened this: copy your edit, reopen Settings, and save again'; return; }
  }catch(e){ $('prefsStatus').textContent='save failed ('+e.message+')'; }
  setTimeout(function(){ $('prefsStatus').textContent=''; },2500);
});
/* Basic / Advanced: .adv panels show only with the switch on (remembered here) */
const ADV_KEY='tasks.settingsAdvanced.v1';
function setAdvanced(on){
  document.body.classList.toggle('show-adv',!!on); $('advOn').checked=!!on;
  try{ if(on)localStorage.setItem(ADV_KEY,'1'); else localStorage.removeItem(ADV_KEY); }catch(e){}
}
try{ setAdvanced(!!localStorage.getItem(ADV_KEY)); }catch(e){}
$('advOn').addEventListener('change',function(){ setAdvanced(this.checked); });
function setThemeMode(mode){
  try{ localStorage.setItem(THEME_MODE_KEY,mode); }catch(e){}
  applyThemeMode(mode); drawThemeModes();
}
// the saved theme in use lights up instead of Custom
function drawThemeModes(){
  let mode='system', css=''; try{ mode=themeModeSaved(); css=localStorage.getItem(THEME_KEY)||''; }catch(e){}
  const named=mode==='custom'?themeSavedNameOf(css):'';
  document.querySelectorAll('.theme-modes [data-mode]').forEach(function(b){ const on=b.dataset.mode===mode&&!named; b.classList.toggle('on',on); b.setAttribute('aria-checked',String(on)); });
  document.querySelectorAll('.theme-modes [data-saved]').forEach(function(b){ const on=!!named&&b.dataset.saved===named; b.classList.toggle('on',on); b.setAttribute('aria-checked',String(on)); });
}
document.querySelectorAll('.theme-modes [data-mode]').forEach(function(b){
  b.addEventListener('click',function(){ setThemeMode(b.dataset.mode); });
});
drawThemeModes();
// every unique colour in the box, named (theme-colors.js); redrawn as you type
function drawThemeColors(){
  const box=$('themeColors'); box.textContent='';
  const colors=themeCssColors($('themeCss').value);
  box.hidden=!colors.length;
  colors.forEach(function(c){
    const row=el('span','tc'); row.title=c.used.join(', ');
    const sw=el('span','theme-swatch'); sw.style.background=c.hex;
    row.append(sw,el('b',null,c.name),el('span',null,c.hex));
    box.appendChild(row);
  });
}
// each distinct CSS you've applied, under the name you gave it (else its main colour), in the row beside Light and Dark; click one to switch to it
function themeSavedNameOf(css){
  const key=String(css||'').replace(/\s+/g,''); if(!key)return '';
  const t=themeSavedLoad().find(function(t){ return String(t.css).replace(/\s+/g,'')===key; });
  return t?t.name:'';
}
function themeSavedLoad(){ try{ const l=JSON.parse(localStorage.getItem(THEME_SAVED_KEY)||'[]'); return Array.isArray(l)?l:[]; }catch(e){ return []; } }
function themeSavedStore(list){ try{ localStorage.setItem(THEME_SAVED_KEY,JSON.stringify(list)); }catch(e){} }
function drawThemeSaved(){
  const box=$('themeSaved'); box.textContent='';
  const list=themeSavedLoad();
  list.forEach(function(t,i){
    const b=el('button','chip st tap'); b.dataset.saved=t.name; b.setAttribute('role','radio'); b.title=t.colors.length+' colours: '+t.colors.map(function(c){ return c.name; }).join(', ');
    const sw=el('span','theme-swatch'); if(t.hex)sw.style.background=t.hex;
    const x=el('span','x','x'); x.setAttribute('role','button'); x.setAttribute('aria-label','Remove '+t.name);
    b.append(sw,el('span',null,t.name),x);
    b.addEventListener('click',function(e){
      if(e.target===x){ const l=themeSavedLoad(); l.splice(i,1); themeSavedStore(l); drawThemeSaved(); return; }
      $('themeCss').value=t.css; $('themeName').value=t.name; $('themeApplyBtn').click();
    });
    box.appendChild(b);
  });
  drawThemeModes();
}
$('themeCss').addEventListener('input',drawThemeColors);
drawThemeSaved();
$('themeApplyBtn').addEventListener('click',function(){
  const css=$('themeCss').value;
  try{ if(css.trim())localStorage.setItem(THEME_KEY,css); else localStorage.removeItem(THEME_KEY); }catch(e){}
  let name='';
  if(css.trim()){ const l=themeSaveCss(themeSavedLoad(),css,Date.now(),$('themeName').value); themeSavedStore(l); name=l[0].name; $('themeName').value=name; }
  setThemeMode(css.trim()?'custom':'system');
  drawThemeColors(); drawThemeSaved();
  $('themeStatus').textContent=css.trim()?'saved as '+name:'cleared';
  setTimeout(function(){ $('themeStatus').textContent=''; },2000);
});
$('themeResetBtn').addEventListener('click',function(){
  $('themeCss').value=''; $('themeName').value=''; drawThemeColors();
  try{ localStorage.removeItem(THEME_KEY); }catch(e){}
  setThemeMode('system');
  $('themeStatus').textContent='reset to default';
  setTimeout(function(){ $('themeStatus').textContent=''; },2000);
});
function openOutside(url){
  if(window.desktop&&window.desktop.gcalOpenUrl)window.desktop.gcalOpenUrl(url);
  else window.open(url,'_blank');
}
$('supabaseLink').addEventListener('click',function(e){ e.preventDefault(); openOutside('https://supabase.com'); });
// the first device: nothing to pair with, so Device sync opens on the steps for making the project
const SETUP_SQL_URL='https://github.com/jamesbobdev-gif/Romulus/blob/main/supabase/setup.sql';
const SETUP_SQL_RAW='https://raw.githubusercontent.com/jamesbobdev-gif/Romulus/main/supabase/setup.sql';
// once a Project URL is in the box, this opens that project's SQL Editor; before that, a new project
function supabaseRef(u){ const m=/^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/i.exec(String(u||'').trim()); return m?m[1].toLowerCase():''; }
$('syncOpenSupabase').addEventListener('click',function(){
  const ref=supabaseRef($('syncUrl').value);
  openOutside(ref?'https://supabase.com/dashboard/project/'+ref+'/sql/new':'https://supabase.com/dashboard/new');
});
$('syncOpenSql').addEventListener('click',function(){ openOutside(SETUP_SQL_URL); });
// the whole setup.sql on the clipboard, so nobody has to find the copy button on GitHub
$('syncCopySql').addEventListener('click',async function(){
  const b=this; b.disabled=true;
  try{
    const r=await fetch(SETUP_SQL_RAW,{cache:'no-store'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    await navigator.clipboard.writeText(await r.text());
    setSyncStatus('setup.sql copied: paste it in the project’s SQL Editor and press Run');
  }catch(e){
    setSyncStatus('couldn’t copy it here, so it opens instead: use the copy button at the top right of the file',true);
    openOutside(SETUP_SQL_URL);
  }finally{ b.disabled=false; }
});
/* Device sync with nothing set up yet shows only what can be used then. Without a pairing server (a build of
   your own: ROMULUS_PAIR null) and no project, Pair and Add a device have nowhere to meet, so that row goes.
   The sync key is made by Save & sync, so its box, Generate key, Copy sync code and the per-list keys wait
   until there is one. A sync code pasted into any box still fills them all in (the paste handler below). */
function syncShowFirstSteps(){
  const first=!(syncState.cfg&&validProfile(syncState.cfg.personal));
  const rp=typeof window!=='undefined'&&window.ROMULUS_PAIR, noServer=first&&!(rp&&rp.url&&rp.key);
  $('syncFirstSteps').hidden=!first;
  if(first)$('syncManual').open=true;
  const pairRow=$('pairCodeIn').closest('.settings-row');
  pairRow.hidden=noServer;
  if(pairRow.previousElementSibling)pairRow.previousElementSibling.hidden=noServer; // "Adding a device? …"
  ['syncKey','syncGenBtn','syncCopyBtn'].forEach(function(id){ $(id).hidden=first; });
  $('syncKeyW').closest('details').hidden=first;
  if(window.desktop&&window.desktop.syncQr)$('syncQrBtn').hidden=first;
  let note=$('syncNoServerNote');
  if(!note){
    note=el('p','settings-hint','This build has no Romulus server, so your first device needs a Supabase project of its own. Already syncing on another device? Press Copy sync code there and paste it into the first box below.');
    note.id='syncNoServerNote'; note.style.margin='0 0 8px';
    $('syncFirstSteps').prepend(note);
  }
  note.hidden=!noServer;
  return first;
}
$('syncSection').addEventListener('toggle',function(){ if(this.open)syncShowFirstSteps(); });
// one code carries the whole form to another device (the anon key box hides its text, so it can't be copied on its own)
const SYNC_CODE_PREFIX='tasks-sync:';
const SYNC_CODE_FIELDS=[['u','syncUrl'],['k','syncAnonKey'],['s','syncKey'],['w','syncKeyW'],['a','syncKeyA'],['c','syncKeyS'],['f','syncKeyF']];
$('syncCopyBtn').addEventListener('click',function(){
  const o={}; SYNC_CODE_FIELDS.forEach(function(x){ const v=$(x[1]).value.trim(); if(v)o[x[0]]=v; });
  if(!o.u||!o.k||!o.s){ setSyncStatus('fill in the three fields first',true); return; }
  const code=SYNC_CODE_PREFIX+btoa(JSON.stringify(o));
  const done=function(){ setSyncStatus('sync code copied: paste it into the first box on the other device'); };
  const oldCopy=function(){ const ta=document.createElement('textarea'); ta.value=code; ta.style.cssText='position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); let ok=false; try{ ok=document.execCommand('copy'); }catch(e){} ta.remove(); if(ok)done(); else setSyncStatus('couldn’t copy',true); };
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(code).then(done,oldCopy); else oldCopy();
});
function syncCodeNow(){
  const o={}; SYNC_CODE_FIELDS.forEach(function(x){ const v=$(x[1]).value.trim(); if(v)o[x[0]]=v; });
  return o.u&&o.k&&o.s?SYNC_CODE_PREFIX+btoa(JSON.stringify(o)):null;
}
function fillFromSyncCode(t){
  let o; try{ o=JSON.parse(atob(t.slice(SYNC_CODE_PREFIX.length))); }catch(err){ setSyncStatus('that sync code is cut off: try again',true); return false; }
  SYNC_CODE_FIELDS.forEach(function(f){ $(f[1]).value=o[f[0]]||''; });
  return true;
}
/* phone pairing by QR: the computer draws the sync code (main/device-sync.js sync:qr), the phone scans it
   with the scanner Finance pairing uses (FinanceVault.scan) and saves at once. It hides after 2 minutes. */
if(window.desktop&&window.desktop.syncQr){
  const qb=$('syncQrBtn'), box=$('syncQrBox'); let qrTimer=null;
  const hideQr=function(){ clearTimeout(qrTimer); box.innerHTML=''; box.hidden=true; qb.textContent='Show code for phone'; };
  qb.hidden=false;
  qb.addEventListener('click',async function(){
    if(!box.hidden){ hideQr(); return; }
    const code=syncCodeNow(); if(!code){ setSyncStatus('fill in the three fields first',true); return; }
    const r=await window.desktop.syncQr(code).catch(function(e){ return {ok:false,error:e.message}; });
    if(!r.ok){ setSyncStatus('couldn’t draw the code: '+r.error,true); return; }
    box.innerHTML=r.svg; box.hidden=false; qb.textContent='Hide the code';
    setSyncStatus('scan it from Settings → Device sync on your phone. Anyone who scans it can open your lists');
    qrTimer=setTimeout(hideQr,120000);
  });
  $('syncSection').addEventListener('toggle',function(){ if(!this.open)hideQr(); });
}
(function(){
  const cap=window.Capacitor;
  if(!cap||typeof cap.nativePromise!=='function'||!cap.isPluginAvailable||!cap.isPluginAvailable('FinanceVault'))return;
  const sb=$('syncScanBtn'); sb.hidden=false;
  sb.addEventListener('click',async function(){
    let text='';
    try{ text=String((await cap.nativePromise('FinanceVault','scan',{})).text||'').trim(); }
    catch(e){ if(!/cancel/i.test(String(e&&(e.code||e.message))))setSyncStatus('the scanner didn’t start',true); return; }
    if(text.indexOf(SYNC_CODE_PREFIX)!==0){ setSyncStatus('that isn’t a sync code: use Show code for phone on the computer',true); return; }
    if(fillFromSyncCode(text)){ setSyncStatus('paired: saving…'); $('syncSaveBtn').click(); }
  });
})();
SYNC_CODE_FIELDS.slice(0,3).forEach(function(x){
  $(x[1]).addEventListener('paste',function(e){
    const t=((e.clipboardData&&e.clipboardData.getData('text'))||'').trim();
    if(t.indexOf(SYNC_CODE_PREFIX)!==0)return;
    e.preventDefault();
    if(!fillFromSyncCode(t))return;
    setSyncStatus('filled in from the sync code: press Save & sync');
  });
});
// what the database accepts as a key (supabase/setup.sql sync_put / sync_set check the same shape)
const SYNC_KEY_SHAPE=/^tk_[A-Za-z0-9_-]{13,}$/;
// the key is the password to the lists on a project others share, so it's always 122+ random bits: never the
// clock or Math.random (the database won't start a new account on a key id under 32 characters)
function newSyncKey(){ return 'tk_'+(crypto.randomUUID?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint8Array(16)),function(b){ return b.toString(16).padStart(2,'0'); }).join('')); }
$('syncGenBtn').addEventListener('click',function(){ $('syncKey').value=newSyncKey(); });
$('syncSaveBtn').addEventListener('click',function(){
  const url=$('syncUrl').value.trim(), key=$('syncAnonKey').value.trim();
  if(!url||!key){ setSyncStatus('paste the Project URL and the publishable key first',true); return; }
  // the first device makes the sync key; a second one gets it by pairing
  if(!$('syncKey').value.trim())$('syncKey').value=newSyncKey();
  const sk=$('syncKey').value.trim();
  if(sk.length<16){ setSyncStatus('the sync key must be at least 16 characters (press Generate key)',true); return; }
  if(!SYNC_KEY_SHAPE.test(sk)){ setSyncStatus('a sync key starts with tk_ and has only letters, digits, - and _ (press Generate key)',true); return; }
  // the lists share the project; a key typed for one is its own, blank = made from the sync key
  const raw={personal:{url:url,key:key,syncKey:sk}};
  const cur=syncState.cfg&&syncState.cfg.personal; if(cur&&cur.v2&&cur.syncKey===sk)raw.personal.v2=true; // the same key stays end-to-end encrypted
  const own=[['work','syncKeyW'],['agent','syncKeyA'],['school','syncKeyS']];
  for(const x of own){ const v=$(x[1]).value.trim(); if(!v)continue; if(v===sk){ setSyncStatus('a list’s own key must differ from the sync key',true); return; } if(!SYNC_KEY_SHAPE.test(v)){ setSyncStatus('a list’s key starts with tk_ and has only letters, digits, - and _',true); return; } raw[x[0]]={url:url,key:key,syncKey:v}; }
  if(raw.agent&&!/^tk_agent_/.test(raw.agent.syncKey)){ setSyncStatus('an Agent key has to start with tk_agent_',true); return; }
  // the family list (family-list.js) is always on the Romulus server, whichever project the other lists use
  const fk=$('syncKeyF').value.trim(), fh=typeof hostedServer==='function'&&hostedServer();
  if(fk){
    if(!SYNC_KEY_SHAPE.test(fk)||fk===sk){ setSyncStatus('the family list key starts with tk_ and differs from the sync key',true); return; }
    if(fh){ const old=syncState.cfg&&syncState.cfg.family; raw.family=old&&old.syncKey===fk?old:{url:fh.url,key:fh.key,syncKey:fk,v2:true}; }
  }
  const hosted=typeof hostedIs==='function';
  const prev=syncState.cfg&&syncState.cfg.personal;
  // leaving the Romulus server for a project of one's own, same sync key: the other devices are told to follow
  const leaving=hosted&&validProfile(prev)&&hostedIs(prev.url)&&!hostedIs(url)&&prev.syncKey===sk?Object.assign({},prev):null;
  const btn=$('syncSaveBtn'); btn.disabled=true;
  (async function(){
    if(!(hosted&&hostedIs(url))){
      setSyncStatus('checking the project…');
      const bad=await syncCheckProject({url:url,key:key,syncKey:sk});
      if(bad){ setSyncStatus(bad,true); return; }
    }
    // leaving the Romulus server, where the lists are end-to-end encrypted: they stay encrypted in the new project
    // too. The markers go first, so a device paired there later finds the encrypted lists, never plain ones.
    if(leaving&&leaving.v2&&typeof hostedSealMarkers==='function'&&syncCryptoOk()){
      try{ await hostedSealMarkers({url:url,key:key},sk); }
      catch(e){ setSyncStatus('couldn’t set up encryption in that project: '+e.message,true); return; }
      raw.personal.v2=true;
    }
    clearInterval(syncState.pollTimer); clearTimeout(syncState.pushTimer);
    for(let i=0;i<40&&syncState.busy;i++)await new Promise(function(r){ setTimeout(r,250); }); // let a sync already running finish
    syncState.cfg=normalizeSyncCfg(raw);
    syncState.docs={};
    syncCfgPersist(syncState.cfg); // config.json on the desktop, localStorage on the phone (sync.js)
    if(hosted&&!hostedIs(url))hostedSetOptOut(true); // a project of one's own: never start on the Romulus server by itself again
    if(typeof hostedDraw==='function')setTimeout(hostedDraw,0);
    $('syncOffBtn').hidden=false;
    syncShowFirstSteps(); // the key box and its buttons come back now there is a key
    render(); // workspace chips may appear/disappear
    let said=null;
    if(leaving){
      // this device's lists go up to the new project first; only once that worked are the others sent after them
      const t0=Date.now();
      await syncNow();
      if(syncState.errStreak===0&&(syncState.lastAt||0)>=t0){
        try{ await syncLeaveMovedNote(leaving,syncState.cfg.personal); said=['moved: your other devices follow on their next sync (one on an older version of the app needs pairing again)',false]; }
        catch(e){ said=['moved this device, but couldn’t tell the others: pair them again with Add a device',true]; }
      }
    }
    startSyncLoop();
    if(said){ // after the sync the loop just started, so "synced" doesn't cover it up
      await new Promise(function(r){ setTimeout(r,50); });
      for(let i=0;i<120&&syncState.busy;i++)await new Promise(function(r){ setTimeout(r,250); });
      setSyncStatus(said[0],said[1]);
    }
  })().finally(function(){ btn.disabled=false; });
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
const SYNC_SIDE_ROWS={personal:[':ideas',':hours',':updates',':finance'],agent:[':prefs',':locked',':routing',':standing',':worker',':files',':files-gone',':macros'],work:[],school:[]};
const SYNC_TOMBSTONE={v:1,tasks:[],tombstones:[],rotated:true}; // what an old device finds under the old key
function syncRotateMoves(c,newKey){ // every row that follows the personal key: old profile → new profile
  const out=[];
  ['personal','work','agent','school'].forEach(function(ws){
    const prof=c[ws]; if(!validProfile(prof)||(ws!=='personal'&&!prof.derived))return;
    const nk=ws==='personal'?newKey:deriveSyncKey(newKey,ws);
    [''].concat(SYNC_SIDE_ROWS[ws]).forEach(function(sfx){
      const v2=!!prof.v2; // an encrypted list stays encrypted, under the new key's lookup id and content key
      out.push({ws:ws,sfx:sfx,oldBase:prof.syncKey,newBase:nk,from:{url:prof.url,key:prof.key,syncKey:prof.syncKey+sfx,v2:v2},to:{url:prof.url,key:prof.key,syncKey:nk+sfx,v2:v2}});
    });
  });
  return out;
}
async function syncCopyRows(moves){ // each row copied to its new key and read back; throws before anything switches
  for(const m of moves){
    // syncPull / syncPushDoc open and seal end-to-end encrypted rows (m.from / m.to say whether they are)
    let doc=await syncPull(m.from);
    if(doc==null)continue; // no such row: nothing to move
    if(m.sfx===':locked'&&doc.v===2&&doc.ct)doc=await lockedEncrypt(m.newBase,await lockedDecrypt(m.oldBase,doc)); // its cipher key follows the agent key
    await syncPushDoc(m.to,doc);
    const back=await syncPull(m.to);
    if(stableJson(back)!==stableJson(doc))throw new Error('the copy of '+m.ws+m.sfx+' did not read back');
  }
}
// opts.remove: a device id from Settings → Devices (devices.js) that doesn't get the new key; opts.confirmed: asked already
async function syncRotateKey(opts){
  opts=opts&&opts.confirmed?opts:{}; // the button's click hands in an event
  const c=syncState.cfg, p=c&&c.personal;
  if(!validProfile(p)){ setSyncStatus('save the sync settings first',true); return; }
  const moving=['Personal (with Notes and Hours)'].concat(['work','agent','school'].filter(function(ws){ return validProfile(c[ws])&&c[ws].derived; }).map(function(ws){ return ws==='agent'?'Agent (with what Claude knows about you, the Locked profile and the routing rules)':ws[0].toUpperCase()+ws.slice(1); }));
  if(!opts.confirmed&&!confirm('Make a new sync key?\n\nThese lists move to keys made from the new one: '+moving.join(', ')+'. The old rows are blanked.\n\nThe devices listed under Devices move to the new key by themselves the next time they sync. A device not listed there (an older version) stops syncing until you pair it again. Lists with a key of their own are left alone.'))return;
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
    await syncCopyRows(moves);
    // 2. this device switches to the new keys
    const raw={personal:{url:p.url,key:p.key,syncKey:newKey}};
    if(p.v2)raw.personal.v2=true;
    ['work','agent','school','family'].forEach(function(ws){ if(validProfile(c[ws])&&!c[ws].derived)raw[ws]=c[ws]; });
    // the device list, read before switching: the kept devices get the new settings sealed to their own keys (devices.js)
    const oldDevices=devicesProfileOf(p), newDevices=devicesProfileOf(raw.personal);
    let devDoc=null; try{ devDoc=await syncPull(oldDevices); }catch(e){}
    syncState.cfg=normalizeSyncCfg(raw);
    await syncCfgPersist(syncState.cfg);
    // 2b. the hand-off under the old key, and the device list without the removed one under the new key
    // no device list (a database without the ':devices' row yet): nobody can be handed the new key
    let pairAgain=devDoc&&devDoc.devices?[]:['your other devices'], removedName=null;
    if(devDoc&&devDoc.devices&&!devDoc.rotated){
      const me=deviceId(), meNow=await deviceMe();
      const keep=Object.keys(devDoc.devices).filter(function(id){ return id!==me&&id!==opts.remove; });
      try{
        const h=await devicesHandoff(devDoc,keep,JSON.stringify(raw));
        pairAgain=h.left;
        await syncPushDoc(oldDevices,{v:1,devices:devDoc.devices,rotated:{at:Date.now(),by:{id:me,name:meNow.name},removed:opts.remove||null,handoff:h.handoff}});
        const kept={}; Object.keys(devDoc.devices).forEach(function(id){ if(id!==opts.remove)kept[id]=devDoc.devices[id]; });
        const next=devicesWithMe({v:1,devices:kept},me,meNow,Date.now());
        await syncPushDoc(newDevices,next);
        devState.doc=next;
        if(opts.remove&&devDoc.devices[opts.remove])removedName=devDoc.devices[opts.remove].name||'That device';
      }catch(e){ pairAgain=['every other device (the hand-off wasn’t saved: '+e.message+')']; }
    }
    // 3. the old rows are blanked (an old device then shows an empty list, never live data)
    let left=0;
    for(const m of moves){ try{ await syncPushDoc(m.from,m.sfx?Object.assign({text:''},SYNC_TOMBSTONE):SYNC_TOMBSTONE); }catch(e){ left++; } }
    const said=(removedName?removedName+' is off sync. ':'')+'New sync key saved'+(pairAgain.length?'; pair these again with Add a device: '+pairAgain.join(', '):': your other devices follow by themselves')+(left?' ('+left+' old rows could not be blanked; try again later)':'')+'.';
    devState.notice={text:said,until:Date.now()+3*60000};
    syncFillForm();
    setSyncStatus(said);
  }catch(e){
    setSyncStatus('rotation stopped before switching keys: '+e.message+' (this device is unchanged)',true);
  }
  if(rotateBtn)rotateBtn.disabled=false;
  startSyncLoop();
}
/* One key for every list: a setup from before the Work, Agent and School keys were made from the sync key
   has a key of its own per list, so a new device paired with the sync key alone finds those lists empty.
   This moves each such list (with its side rows) under the key made from the sync key, the same way a
   rotation does: copy and read back, then switch this device, then blank the old rows. The sync key itself
   stays, so other devices keep syncing and a phone needs only that one key from then on. */
function syncOwnKeyLists(c){ return ['work','agent','school'].filter(function(ws){ return c&&validProfile(c[ws])&&!c[ws].derived; }); }
function syncOneKeyMoves(c){
  const out=[], pk=c.personal.syncKey;
  syncOwnKeyLists(c).forEach(function(ws){
    const prof=c[ws], nk=deriveSyncKey(pk,ws);
    if(prof.syncKey===nk)return;
    [''].concat(SYNC_SIDE_ROWS[ws]).forEach(function(sfx){
      out.push({ws:ws,sfx:sfx,oldBase:prof.syncKey,newBase:nk,from:{url:prof.url,key:prof.key,syncKey:prof.syncKey+sfx,v2:!!prof.v2},to:{url:c.personal.url,key:c.personal.key,syncKey:nk+sfx,v2:!!c.personal.v2}});
    });
  });
  return out;
}
async function syncUseOneKey(){
  const c=syncState.cfg, p=c&&c.personal;
  if(!validProfile(p)){ setSyncStatus('save the sync settings first',true); return; }
  const lists=syncOwnKeyLists(c);
  if(!lists.length){ syncFillForm(); return; }
  const names=lists.map(function(ws){ return ws[0].toUpperCase()+ws.slice(1); }).join(', ');
  if(!confirm('Use one key for every list?\n\n'+names+' move under keys made from your sync key. After this, a new device needs only the sync key (or the sync code) and gets every list.\n\nDevices already set up with the sync code keep the old '+names+' keys and see those lists empty until you paste the new sync code there once.'))return;
  const btn=$('syncOneKeyBtn'); if(btn)btn.disabled=true;
  clearInterval(syncState.pollTimer); clearTimeout(syncState.pushTimer);
  setSyncStatus('moving '+names+' to your sync key…');
  try{
    for(let i=0;i<40&&syncState.busy;i++)await new Promise(function(r){ setTimeout(r,250); });
    await syncNow(); // this device's latest edits reach the old rows first
    clearTimeout(syncState.pushTimer); liveStop();
    const moves=syncOneKeyMoves(c);
    await syncCopyRows(moves);
    syncState.cfg=normalizeSyncCfg({personal:p}); // every list now follows the sync key
    await syncCfgPersist(syncState.cfg);
    let left=0;
    for(const m of moves){ try{ await syncPushDoc(m.from,m.sfx?Object.assign({text:''},SYNC_TOMBSTONE):SYNC_TOMBSTONE); }catch(e){ left++; } }
    syncFillForm();
    setSyncStatus('every list now uses your sync key'+(left?' ('+left+' old rows could not be blanked; try again later)':''));
  }catch(e){
    setSyncStatus('stopped before switching: '+e.message+' (this device is unchanged)',true);
  }
  if(btn)btn.disabled=false;
  startSyncLoop();
}
/* End-to-end encryption on (sync-crypto.js): every list and its side rows copied, sealed, under their lookup
   ids, each read back; then this device switches; then the old rows get {moved:'v2'}, which tells a newer
   device to follow (syncAdoptV2 in sync.js). The database refuses plain writes onto a moved row
   (supabase/migrations/20261031_sync_moved_v2.sql), so an older build can't put the lists back in the clear.
   Not offered in Settings yet: the Android widget, the claude.ai connector and the server-side writers
   (school feeds, the work calendar) can't read sealed rows yet. */
const SYNC_MOVED={moved:'v2'};
function syncV2Moves(c){
  const out=[];
  ['personal','work','agent','school'].forEach(function(ws){
    const prof=c[ws]; if(!validProfile(prof)||prof.v2)return;
    [''].concat(SYNC_SIDE_ROWS[ws]).forEach(function(sfx){
      const k={url:prof.url,key:prof.key,syncKey:prof.syncKey+sfx};
      out.push({ws:ws,sfx:sfx,oldBase:prof.syncKey,newBase:prof.syncKey,from:Object.assign({v2:false},k),to:Object.assign({v2:true},k)});
    });
  });
  return out;
}
async function syncMoveToV2(){
  const c=syncState.cfg;
  if(!c||!validProfile(c.personal)){ setSyncStatus('save the sync settings first',true); return false; }
  if(!syncCryptoOk()){ setSyncStatus('this device can’t encrypt (no WebCrypto)',true); return false; }
  clearInterval(syncState.pollTimer); clearTimeout(syncState.pushTimer);
  setSyncStatus('encrypting your lists…');
  let ok=false;
  try{
    for(let i=0;i<40&&syncState.busy;i++)await new Promise(function(r){ setTimeout(r,250); });
    await syncNow(); // this device's latest edits reach the old rows first
    clearTimeout(syncState.pushTimer); liveStop();
    const moves=syncV2Moves(c);
    await syncCopyRows(moves);
    const raw=Object.assign({},c,{personal:Object.assign({},c.personal,{v2:true})});
    syncOwnKeyLists(c).forEach(function(ws){ raw[ws]=Object.assign({},c[ws],{v2:true}); });
    syncState.cfg=normalizeSyncCfg(raw);
    await syncCfgPersist(syncState.cfg);
    syncState.docs={};
    let left=0;
    for(const m of moves){ try{ await syncPushDoc(m.from,SYNC_MOVED); }catch(e){ left++; } }
    setSyncStatus('your lists are end-to-end encrypted'+(left?' ('+left+' old rows could not be cleared; try again later)':''));
    ok=true;
  }catch(e){
    setSyncStatus('stopped before switching: '+e.message+' (this device is unchanged)',true);
  }
  startSyncLoop();
  return ok;
}
(function(){ // shows only while a list still has a key of its own
  const b=document.createElement('button'); b.id='syncOneKeyBtn'; b.className='ghost mono'; b.textContent='Use one key for every list'; b.hidden=true;
  b.title='Move Work, Agent and School under your sync key, so other devices need only that one key';
  $('syncGenBtn').insertAdjacentElement('afterend',b);
  b.addEventListener('click',syncUseOneKey);
})();
(function(){ // the button sits with the other sync buttons and shows only while sync is on
  const b=document.createElement('button'); b.id='syncRotateBtn'; b.className='ghost mono'; b.textContent='Rotate sync key';
  b.title='Make a new sync key and move every list over to it; the devices listed under Devices follow by themselves';
  $('syncGenBtn').insertAdjacentElement('afterend',b);
  b.addEventListener('click',syncRotateKey);
})();
(function(){ // end-to-end encryption (syncMoveToV2): shows while the lists are still plain in the project
  const b=document.createElement('button'); b.id='syncV2Btn'; b.className='ghost mono'; b.textContent='Encrypt my lists end to end'; b.hidden=true;
  b.title='Re-upload every list encrypted on this device, so the sync project holds only ciphertext';
  $('syncGenBtn').insertAdjacentElement('afterend',b);
  b.addEventListener('click',async function(){
    if(!confirm('Encrypt your lists end to end?\n\nEvery list, with what goes next to it (Notes, Hours, what the Agent knows about you, the Locked profile, routing rules, standing permissions, update answers, the Finance share box, the worker’s files), is uploaded again encrypted on this device under ids that give nothing away, and the old rows are replaced by a marker. From then on the project, its backups and whoever runs it hold only ciphertext.\n\nYour other devices follow on their next sync if they run Romulus 1.0.10 or newer; older ones show a sync error until they update. The claude.ai connector, the Work calendar feed and the School feed on the project can no longer read the lists and stop working. There is no way back from Settings.'))return;
    b.disabled=true;
    try{ await syncMoveToV2(); }finally{ b.disabled=false; syncFillForm(); }
  });
})();

