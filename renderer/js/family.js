/* Family: shared lists (groceries, the house) and to-dos sent from one person to another, for everyone on
   one family plan on the Romulus server. One of the page scripts in renderer/js: they share one global scope.

   Everything shared is one synced row under a family key (tk_<43 random characters>) that the payer's app
   makes on the first invite. The row is sealed like every list (sync-crypto.js), so the server holds only
   ciphertext. The key reaches people two ways (supabase/migrations/20261113_sync_family_lists.sql):
     - in the invite code: its first 12 characters are the server's code, the last 16 a secret the server
       never sees, which seals the copy of the key kept with the invite;
     - each account keeps a copy sealed with its own lists' key, so all of a person's devices find it.
   Anyone given the key can read the shared row, so a to-do sent to one person is readable by the family.
   Taking someone off the plan drops their copy and their devices stop showing it; a device that already
   had the key could still read the row, as with any shared password.

   The document: {v:1, people, lists, items, offers, tombstones}, each record {id, created, updatedAt, ...}.
     people  {name}                                   who is who; id = a hash of their own sync key
     lists   {name}                                   a shared list
     items   {list, text, done, by}                   a line on a list
     offers  {from, to, title, due, note, answer, answeredAt}   a to-do sent to someone; answer 'added' | 'no'
   Per record the newer updatedAt wins, a tombstone beats a record not edited after it. */
'use strict';

const FAM_COLLS=['people','lists','items','offers'];
const FAM_CACHE_KEY='tasks.family.v1';
const FAM_SEEN_KEY='tasks.family.seen';
const FAM_CODE_ABC='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 letters: 16 of them are 80 bits, no 0/O or 1/I to mix up
const FAM_TOMB_DAYS=60, FAM_OFFER_KEEP_DAYS=7;
const FAM_SEND_ICON='<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M1.2 5.6L10.8 1.2 7.4 10.8 5.6 6.4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5.6 6.4l5.2-5.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

