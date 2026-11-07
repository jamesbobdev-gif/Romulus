/* Family: shared lists (groceries, the house) and to-dos sent from one person to another, for everyone on
   one family plan on the Romulus server. One of the page scripts in renderer/js: they share one global scope.

   Everything shared is one synced row under a family key (tk_<43 random characters>) that the payer's app
   makes on the first invite. The row is sealed like every list (sync-crypto.js), so the server holds only
   ciphertext. The key reaches people two ways (supabase/migrations/20261113_sync_family_lists.sql):
     - in the invite code: its first 12 characters are the server's code, the last 16 a secret the server
       never sees, which seals the copy of the key kept with the invite;
     - each account keeps a copy sealed with its own lists' key, so all of a person's devices find it.
   Anyone given the key can read the shared row, so a to-do sent to one person is readable by the group.
   Taking someone off (or someone leaving) moves the group to a new key they never get (famRotate): the
   owner's app copies the shared row to the new key, seals the new key to each remaining person's public key
   (supabase/migrations/20261115_sync_group_plans.sql, family_key_next), and leaves {moved:1} in the old row.
   Each person's P-256 key pair travels inside their own sealed copy of the key, so all their devices have it.
   What was already on the removed person's device stays there; nothing new reaches them.
   Anyone can start a group for free with one other person; the Group plan makes room for 4 more.

   The document: {v:1, people, lists, items, offers, tombstones}, each record {id, created, updatedAt, ...}.
     people  {name, acct, owner}                      who is who; id = a hash of their own sync key, acct = their
                                                      server account id (so the owner's list of members has names)
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
  if(coll==='people'){ o.name=famStr(r.name,40); o.acct=/^[0-9a-f]{64}$/.test(r.acct)?r.acct:null; o.owner=!!r.owner; }
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

// people the server no longer lists (taken off, or left): their account isn't the owner's or a member's.
// People without an account id (older builds) can't be told apart, so they never count.
function famGone(doc,keepAccts){
  const keep={}; (keepAccts||[]).forEach(function(a){ if(a)keep[a]=1; });
  return famNorm(doc).people.filter(function(x){ return x.acct&&!keep[x.acct]; });
}
// the document without them: their name, and to-dos sent to or from them; tombstones so no old copy brings
// them back. What they added to lists stays (it's the group's now)
function famWithout(doc,keepAccts,now){
  const gone=famGone(doc,keepAccts); if(!gone.length)return famNorm(doc);
  const ids={}; gone.forEach(function(x){ ids[x.id]=1; });
  const d=famNorm(doc), t=now||Date.now(), tombs=[];
  d.people.forEach(function(x){ if(ids[x.id])tombs.push({id:x.id,deletedAt:t}); });
  d.offers.forEach(function(o){ if(ids[o.from]||ids[o.to])tombs.push({id:o.id,deletedAt:t}); });
  return famMerge(d,{tombstones:tombs},t);
}
// the shared list the Agent's grocery order reads: the one called Groceries
function famGroceryList(doc){ return (doc.lists||[]).find(function(l){ return /^\s*groceries\s*$/i.test(l.name); })||null; }
function famOpenGroceries(doc){
  const l=famGroceryList(doc); if(!l)return [];
  return (doc.items||[]).filter(function(it){ return it.list===l.id&&!it.done; });
}
/* the shared Groceries list folded into his own grocery list (grocery-list.js items {name, every, last, out}):
   each open line is flagged for the next order, added if it's new. A line bought (last) after it was last
   edited isn't flagged again, so a device that hasn't seen the check-off yet doesn't buy it twice.
   → the new list, or null when nothing changed. */
