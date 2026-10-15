/* The Settings page.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── settings panel (all platforms) ── */
function syncFillForm(){
  const c=syncState.cfg||{};
  const p=c.personal||{}, w=c.work||{};
  $('syncUrl').value=p.url||'';
  $('syncAnonKey').value=p.key||'';
  $('syncKey').value=p.syncKey||'';
  $('syncUrlW').value=w.url||'';
  $('syncAnonKeyW').value=w.key||'';
  $('syncKeyW').value=w.syncKey||'';
  const ag=c.agent||{}, sc=c.school||{};
  // the project URL/key show only when they differ from personal's (blank = the same)
  $('syncUrlA').value=ag.url&&ag.url!==p.url?ag.url:''; $('syncAnonKeyA').value=ag.key&&ag.key!==p.key?ag.key:''; $('syncKeyA').value=ag.syncKey||'';
  $('syncUrlS').value=sc.url&&sc.url!==p.url?sc.url:''; $('syncAnonKeyS').value=sc.key&&sc.key!==p.key?sc.key:''; $('syncKeyS').value=sc.syncKey||'';
  $('syncOffBtn').hidden=!syncEnabled();
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
  return validProfile(a)?{url:a.url,key:a.key,syncKey:a.syncKey+':locked'}:null;
}
async function lockedLoad(){
  const p=lockedProfile(); $('lockedSection').hidden=!p; if(!p)return;
  $('lockedStatus').textContent='loading…';
  try{ const d=await syncPull(p); $('lockedText').value=(d&&d.text)||''; $('lockedStatus').textContent=''; }
  catch(e){ $('lockedStatus').textContent='could not load ('+e.message+')'; }
}
$('lockedSaveBtn').addEventListener('click',async function(){
  const p=lockedProfile(); if(!p)return;
  $('lockedStatus').textContent='saving…';
  try{ await syncPushDoc(p,{v:1,text:$('lockedText').value}); $('lockedStatus').textContent='saved'; }
  catch(e){ $('lockedStatus').textContent='save failed ('+e.message+')'; }
  setTimeout(function(){ $('lockedStatus').textContent=''; },2500);
});
// Form answers: the questions forms keep asking, answered once; the mini PC's form mode uses them as
// written, and a question left blank stays empty on the form. Added at the end, never over what's there.
const FORM_ANSWERS=`## Form answers
(Answer after each colon. Leave one blank and your mini PC leaves that question empty on forms.)
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
  [['claude','→ Claude'],['local','→ Mini PC']].forEach(function(o){ const op=document.createElement('option'); op.value=o[0]; op.textContent=o[1]; sel.appendChild(op); });
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
let prefsLoadedAt; // updated_at of the version in the box: Save only replaces that version (undefined = never loaded)
async function prefsLoad(){
  lockedLoad();
  routingLoad();
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
$('syncGenBtn').addEventListener('click',function(){
  $('syncKey').value='tk_'+(window.crypto&&crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2,10));
});
$('syncSaveBtn').addEventListener('click',function(){
  const url=$('syncUrl').value.trim(), key=$('syncAnonKey').value.trim(), sk=$('syncKey').value.trim();
  const urlW=$('syncUrlW').value.trim(), keyW=$('syncAnonKeyW').value.trim(), skW=$('syncKeyW').value.trim();
  if(!url||!key||!sk){ setSyncStatus('fill in the three personal fields',true); return; }
  const anyW=urlW||keyW||skW;
  if(anyW&&(!urlW||!keyW||!skW)){ setSyncStatus('work list needs all three fields (or none)',true); return; }
  // Agent / School: only the sync key is needed when they live in the personal project
  const side=function(u,k,sk2){ u=$(u).value.trim(); k=$(k).value.trim(); sk2=$(sk2).value.trim(); return sk2?{url:u||url,key:k||key,syncKey:sk2}:null; };
  const agentP=side('syncUrlA','syncAnonKeyA','syncKeyA'), schoolP=side('syncUrlS','syncAnonKeyS','syncKeyS');
  if(agentP&&agentP.syncKey===sk||schoolP&&schoolP.syncKey===sk){ setSyncStatus('Agent and School need their own sync keys, not the personal one',true); return; }
  syncState.cfg={personal:{url:url,key:key,syncKey:sk}};
  if(anyW)syncState.cfg.work={url:urlW,key:keyW,syncKey:skW};
  if(agentP)syncState.cfg.agent=agentP;
  if(schoolP)syncState.cfg.school=schoolP;
  localStorage.setItem(SYNC_CFG_KEY,JSON.stringify(syncState.cfg));
  if(window.desktop&&window.desktop.syncSaveCfg)window.desktop.syncSaveCfg(syncState.cfg);
  $('syncOffBtn').hidden=false;
  render(); // workspace chips may appear/disappear
  startSyncLoop();
});
$('syncOffBtn').addEventListener('click',function(){
  syncState.cfg=null; localStorage.removeItem(SYNC_CFG_KEY);
  clearInterval(syncState.pollTimer); clearTimeout(syncState.pushTimer);
  syncFillForm(); setSyncStatus('sync is off'); render();
});