/* ── the document (pure: test/family.test.js) ── */
function famEmpty(){ return {v:1,people:[],lists:[],items:[],offers:[],tombstones:[]}; }
function famStr(s,max){ return String(s==null?'':s).replace(/[\u0000-\u001f]/g,' ').trim().slice(0,max); }
function famRec(coll,r){
  if(!r||typeof r!=='object'||typeof r.id!=='string'||!r.id||r.id.length>80)return null;
  const o={id:r.id,created:Number(r.created)||0,updatedAt:Number(r.updatedAt)||0};
  if(coll==='people'){ o.name=famStr(r.name,40); }
  else if(coll==='lists'){ o.name=famStr(r.name,60)||'List'; }
  else if(coll==='items'){ o.list=String(r.list||''); o.text=famStr(r.text,200); o.done=!!r.done; o.by=String(r.by||''); if(!o.text||!o.list)return null; }
  else if(coll==='offers'){
    o.from=String(r.from||''); o.to=String(r.to||''); o.title=famStr(r.title,300); if(!o.title||!o.to)return null;
    o.due=/^\d{4}-\d{2}-\d{2}$/.test(r.due)?r.due:null;
    o.note=famStr(r.note,1000)||null;
    o.answer=r.answer==='added'||r.answer==='no'?r.answer:null;
    o.answeredAt=o.answer?Number(r.answeredAt)||0:null;
  }
  return o;
}
function famNorm(doc){
  const d=doc&&typeof doc==='object'?doc:{}, out=famEmpty();
  FAM_COLLS.forEach(function(c){ out[c]=(Array.isArray(d[c])?d[c]:[]).map(function(r){ return famRec(c,r); }).filter(Boolean).slice(0,c==='items'?3000:500); });
  out.tombstones=(Array.isArray(d.tombstones)?d.tombstones:[]).filter(function(t){ return t&&typeof t.id==='string'&&Number(t.deletedAt)>0; })
    .map(function(t){ return {id:t.id,deletedAt:Number(t.deletedAt)}; });
  return out;
}
function famStable(v){
  return JSON.stringify(v,function(k,x){
    if(!x||typeof x!=='object'||Array.isArray(x))return x;
    const o={}; Object.keys(x).sort().forEach(function(key){ o[key]=x[key]; }); return o;
  });
}
function famCanon(doc){ return famStable(famNorm(doc)); }
const famOrder=function(a,b){ return (a.created-b.created)||(a.id<b.id?-1:a.id>b.id?1:0); };
// both sides of a merge come out byte-for-byte the same, so two devices never keep re-uploading each other
function famMerge(a,b,now){
  a=famNorm(a); b=famNorm(b);
  const tombs={};
  a.tombstones.concat(b.tombstones).forEach(function(t){ if(!tombs[t.id]||t.deletedAt>tombs[t.id])tombs[t.id]=t.deletedAt; });
  const out=famEmpty();
  FAM_COLLS.forEach(function(c){
    const byId={};
    a[c].concat(b[c]).forEach(function(r){
      const p=byId[r.id];
      if(!p||r.updatedAt>p.updatedAt||(r.updatedAt===p.updatedAt&&famStable(r)>famStable(p)))byId[r.id]=r;
    });
    out[c]=Object.keys(byId).map(function(id){ return byId[id]; })
      .filter(function(r){ return !(tombs[r.id]&&tombs[r.id]>=r.updatedAt); }).sort(famOrder);
  });
  // a list that's gone takes its lines with it
  const lists={}; out.lists.forEach(function(l){ lists[l.id]=1; });
  out.items=out.items.filter(function(it){ return lists[it.list]||!tombs[it.list]; });
  const cutoff=(now||Date.now())-FAM_TOMB_DAYS*864e5;
  out.tombstones=Object.keys(tombs).filter(function(id){ return tombs[id]>cutoff; }).sort().map(function(id){ return {id:id,deletedAt:tombs[id]}; });
  return out;
}
// answered to-dos stay a week so the sender sees the answer, then go. The tombstone's time comes from the
// answer, so every device makes the same one
function famTidy(doc,now){
  const d=famNorm(doc), t=now||Date.now(), gone=[];
  d.offers.forEach(function(o){ if(o.answer&&o.answeredAt&&t-o.answeredAt>FAM_OFFER_KEEP_DAYS*864e5)gone.push({id:o.id,deletedAt:o.answeredAt+FAM_OFFER_KEEP_DAYS*864e5}); });
  if(!gone.length)return d;
  return famMerge(d,{tombstones:gone},t);
}
function famName(doc,id){ const p=(doc.people||[]).find(function(x){ return x.id===id; }); return p&&p.name?p.name:'Someone'; }
function famForMe(doc,me){ return (doc.offers||[]).filter(function(o){ return o.to===me&&!o.answer; }); }
function famSentByMe(doc,me){ return (doc.offers||[]).filter(function(o){ return o.from===me; }); }