function famFeedList(list,open,same){
  const out=(list||[]).map(function(x){ return Object.assign({},x); }); let changed=false;
  open.forEach(function(it){
    const hit=out.find(function(x){ return same(x.name,it.text); });
    if(hit){
      if(hit.out)return;
      if(hit.last&&new Date(hit.last+'T23:59:59').getTime()>=it.updatedAt)return;
      hit.out=true; changed=true;
    } else { out.push({name:it.text,every:1,last:null,out:true}); changed=true; }
  });
  return changed?out:null;
}

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
async function famSealForInvite(secret,famKey,from){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv:iv},await famSecretKey(secret),new TextEncoder().encode(JSON.stringify(from?{k:famKey,from:famStr(from,40)}:{k:famKey})));
  return JSON.stringify({iv:syncB64(iv),ct:syncB64(new Uint8Array(ct))});
}
async function famOpenInvite(secret,sealed){
  const env=JSON.parse(sealed);
  const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:syncUnB64(env.iv)},await famSecretKey(secret),syncUnB64(env.ct));
  const o=JSON.parse(new TextDecoder().decode(pt));
  if(!/^tk_[A-Za-z0-9_-]{32,}$/.test(o.k))throw new Error('not a family key');
  return {k:o.k,from:o.from?famStr(o.from,40):null};
}
// each person's key pair for a new group key: made once, kept inside their own sealed copy of the key
async function famNewKeys(){
  const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const priv=await crypto.subtle.exportKey('jwk',pair.privateKey), pub=await crypto.subtle.exportKey('jwk',pair.publicKey);
  return {priv:pair.privateKey,privJwk:priv,pub:{kty:pub.kty,crv:pub.crv,x:pub.x,y:pub.y}};
}
async function famKeysFrom(env){
  if(!env||!env.priv||!env.pub)return null;
  try{ return {priv:await crypto.subtle.importKey('jwk',env.priv,{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']),privJwk:env.priv,pub:env.pub}; }
  catch(e){ return null; }
}
// who I am to the family: the same on all my devices (they share my sync key), and it leads nowhere
async function famMemberId(syncKey){
  const h=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('romulus-family-member|'+syncSplitKey(syncKey).base)));
  return Array.from(h.slice(0,8)).map(function(b){ return ('0'+b.toString(16)).slice(-2); }).join('');
}

/* ── state ── */
const fam={key:null, me:null, acct:null, keys:null, role:null, roster:null, rosterRows:null, doc:famEmpty(), checkedAt:0, loading:null, ui:{to:'',title:'',due:'',note:'',newList:'',adding:{},invite:null}};
(function(){ try{ const c=JSON.parse(localStorage.getItem(FAM_CACHE_KEY)); if(c&&c.doc){ fam.doc=famNorm(c.doc); fam.me=c.me||null; fam.cached=true; } }catch(e){} })();
function famSaveCache(){ try{ if(fam.key||fam.cached)localStorage.setItem(FAM_CACHE_KEY,JSON.stringify({doc:fam.doc,me:fam.me})); }catch(e){} }
function famPersonal(){ const p=syncState.cfg&&syncState.cfg.personal; return validProfile(p)&&typeof hostedIs==='function'&&hostedIs(p.url)?p:null; }
function familyProfile(){ const p=famPersonal(); return p&&fam.key?{url:p.url,key:p.key,syncKey:fam.key,v2:true}:null; }
function famOn(){ return !!(fam.key||fam.cached); }

// my copy of the group key, from the server. null on the server = I'm not (or no longer) in a group with lists.
// A new key waiting for me (the owner removed someone) is opened with my key pair and kept instead.
async function famLoadKey(){
  const p=famPersonal(); if(!p)return;
  fam.checkedAt=Date.now();
  let row;
  try{
    const rk=await syncRowKey(p);
    try{ row=(await syncRpc(p,'sync_family_key_get2',{p_sync_key:rk}))[0]||{}; }
    catch(e){ if(!/HTTP 404/.test(e.message))throw e; row={sealed:await syncRpc(p,'sync_family_key_get',{p_sync_key:rk}),old:true}; }
    fam.acct=await hostedAccountId(rk);
  }catch(e){ return; } // offline, or the migrations aren't on the server yet
  fam.me=await famMemberId(p.syncKey);
  if(!row.sealed){ if(famOn())famForget(); await famRoster(p); return; }
  let env; try{ env=await syncOpen(p.syncKey,JSON.parse(row.sealed)); }catch(e){ return; } // sealed under a sync key this device no longer has
  fam.key=env.k;
  fam.keys=await famKeysFrom(env);
  if(row.next&&fam.keys){
    try{
      const k2=JSON.parse(await devicesOpen(fam.keys.priv,JSON.parse(row.next))).k;
      if(/^tk_[A-Za-z0-9_-]{32,}$/.test(k2)){ await famKeep(p,k2); syncNow(); }
    }catch(e){}
  } else if(!fam.keys&&!row.old){
    try{ await famKeep(p,fam.key); }catch(e){} // from before key pairs: make one now, so a new key can reach me
  }
  famShowTab();
  await famRoster(p);
}
// who the server says is in the group; the owner's app moves the group to a new key when someone it still
// lists in the shared row has gone
async function famRoster(p){
  let rows=null;
  try{ rows=await syncRpc(p,'sync_family_list2',{p_sync_key:await syncRowKey(p)}); }catch(e){ return; }
  famNoteRoster(rows);
  if(fam.role==='owner'&&fam.key&&famGone(fam.doc,[fam.acct].concat(fam.roster)).length){
    try{ await famRotate(p); }catch(e){}
  }
}
function famNoteRoster(rows){
  rows=Array.isArray(rows)?rows:[];
  fam.rosterRows=rows; fam.role=rows[0]&&rows[0].role||null;
  fam.roster=rows.filter(function(r){ return r.member; }).map(function(r){ return r.member; });
}
async function famKeep(p,key){ // keep my copy of the key on the server, sealed with my own lists' key, with my key pair
  const keys=fam.keys||await famNewKeys();
  const sealed=JSON.stringify(await syncSeal(p.syncKey,{k:key,priv:keys.privJwk,pub:keys.pub})), rk=await syncRowKey(p);
  let ok;
  try{ ok=await syncRpc(p,'sync_family_key_set2',{p_sync_key:rk,p_sealed:sealed,p_pub:JSON.stringify(keys.pub)}); }
  catch(e){ if(!/HTTP 404/.test(e.message))throw e; ok=await syncRpc(p,'sync_family_key_set',{p_sync_key:rk,p_sealed:sealed}); }
  if(ok!==true)throw new Error('the server didn’t keep the group key');
  fam.key=key; fam.keys=keys; fam.me=await famMemberId(p.syncKey); fam.checkedAt=Date.now();
}
/* Move the group to a new key (the owner's app, after someone is removed or has left). → {left:[names of
   people on an older version, who need a new code]}, {busy:true} when another of the owner's devices is on
   it, or null (nothing to do, or a server without the migration). */
async function famRotate(p,opts){
  const old=familyProfile(); if(!old)return null;
  const rk=await syncRowKey(p);
  let locked; try{ locked=await syncRpc(p,'sync_family_rekey_lock',{p_sync_key:rk}); }catch(e){ if(/HTTP 404/.test(e.message))return null; throw e; }
  if(locked!==true)return {busy:true};
  const rows=await syncRpc(p,'sync_family_list2',{p_sync_key:rk});
  famNoteRoster(rows);
  if(fam.role!=='owner')return null;
  const keep=[fam.acct].concat(fam.roster);
  let first=await syncPullRow(old);
  let doc=famWithout(famTidy(famMerge(fam.doc,first.doc&&!first.doc.moved?first.doc:{})),keep);
  if(!(opts&&opts.force)&&!famGone(famMerge(fam.doc,first.doc&&!first.doc.moved?first.doc:{}),keep).length)return null;
  const k2='tk_'+syncB64Url(crypto.getRandomValues(new Uint8Array(32)));
  const next=Object.assign({},old,{syncKey:k2});
  await famPushMerged(next,doc);
  const left=[];
  for(const m of rows.filter(function(r){ return r.member; })){
    const name=(doc.people.find(function(x){ return x.acct===m.member; })||{}).name||'someone';
    if(!m.pub){ left.push(name); continue; }
    try{
      const wrapped=JSON.stringify(await devicesSeal(JSON.parse(m.pub),JSON.stringify({k:k2})));
      if(await syncRpc(p,'sync_family_rekey',{p_sync_key:rk,p_member:m.member,p_wrapped:wrapped})!==true)left.push(name);
    }catch(e){ left.push(name); }
  }
  await famKeep(p,k2);
  // the old row says it moved, after folding in anything written to it meanwhile
  for(let attempt=0;attempt<4;attempt++){
    const r=await syncPullRow(old);
    if(r.doc&&!r.doc.moved&&r.updatedAt!==first.updatedAt){ doc=famWithout(famMerge(doc,r.doc),keep); await famPushMerged(next,doc); }
    if(await syncPushCas(old,{v:1,moved:1},r.updatedAt))break;
    first=r;
  }
  fam.doc=doc; famSaveCache(); famShowTab(); if(state.activeTab==='family')renderFamily();
  return {left:left};
}
// download, merge, upload with the usual compare-and-set: what someone else just wrote isn't lost
async function famPushMerged(p,doc){
  for(let attempt=0;attempt<4;attempt++){
    const row=await syncPullRow(p);
    const merged=famMerge(doc,row.doc&&!row.doc.moved?row.doc:{});
    if(await syncPushCas(p,merged,row.updatedAt))return merged;
  }
  throw new Error('the group lists kept changing; try again');
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
  const mine=fam.doc.people.find(function(x){ return x.id===fam.me; });
  const r=(await syncRpc(p,'sync_family_invite2',{p_sync_key:await syncRowKey(p),p_sealed:await famSealForInvite(secret,key,mine&&mine.name)}))[0]||{};
  if(r.why)return {why:r.why};
  return {code:famCodeShow(r.code,secret)};
}
// Settings → I have a family code. → null = joined; else why. lists:false = joined, but the code had no key
async function famJoin(p,input){
  const c=famCodeSplit(input);
  const r=(await syncRpc(p,'sync_family_join2',{p_sync_key:await syncRowKey(p),p_code:c.server}))[0]||{};
  if(r.why)return {why:r.why};
  if(!r.sealed||!c.secret)return {lists:false};
  let o; try{ o=await famOpenInvite(c.secret,r.sealed); }catch(e){ return {lists:false}; } // the last 16 letters were typed wrong
  fam.keys=null; // a key pair of my own for this group
  await famKeep(p,o.k);
  fam.checkedAt=0; famShowTab(); syncNow();
  return {lists:true,from:o.from};
}

/* ── sync: called from syncOnce (sync.js), the same download-merge-upload as every list ── */
async function familySync(){
  if(!fam.key&&famPersonal()&&Date.now()-fam.checkedAt>10*60000)await famLoadKey();
  else if(fam.key&&Date.now()-fam.checkedAt>30*60000)await famLoadKey(); // taken off the plan: stop showing it
  const p=familyProfile(); if(!p)return;
  const before=famCanon(fam.doc);
  for(let attempt=0;attempt<4;attempt++){
    const row=await syncPullRow(p);
    // the owner moved the group to a new key: pick it up (or, if it never came, I was taken off)
    if(row.doc&&row.doc.moved){ fam.checkedAt=0; await famLoadKey(); if(fam.key&&fam.key!==p.syncKey)syncNow(); return; }
    const merged=famTidy(famMerge(fam.doc,row.doc));
    fam.doc=merged;
    if(row.doc&&famStable(famMerge(row.doc,{}))===famStable(merged))break;
    if(await syncPushCas(p,merged,row.updatedAt))break;
    if(attempt===3)throw new Error('the family lists kept changing; will retry');
  }
  if(famCanon(fam.doc)!==before){ famSaveCache(); famNoticeNew(); famShowTab(); if(state.activeTab==='family')renderFamily(); }
  famKeepMine();
  famFeedGroceries();
}
// my own record says who I am to the server and whether I run the group, so the owner's list has names
function famKeepMine(){
  const mine=fam.doc.people.find(function(x){ return x.id===fam.me; });
  if(!mine||!mine.name||!fam.acct)return;
  const owner=fam.role==='owner';
  if(mine.acct===fam.acct&&mine.owner===owner)return;
  famPut('people',Object.assign({},mine,{acct:fam.acct,owner:owner}));
}
// the shared Groceries list goes on the next grocery order, for anyone who has the Agent order groceries
function famFeedGroceries(){
  if(typeof groceryTask!=='function'||typeof normList!=='function')return;
  const t=groceryTask(); if(!t)return;
  const next=famFeedList(normList(t.list),famOpenGroceries(fam.doc),sameItem);
  if(next){ t.list=next; touch(); }
}
// what the Agent bought gets ticked off the shared Groceries list (grocery-list.js applyListUpdate)
function famCheckOff(names){
  if(!famOn()||!Array.isArray(names)||!names.length||typeof sameItem!=='function')return;
  const hits=famOpenGroceries(fam.doc).filter(function(it){ return names.some(function(n){ return sameItem(n,it.text); }); });
  if(!hits.length)return;
  const now=Date.now(), d=famNorm(fam.doc);
  hits.forEach(function(it){ d.items=d.items.filter(function(x){ return x.id!==it.id; }).concat([Object.assign({},it,{done:true,updatedAt:Math.max(now,it.updatedAt+1)})]); });
  fam.doc=famMerge(d,{}); famChanged();
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

/* ── invite, join, leave: the Group tab's buttons and Settings → Device sync use the same ones ── */
// → {code, say, share} or {say} when it didn't work
async function famInviteMake(){
  const p=famPersonal(); if(!p)return {say:'Sync has to be on, on the Romulus server, before you can start a group.'};
  let r;
  try{
    try{ r=await famInvite(p); }
    catch(e){ if(!/HTTP 404/.test(e.message))throw e; r=(await syncRpc(p,'sync_family_invite',{p_sync_key:await syncRowKey(p)}))[0]||{}; r.old=true; }
  }catch(e){ return {say:'couldn’t make a code: '+e.message}; }
  if(r.why)return {say:'couldn’t make a code: '+(typeof HOSTED_FAMILY_WHY!=='undefined'&&HOSTED_FAMILY_WHY[r.why]||r.why)};
  famRoster(p).then(function(){ if(typeof hostedDraw==='function')hostedDraw(); }).catch(function(){});
  const covered=fam.rosterRows&&fam.rosterRows[0]&&fam.rosterRows[0].plan==='group';
  const mine=fam.doc.people.find(function(x){ return x.id===fam.me; });
  return {code:r.code,
    say:'Code for them: '+r.code+'. It adds one person and works for 2 days.',
    share:(mine&&mine.name?mine.name+' invited you':'You’re invited')+' to a group on Romulus, to share lists and send each other to-dos. '
      +'In Romulus, open the Group tab, press I have a code, and type: '+r.code+'. '
      +(covered?'It’s free for you: the Group plan covers you, with 600 MB and 30 days of history.':'It’s free.')+' The code works for 2 days.'};
}
async function famJoinPrompt(){
  const code=prompt('The group code someone gave you:');
  if(!code||!code.trim())return false;
  const p=famPersonal(); if(!p){ setSyncStatus('couldn’t join: turn on sync first',true); return false; }
  try{
    let r;
    try{ r=await famJoin(p,code.trim()); }
    catch(e){ if(!/HTTP 404/.test(e.message))throw e; r={why:await syncRpc(p,'sync_family_join',{p_sync_key:await syncRowKey(p),p_code:famCodeSplit(code).server})||null,lists:false}; }
    if(r.why){ setSyncStatus('couldn’t join: '+(typeof HOSTED_FAMILY_WHY!=='undefined'&&HOSTED_FAMILY_WHY[r.why]||r.why),true); return false; }
    const said=r.lists?'You’re in '+(r.from?r.from+'’s':'the')+' group. Shared lists and to-dos are on the Group tab.':'You’re in the group. For the shared lists, ask for a new code: this one is from an older version.';
    setSyncStatus(said);
    if(typeof voiceToast==='function')voiceToast(said);
    if(typeof hostedDraw==='function')hostedDraw();
    if(state.activeTab==='family')renderFamily();
    return true;
  }catch(e){ setSyncStatus('couldn’t join: '+e.message,true); return false; }
}
async function famLeave(){
  if(!confirm('Leave the group? The group’s shared lists leave this app, and if the group’s plan covered you, you go back to the free space. Your own lists aren’t touched.'))return false;
  const p=famPersonal(); if(!p)return false;
  try{ await syncRpc(p,'sync_family_remove',{p_sync_key:await syncRowKey(p),p_member:null}); famForget(); setSyncStatus('you left the group'); return true; }
  catch(e){ setSyncStatus('couldn’t: '+e.message,true); return false; }
}
function famCopyButton(text){
  const b=el('button','ghost mono','Copy invite');
  b.addEventListener('click',function(){
    const done=function(){ if(typeof voiceToast==='function')voiceToast('Invite copied. Paste it in a text or email to them.'); };
    if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(text).then(done,function(){ prompt('Copy this:',text); });
    else prompt('Copy this:',text);
  });
  return b;
}

/* ── the Group tab ── */
function famShowTab(){
  const tab=$('tabFamily'); if(!tab)return;
  const on=famOn()||!!famPersonal();
  const waiting=fam.me&&famOn()?famForMe(fam.doc,fam.me).length:0;
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
  const a=document.activeElement;
  if(a&&a.isContentEditable&&view.contains(a)){ fam.renderLater=true; return; } // someone is typing in a line: after
  fam.renderLater=false;
  view.textContent='';
  const d=fam.doc, me=fam.me;
  if(!famOn()){
    const s=famSection(view,'Start a group','Share lists, like groceries, and send each other to-dos. Everyone keeps their own private lists. Free with one other person; the Group plan makes room for 4 more and covers their space.');
    const row=el('div','fam-row');
    row.appendChild(famBtn('Invite someone','btn-accent',famInviteHere));
    row.appendChild(famBtn('I have a code','ghost mono',function(){ famJoinPrompt(); }));
    s.appendChild(row); famInviteShown(s);
    return;
  }

  // first time here: the name the others see
  const mine=d.people.find(function(x){ return x.id===me; });
  if(me&&!(mine&&mine.name)){
    const s=famSection(view,'Your name','What your group sees next to what you add and send.');
    const row=el('div','fam-row');
    const inp=famInput('famMyName','Your name','');
    const save=function(){ const n=inp.value.trim(); if(!n){ inp.focus(); return; } famPut('people',{id:me,name:n,acct:fam.acct,owner:fam.role==='owner',created:mine?mine.created:Date.now(),updatedAt:mine?mine.updatedAt:0}); };
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
  const ss=famSection(view,'Send a to-do',others.length?'It shows up in their Group tab. They choose whether it goes on their list.':'Nobody else is here yet. Invite someone under People below; once they open this tab, you can send them to-dos.');
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

  // who is here, and room for one more
  const ps=famSection(view,'People');
  d.people.filter(function(x){ return x.name; }).forEach(function(x){
    const row=el('div','fam-sent');
    row.appendChild(el('span','fam-sent-title',x.name+(x.id===me?' (you)':'')));
    row.appendChild(el('span','fam-sent-state',x.owner?'runs the group':''));
    ps.appendChild(row);
  });
  const pr=el('div','fam-row');
  if(fam.role==='owner'){
    const r0=fam.rosterRows&&fam.rosterRows[0], room=r0&&Number(r0.room)||1;
    if((fam.roster||[]).length<room)pr.appendChild(famBtn('Invite someone','ghost mono',famInviteHere));
    else if(room<4)ps.appendChild(el('p','fam-hint','A free group is you and one other person. The Group plan makes room for 4 more, and covers their space: Settings → Device sync.'));
  }
  pr.appendChild(famBtn(fam.role==='owner'?'Manage people':'Group settings','ghost mono',function(){ if(typeof openSettingsAt==='function')openSettingsAt(null,'syncSection'); }));
  ps.appendChild(pr); famInviteShown(ps);

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
async function famInviteHere(){
  const r=await famInviteMake();
  fam.ui.invite=r;
  if(state.activeTab==='family')renderFamily();
}
// the code just made, with a button to copy an invite to send them
function famInviteShown(sec){
  const r=fam.ui.invite; if(!r)return;
  sec.appendChild(el('p','fam-hint',r.say));
  if(r.share){ const row=el('div','fam-row'); row.appendChild(famCopyButton(r.share)); sec.appendChild(row); }
}
/* Text that edits in place: one click puts the cursor where it landed. Enter or leaving it saves, Escape puts
   it back. While it's being typed in, the tab doesn't redraw under it (renderFamily waits for it). */
function famEditable(node,text,save){
  node.contentEditable='plaintext-only';
  if(node.contentEditable!=='plaintext-only')node.contentEditable='true';
  node.spellcheck=true; node.setAttribute('role','textbox'); node.setAttribute('aria-label','Edit: '+text);
  let undone=false;
  node.addEventListener('keydown',function(e){
    if(e.key==='Enter'){ e.preventDefault(); node.blur(); }
    else if(e.key==='Escape'){ undone=true; node.textContent=text; node.blur(); }
  });
  node.addEventListener('blur',function(){
    const v=famStr(node.textContent,200);
    if(!undone&&v!==text)save(v);
    undone=false;
    if(fam.renderLater){ fam.renderLater=false; setTimeout(function(){ if(state.activeTab==='family')renderFamily(); },0); }
  });
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
    // the box ticks; the words are edited where they are, the cursor landing where the click did
    const row=el('div','fam-item'+(it.done?' done':''));
    const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=it.done; cb.setAttribute('aria-label','Got it: '+it.text);
    cb.addEventListener('change',function(){ famPut('items',Object.assign({},it,{done:cb.checked})); });
    row.appendChild(cb);
    const tx=el('span','fam-item-text',it.text);
    famEditable(tx,it.text,function(v){
      if(!v)famDel(it.id); // emptied: the line goes
      else famPut('items',Object.assign({},it,{text:v}));
    });
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
  // a click on the card's empty space goes straight to typing a new line
  card.addEventListener('click',function(e){ if(e.target===card||e.target===head||e.target.classList.contains('fam-list-name'))inp.focus(); });
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

if(typeof module!=='undefined')module.exports={famEmpty,famNorm,famMerge,famTidy,famCanon,famStable,famForMe,famSentByMe,famName,famCodeShow,famCodeSplit,famNewSecret,famGone,famWithout,famGroceryList,famOpenGroceries,famFeedList};