/* ── invite codes (pure) ── 'F0B3-65FB-585B' from the server + a 16-letter secret, shown in groups of 4 */
function famCodeShow(server,secret){
  const s=String(server||'').replace(/[^A-Za-z0-9]/g,'').toUpperCase()+String(secret||'').toUpperCase();
  return (s.match(/.{1,4}/g)||[]).join('-');
}
function famCodeSplit(input){
  const s=String(input||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(s.length===28)return {server:s.slice(0,12),secret:s.slice(12)};
  return {server:s,secret:null}; // a code from an older build: it joins the plan, without the shared lists
}
function famNewSecret(rand){
  const b=rand||crypto.getRandomValues(new Uint8Array(16));
  let s=''; for(let i=0;i<16;i++)s+=FAM_CODE_ABC[b[i]&31];
  return s;
}

/* ── keys (browser) ── */
async function famSecretKey(secret){
  const enc=new TextEncoder();
  const raw=await crypto.subtle.importKey('raw',enc.encode(String(secret)),'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:enc.encode('romulus-family-invite'),info:enc.encode('family-key')},raw,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function famSealForInvite(secret,famKey){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv:iv},await famSecretKey(secret),new TextEncoder().encode(JSON.stringify({k:famKey})));
  return JSON.stringify({iv:syncB64(iv),ct:syncB64(new Uint8Array(ct))});
}
async function famOpenInvite(secret,sealed){
  const env=JSON.parse(sealed);
  const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:syncUnB64(env.iv)},await famSecretKey(secret),syncUnB64(env.ct));
  const k=JSON.parse(new TextDecoder().decode(pt)).k;
  if(!/^tk_[A-Za-z0-9_-]{32,}$/.test(k))throw new Error('not a family key');
  return k;
}
// who I am to the family: the same on all my devices (they share my sync key), and it leads nowhere
async function famMemberId(syncKey){
  const h=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('romulus-family-member|'+syncSplitKey(syncKey).base)));
  return Array.from(h.slice(0,8)).map(function(b){ return ('0'+b.toString(16)).slice(-2); }).join('');
}

/* ── state ── */
const fam={key:null, me:null, doc:famEmpty(), checkedAt:0, loading:null, ui:{to:'',title:'',due:'',note:'',newList:'',adding:{}}};
(function(){ try{ const c=JSON.parse(localStorage.getItem(FAM_CACHE_KEY)); if(c&&c.doc){ fam.doc=famNorm(c.doc); fam.me=c.me||null; fam.cached=true; } }catch(e){} })();
function famSaveCache(){ try{ if(fam.key||fam.cached)localStorage.setItem(FAM_CACHE_KEY,JSON.stringify({doc:fam.doc,me:fam.me})); }catch(e){} }
function famPersonal(){ const p=syncState.cfg&&syncState.cfg.personal; return validProfile(p)&&typeof hostedIs==='function'&&hostedIs(p.url)?p:null; }
function familyProfile(){ const p=famPersonal(); return p&&fam.key?{url:p.url,key:p.key,syncKey:fam.key,v2:true}:null; }
function famOn(){ return !!(fam.key||fam.cached); }

// my copy of the family key, from the server. null on the server = I'm not (or no longer) in a family with lists
async function famLoadKey(){
  const p=famPersonal(); if(!p)return;
  fam.checkedAt=Date.now();
  let sealed;
  try{ sealed=await syncRpc(p,'sync_family_key_get',{p_sync_key:await syncRowKey(p)}); }
  catch(e){ return; } // offline, or the migration isn't on the server yet
  fam.me=await famMemberId(p.syncKey);
  if(!sealed){ if(famOn())famForget(); return; }
  try{ fam.key=(await syncOpen(p.syncKey,JSON.parse(sealed))).k; }catch(e){ return; } // sealed under a sync key this device no longer has
  famShowTab();
}
async function famKeep(p,key){ // keep my copy of the key on the server, sealed with my own lists' key
  const ok=await syncRpc(p,'sync_family_key_set',{p_sync_key:await syncRowKey(p),p_sealed:JSON.stringify(await syncSeal(p.syncKey,{k:key}))});
  if(ok!==true)throw new Error('the server didn’t keep the family key');
  fam.key=key; fam.me=await famMemberId(p.syncKey); fam.checkedAt=Date.now();
}
function famForget(){
  fam.key=null; fam.cached=false; fam.doc=famEmpty();
  try{ localStorage.removeItem(FAM_CACHE_KEY); localStorage.removeItem(FAM_SEEN_KEY); }catch(e){}
  famShowTab();
}
// the payer's first invite makes the family's key, and a Groceries list to start with
async function famEnsureKey(p){
  if(!fam.key)await famLoadKey();
  if(fam.key)return fam.key;
  const key='tk_'+syncB64Url(crypto.getRandomValues(new Uint8Array(32)));
  await famKeep(p,key);
  const now=Date.now();
  fam.doc=famMerge(fam.doc,{lists:[{id:uid(),name:'Groceries',created:now,updatedAt:now}]});
  famSaveCache(); famShowTab(); schedulePush();
  return key;
}
// Settings → Invite someone: a code that carries the key. → the code to show, or {why}
async function famInvite(p){
  const key=await famEnsureKey(p), secret=famNewSecret();
  const r=(await syncRpc(p,'sync_family_invite2',{p_sync_key:await syncRowKey(p),p_sealed:await famSealForInvite(secret,key)}))[0]||{};
  if(r.why)return {why:r.why};
  return {code:famCodeShow(r.code,secret)};
}
// Settings → I have a family code. → null = joined; else why. lists:false = joined, but the code had no key
async function famJoin(p,input){
  const c=famCodeSplit(input);
  const r=(await syncRpc(p,'sync_family_join2',{p_sync_key:await syncRowKey(p),p_code:c.server}))[0]||{};
  if(r.why)return {why:r.why};
  if(!r.sealed||!c.secret)return {lists:false};
  let key; try{ key=await famOpenInvite(c.secret,r.sealed); }catch(e){ return {lists:false}; } // the last 16 letters were typed wrong
  await famKeep(p,key);
  famShowTab(); syncNow();
  return {lists:true};
}

/* ── sync: called from syncOnce (sync.js), the same download-merge-upload as every list ── */
async function familySync(){
  if(!fam.key&&famPersonal()&&Date.now()-fam.checkedAt>10*60000)await famLoadKey();
  else if(fam.key&&Date.now()-fam.checkedAt>30*60000)await famLoadKey(); // taken off the plan: stop showing it
  const p=familyProfile(); if(!p)return;
  const before=famCanon(fam.doc);
  for(let attempt=0;attempt<4;attempt++){
    const row=await syncPullRow(p);
    const merged=famTidy(famMerge(fam.doc,row.doc));
    fam.doc=merged;
    if(row.doc&&famStable(famMerge(row.doc,{}))===famStable(merged))break;
    if(await syncPushCas(p,merged,row.updatedAt))break;
    if(attempt===3)throw new Error('the family lists kept changing; will retry');
  }
  if(famCanon(fam.doc)!==before){ famSaveCache(); famNoticeNew(); famShowTab(); if(state.activeTab==='family')renderFamily(); }
}
// a to-do someone sent me since I last looked: say so once
function famNoticeNew(){
  if(!fam.me)return;
  let seen=[]; try{ seen=JSON.parse(localStorage.getItem(FAM_SEEN_KEY))||[]; }catch(e){}
  const fresh=famForMe(fam.doc,fam.me).filter(function(o){ return seen.indexOf(o.id)===-1; });
  if(!fresh.length)return;
  const o=fresh[fresh.length-1];
  if(typeof voiceToast==='function')voiceToast(famName(fam.doc,o.from)+' sent you a to-do: '+o.title+(fresh.length>1?' (and '+(fresh.length-1)+' more)':'')+'. It’s on the Group tab.');
  if(typeof buzz==='function')buzz('answer');
  try{ localStorage.setItem(FAM_SEEN_KEY,JSON.stringify(seen.concat(fresh.map(function(x){ return x.id; })).slice(-300))); }catch(e){}
}

/* ── changes made here ── */
function famChanged(){ famSaveCache(); famShowTab(); if(state.activeTab==='family')renderFamily(); schedulePush(); }
function famPut(coll,rec){
  const now=Date.now();
  const r=Object.assign({created:now},rec,{updatedAt:Math.max(now,(Number(rec.updatedAt)||0)+1)});
  const d=famNorm(fam.doc);
  d[coll]=d[coll].filter(function(x){ return x.id!==r.id; }).concat([r]);
  fam.doc=famMerge(d,{});
  famChanged();
}
function famDel(ids){
  const now=Date.now();
  fam.doc=famMerge(fam.doc,{tombstones:[].concat(ids).map(function(id){ return {id:id,deletedAt:now}; })});
  famChanged();
}
function famAnswer(o,answer){
  if(answer==='added'){
    const notes=['From '+famName(fam.doc,o.from)+'.'].concat(o.note?[o.note]:[]).join('\n\n');
    state.tasks.push({id:uid(),title:o.title,done:false,due:o.due||null,dueTime:null,tag:null,notes:notes,ws:'personal',subs:[],googleEventId:null,created:Date.now()});
    touch();
  }
  famPut('offers',Object.assign({},o,{answer:answer,answeredAt:Date.now()}));
  if(answer==='added'&&typeof voiceToast==='function')voiceToast('Added to your To do list.');
}
// the send button on a task row (lists.js): the Family tab opens with it filled in
function famSendTask(t){
  fam.ui.title=t.title||''; fam.ui.due=t.due||''; fam.ui.note=t.notes||'';
  switchTab('family');
  setTimeout(function(){ const s=$('famTo'); if(s)s.focus(); },0);
}
function famOthers(){ return fam.doc.people.filter(function(x){ return x.id!==fam.me&&x.name; }); }
function famCanSend(){ return famOn()&&!!fam.me&&famOthers().length>0; }

/* ── the Family tab ── */
function famShowTab(){
  const tab=$('tabFamily'); if(!tab)return;
  const on=famOn();
  const waiting=fam.me?famForMe(fam.doc,fam.me).length:0;
  tab.textContent=waiting?'Group ('+waiting+')':'Group';
  if(tab.hidden!==!on){
    tab.hidden=!on;
    if(typeof drawTabPicker==='function')drawTabPicker();
    if(typeof applyTabsOff==='function')applyTabsOff();
    if(!on&&state.activeTab==='family')switchTab('list');
  }
}
function famSection(view,title,hint){
  const s=el('section','fam-sec'); s.appendChild(el('div','fam-k',title));
  if(hint)s.appendChild(el('p','fam-hint',hint));
  view.appendChild(s); return s;
}
function famBtn(text,cls,fn){ const b=el('button',cls||'ghost mono',text); b.addEventListener('click',fn); return b; }
function famInput(id,ph,val,cls){ const i=el('input','sm'+(cls?' '+cls:'')); if(id)i.id=id; i.placeholder=ph; i.setAttribute('aria-label',ph); i.value=val||''; return i; }
function famDueText(due){ return due?dateInfo(due,null).text:''; }
function renderFamily(){
  const view=$('familyView'); if(!view)return;
  view.textContent='';
  const d=fam.doc, me=fam.me;
  if(!famOn()){ view.appendChild(el('p','fam-empty','Shared lists show up here once you’re on a family/group plan.')); return; }

  // first time here: the name the others see
  const mine=d.people.find(function(x){ return x.id===me; });
  if(me&&!(mine&&mine.name)){
    const s=famSection(view,'Your name','What your group sees next to what you add and send.');
    const row=el('div','fam-row');
    const inp=famInput('famMyName','Your name','');
    const save=function(){ const n=inp.value.trim(); if(!n){ inp.focus(); return; } famPut('people',{id:me,name:n,created:mine?mine.created:Date.now(),updatedAt:mine?mine.updatedAt:0}); };
    inp.addEventListener('keydown',function(e){ if(e.key==='Enter')save(); });
    row.appendChild(inp); row.appendChild(famBtn('Save','btn-accent',save)); s.appendChild(row);
  }

  // sent to me, waiting for an answer
  const forMe=me?famForMe(d,me):[];
  if(forMe.length){
    const s=famSection(view,'For you');
    forMe.forEach(function(o){
      const card=el('div','fam-offer');
      const top=el('div','fam-offer-top');
      top.appendChild(el('span','fam-offer-title',o.title));
      if(o.due)top.appendChild(el('span','chip',famDueText(o.due)));
      card.appendChild(top);
      card.appendChild(el('div','fam-hint','From '+famName(d,o.from)));
      if(o.note)card.appendChild(el('div','fam-note',o.note));
      const acts=el('div','fam-row');
      acts.appendChild(famBtn('Add to my list','btn-accent',function(){ famAnswer(o,'added'); }));
      acts.appendChild(famBtn('No thanks','ghost mono',function(){ famAnswer(o,'no'); }));
      card.appendChild(acts); s.appendChild(card);
    });
  }

  // lists
  const ls=famSection(view,'Lists');
  d.lists.forEach(function(l){ ls.appendChild(famListCard(l)); });
  const nl=el('div','fam-row');
  const nlIn=famInput('famNewList','New list (Hardware store, Chores…)',fam.ui.newList);
  nlIn.addEventListener('input',function(){ fam.ui.newList=nlIn.value; });
  const addList=function(){ const n=nlIn.value.trim(); if(!n)return; fam.ui.newList=''; famPut('lists',{id:uid(),name:n}); setTimeout(function(){ const x=$('famNewList'); if(x)x.focus(); },0); };
  nlIn.addEventListener('keydown',function(e){ if(e.key==='Enter')addList(); });
  nl.appendChild(nlIn); nl.appendChild(famBtn('Add list','ghost mono',addList)); ls.appendChild(nl);

  // send a to-do
  const others=famOthers();
  const ss=famSection(view,'Send a to-do',others.length?'It shows up in their Group tab. They choose whether it goes on their list.':'Nobody else is here yet. Invite someone from Settings → Device sync → Family/Group plan; once they open this tab, you can send them to-dos.');
  if(others.length&&me){
    const form=el('div','fam-send');
    const to=el('select','sm'); to.id='famTo'; to.setAttribute('aria-label','Send to');
    others.forEach(function(x){ const o=el('option',null,x.name); o.value=x.id; to.appendChild(o); });
    if(others.some(function(x){ return x.id===fam.ui.to; }))to.value=fam.ui.to;
    to.addEventListener('change',function(){ fam.ui.to=to.value; });
    const title=famInput('famTitle','What needs doing',fam.ui.title,'fam-grow');
    title.addEventListener('input',function(){ fam.ui.title=title.value; });
    const due=el('input','sm'); due.type='date'; due.value=fam.ui.due; due.setAttribute('aria-label','Due (optional)');
    due.addEventListener('input',function(){ fam.ui.due=due.value; });
    const note=famInput('famNote','Note (optional)',fam.ui.note,'fam-grow');
    note.addEventListener('input',function(){ fam.ui.note=note.value; });
    const send=function(){
      const t=title.value.trim(); if(!t){ title.focus(); return; }
      const off={id:uid(),from:me,to:to.value,title:t,due:due.value||null,note:note.value.trim()||null};
      fam.ui.title=''; fam.ui.due=''; fam.ui.note='';
      famPut('offers',off);
      if(typeof voiceToast==='function')voiceToast('Sent to '+famName(fam.doc,to.value)+'.');
    };
    title.addEventListener('keydown',function(e){ if(e.key==='Enter')send(); });
    form.appendChild(to); form.appendChild(title); form.appendChild(due); form.appendChild(note); form.appendChild(famBtn('Send','btn-accent',send));
    ss.appendChild(form);
  }

  // what I sent, and what they said
  const sent=me?famSentByMe(d,me):[];
  if(sent.length){
    const s=famSection(view,'Sent');
    sent.slice().reverse().forEach(function(o){
      const row=el('div','fam-sent');
      row.appendChild(el('span','fam-sent-title',o.title));
      const who=famName(d,o.to);
      row.appendChild(el('span','fam-sent-state'+(o.answer==='added'?' ok':''),o.answer==='added'?who+' added it':o.answer==='no'?who+' said no thanks':'Waiting on '+who));
      const x=iconBtn(I.x,o.answer?'Clear':'Take it back'); x.title=o.answer?'Clear':'Take it back';
      x.addEventListener('click',function(){ famDel(o.id); });
      row.appendChild(x); s.appendChild(row);
    });
  }
}
function famListCard(l){
  const d=fam.doc, card=el('div','fam-list');
  const items=d.items.filter(function(it){ return it.list===l.id; });
  const open=items.filter(function(it){ return !it.done; }), done=items.filter(function(it){ return it.done; });
  const head=el('div','fam-list-head');
  head.appendChild(el('span','fam-list-name',l.name));
  head.appendChild(el('span','fam-hint',open.length?open.length+' to get':'all done'));
  const pen=iconBtn(I.pen,'Rename list'); pen.title='Rename';
  pen.addEventListener('click',function(){ const n=prompt('Rename the list:',l.name); if(n&&n.trim())famPut('lists',Object.assign({},l,{name:n.trim()})); });
  const del=iconBtn(I.x,'Delete list'); del.title='Delete list';
  del.addEventListener('click',function(){ if(confirm('Delete “'+l.name+'” for everyone in the group?'))famDel([l.id].concat(items.map(function(it){ return it.id; }))); });
  head.appendChild(pen); head.appendChild(del); card.appendChild(head);
  open.concat(done).forEach(function(it){
    const row=el('label','fam-item'+(it.done?' done':''));
    const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=it.done;
    cb.addEventListener('change',function(){ famPut('items',Object.assign({},it,{done:cb.checked})); });
    row.appendChild(cb);
    const tx=el('span','fam-item-text',it.text);
    if(it.by&&it.by!==fam.me)tx.title='Added by '+famName(d,it.by);
    row.appendChild(tx);
    if(it.by&&it.by!==fam.me)row.appendChild(el('span','fam-by',famName(d,it.by)));
    card.appendChild(row);
  });
  const add=el('div','fam-row');
  const inp=famInput(null,'Add to '+l.name,fam.ui.adding[l.id]||'','fam-grow');
  inp.addEventListener('input',function(){ fam.ui.adding[l.id]=inp.value; });
  const put=function(){
    // "eggs, milk and bread" → three lines
    const names=inp.value.split(/\s*(?:,|\band\b|&|\n)\s*/i).map(function(s){ return s.trim(); }).filter(Boolean).slice(0,30);
    if(!names.length)return;
    fam.ui.adding[l.id]='';
    const now=Date.now(), dd=famNorm(fam.doc);
    names.forEach(function(n,i){ dd.items.push({id:uid(),list:l.id,text:n.charAt(0).toUpperCase()+n.slice(1),done:false,by:fam.me||'',created:now+i,updatedAt:now}); });
    fam.doc=famMerge(dd,{}); famChanged();
    setTimeout(function(){ const x=document.querySelector('[data-fam-add="'+l.id+'"]'); if(x)x.focus(); },0);
  };
  inp.dataset.famAdd=l.id;
  inp.addEventListener('keydown',function(e){ if(e.key==='Enter')put(); });
  add.appendChild(inp); add.appendChild(famBtn('Add','ghost mono',put));
  if(done.length)add.appendChild(famBtn('Clear checked ('+done.length+')','ghost mono',function(){ famDel(done.map(function(it){ return it.id; })); }));
  card.appendChild(add);
  return card;
}

/* ── start ── */
if(typeof document!=='undefined'&&document.getElementById('tabFamily')){
  $('tabFamily').addEventListener('click',function(){ switchTab('family'); });
  famShowTab();
  Promise.resolve(syncState.ready).then(function(){ setTimeout(function(){ famLoadKey().then(function(){ if(fam.key)syncNow(); }); },3000); });
}

if(typeof module!=='undefined')module.exports={famEmpty,famNorm,famMerge,famTidy,famCanon,famStable,famForMe,famSentByMe,famName,famCodeShow,famCodeSplit,famNewSecret};
