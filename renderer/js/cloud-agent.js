/* Romulus cloud: an Agent task answered on the Romulus server when none of the person's own computers is on to
   take it, so the Agent works with nothing set up. Only on a device with no Agent runner of its own (a phone, or
   the app in a browser) whose lists sync on the Romulus server (hosted-sync.js), and only after they say yes:
   the first time, the waiting task asks "Always / Just this once / No thanks" (Settings → Agent changes it).
   - What goes: this one task (title, notes, their conversation on it) and their "What Claude knows about you"
     notes. Never Finance, the Locked profile, photos, or a task with private words, a card or ID number in it.
   - The server (supabase/functions/cloud-agent) asks the AI with web search, then keeps the answer sealed with a
     one-time key made here, so only this device can open it; it's deleted once picked up. The task itself is
     never stored there.
   - Each account has a monthly allowance (free / paid plan); past it, tasks wait for a computer as before.
   The pure part (what may go, the request, sealing) is above the DOM code, for test/cloud-agent.test.js. */
'use strict';

const CLOUD_AG_PREF='tasks.cloudAgent';   // 'always' | 'never' | unset (ask)
const CLOUD_AG_JOBS='tasks.cloudJobs';    // [{job, id, priv, at}] answers this device is waiting for
const CLOUD_AG_WAIT_MS=45*1000;           // no computer took it in this long: offer (or send)
const CLOUD_AG_WORKER_WAIT_MS=4*60*1000;  // a mini PC is on: it gets first go (it takes cloud tasks after 3 min)
const CLOUD_AG_NAME='Romulus cloud';
// the private words agent/routing.js starts with; the person's own list (the ':routing' row) adds to them
const CLOUD_AG_PRIVATE='password, passcode, pin number, bank, bank account, credit card, debit card, ssn, social security, '+
  'passport, tax, taxes, salary, payslip, medical, doctor, health, therapy, therapist, prescription, grades, transcript, report card';
const CLOUD_AG_MONEY=/\b(my|our)\s+(spending|bank|accounts?|balances?|budget|bills|income|finances?|money|net worth|transactions?|statements?|subscriptions?|savings|portfolio|stocks|investments|expenses|purchases|paychecks?|credit cards?|debts?|cash flow|charges)\b|\bhow much (did|have|has|do) (i|we) (spend|spent|pay|paid|earn|earned|make|made|save|saved|owe)\b/i;
const CLOUD_AG_MAIL=/\b(inbox|gmail|outlook|my e-?mails?|my mail)\b/i;

function cloudAgEsc(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
// their own words on the task (not what an AI wrote)
function cloudAgTheirText(t){
  return [t.title,t.notes,t.reply].concat((Array.isArray(t.history)?t.history:[]).filter(function(h){ return h&&h.who==='you'; }).map(function(h){ return h.text; }))
    .map(function(x){ return String(x||''); }).join('\n');
}
/* → why this task stays off Romulus cloud (plain words), or '' when it may go. privateWords: their routing list */
function cloudAgWhyNot(t,privateWords){
  if(!t||t.done)return 'finished';
  if(t.lane==='local')return 'it’s set to your own model';
  if(t.financeSeen)return 'it’s about your finances';
  if(t.cart||t.list)return 'it shops in your store accounts';
  if(t.replyImages&&t.replyImages.length)return 'it has photos';
  const text=cloudAgTheirText(t), low=text.toLowerCase();
  const words=String(privateWords==null?CLOUD_AG_PRIVATE:privateWords).split(',').map(function(w){ return w.trim().toLowerCase(); }).filter(Boolean);
  const hit=words.find(function(w){ return new RegExp('(^|[^a-z0-9])'+cloudAgEsc(w)+'([^a-z0-9]|$)').test(low); });
  if(hit)return 'it mentions “'+hit+'”, one of your private words';
  if(/(^|[^0-9])(\d[ -]?){12,18}\d([^0-9]|$)/.test(text))return 'it has a card number in it';
  if(/(^|[^0-9])\d{3}-\d{2}-\d{4}([^0-9]|$)/.test(text))return 'it has an ID number in it';
  if(CLOUD_AG_MONEY.test(text))return 'it’s about your own money';
  if(CLOUD_AG_MAIL.test(text))return 'it needs your email';
  return '';
}
/* the task as it goes to the server: only what it needs (no ids, links to photos, AI notes beyond the conversation) */
function cloudAgTask(t){
  const hist=(Array.isArray(t.history)?t.history:[]).filter(function(h){ return h&&(h.who==='you'||h.who==='claude')&&h.text; }).slice(-20)
    .map(function(h){ return {who:h.who==='you'?'you':'assistant',text:String(h.text).slice(0,3000)}; });
  return {title:String(t.title||'').slice(0,500),notes:String(t.notes||'').slice(0,4000),reply:String(t.reply||'').slice(0,3000),history:hist};
}
// is this task waiting with nobody on it, long enough to offer the cloud? (queued since queuedAt)
function cloudAgDue(t,now,workerUp){
  if(!t||t.done||t.status!=='queued')return false;
  if(t.waitUntil&&t.waitUntil>now)return false; // out of usage on a computer that has it: it runs then
  const since=Number(t.updatedAt||t.created||0);
  return now-since>=(workerUp?CLOUD_AG_WORKER_WAIT_MS:CLOUD_AG_WAIT_MS);
}
// tried once on this round of the conversation (it failed or the allowance ran out): not again until they reply
function cloudAgTriedThisRound(t){ return t.cloudTried!=null&&t.cloudTried===(Array.isArray(t.history)?t.history.length:0); }

/* sealing: the device makes a one-time P-256 key pair, sends the public half, keeps the private half until the
   answer comes; the server derives the same AES-GCM key from its own one-time pair (index.ts seal) */
function cloudAgCrypto(){ return (typeof crypto!=='undefined'&&crypto.subtle)?crypto:require('crypto').webcrypto; }
async function cloudAgKeyPair(){
  const c=cloudAgCrypto();
  const k=await c.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveKey']);
  const pub=await c.subtle.exportKey('jwk',k.publicKey), priv=await c.subtle.exportKey('jwk',k.privateKey);
  return {pub:{kty:pub.kty,crv:pub.crv,x:pub.x,y:pub.y},priv:priv};
}
function cloudAgB64(u){ let s=''; for(let i=0;i<u.length;i++)s+=String.fromCharCode(u[i]); return typeof btoa==='function'?btoa(s):Buffer.from(s,'binary').toString('base64'); }
function cloudAgUnB64(s){ const b=typeof atob==='function'?atob(s):Buffer.from(s,'base64').toString('binary'); const u=new Uint8Array(b.length); for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i); return u; }
// the server's way, here too, so a test can seal and open (the server's copy is supabase/functions/cloud-agent/index.ts)
async function cloudAgSeal(pub,data){
  const c=cloudAgCrypto();
  const theirs=await c.subtle.importKey('jwk',pub,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const mine=await c.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveKey']);
  const key=await c.subtle.deriveKey({name:'ECDH',public:theirs},mine.privateKey,{name:'AES-GCM',length:256},false,['encrypt']);
  const iv=c.getRandomValues(new Uint8Array(12));
  const ct=new Uint8Array(await c.subtle.encrypt({name:'AES-GCM',iv:iv},key,new TextEncoder().encode(JSON.stringify(data))));
  const epk=await c.subtle.exportKey('jwk',mine.publicKey);
  return {v:1,epk:{kty:epk.kty,crv:epk.crv,x:epk.x,y:epk.y},iv:cloudAgB64(iv),ct:cloudAgB64(ct)};
}
async function cloudAgOpen(priv,sealed){
  const c=cloudAgCrypto();
  const mine=await c.subtle.importKey('jwk',priv,{name:'ECDH',namedCurve:'P-256'},false,['deriveKey']);
  const theirs=await c.subtle.importKey('jwk',sealed.epk,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const key=await c.subtle.deriveKey({name:'ECDH',public:theirs},mine,{name:'AES-GCM',length:256},false,['decrypt']);
  const pt=await c.subtle.decrypt({name:'AES-GCM',iv:cloudAgUnB64(sealed.iv)},key,cloudAgUnB64(sealed.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
// the server's answer → the result agentApplyResult takes (agent-results.js), or null when it isn't one
function cloudAgResult(id,a){
  if(!a||typeof a.note!=='string'||!a.note.trim())return null;
  const options=(Array.isArray(a.options)?a.options:[]).slice(0,6).map(function(o){
    return {label:String(o&&o.label||'').slice(0,80),desc:String(o&&o.desc||'').slice(0,200),url:/^https:\/\//i.test(String(o&&o.url||''))?String(o.url):undefined};
  }).filter(function(o){ return o.label; });
  return {id:id,status:a.status==='done'?'done':'needs-you',note:a.note.slice(0,6000),options:options,lane:'claude',via:'claude',model:CLOUD_AG_NAME};
}
// why the server said no → what the task says
function cloudAgWhyText(why,r){
  if(why==='limit')return 'You’ve used this month’s '+((r&&r.limit)||'')+' Romulus cloud tasks. It waits for your computer, or a paid plan (Settings, Device sync) gives you more.';
  if(why==='spend')return 'Romulus cloud has done as much as your plan covers this month. It waits for your computer.';
  if(why==='server'||why==='ip')return 'Romulus cloud is full right now. It waits for your computer; try again tomorrow.';
  if(why==='off')return 'Romulus cloud isn’t switched on yet. It waits for your computer.';
  if(why==='no_account')return 'Romulus cloud works with lists that sync on the Romulus server. It waits for your computer.';
  return 'Romulus cloud couldn’t take it. It waits for your computer.';
}

if(typeof module!=='undefined'&&module.exports)module.exports={cloudAgWhyNot,cloudAgTask,cloudAgDue,cloudAgTriedThisRound,cloudAgKeyPair,cloudAgSeal,cloudAgOpen,cloudAgResult,cloudAgWhyText,CLOUD_AG_WAIT_MS,CLOUD_AG_WORKER_WAIT_MS};

if(typeof document!=='undefined'){
  const cloudAgUI={privateWords:null,privateAt:0,workerUp:false,workerAt:0,status:null,statusAt:0,busy:{},timer:null};

  /* where it goes: this device has no runner of its own, and its Agent list syncs on the Romulus server */
  function cloudAgProfile(){
    if(window.desktop&&window.desktop.agentRetry)return null; // a computer with Romulus runs its own tasks
    const a=syncState&&syncState.cfg&&syncState.cfg.agent;
    if(!validProfile(a)||typeof hostedIs!=='function'||!hostedIs(a.url))return null;
    return a;
  }
  function cloudAgPref(){ try{ return localStorage.getItem(CLOUD_AG_PREF)||''; }catch(e){ return ''; } }
  function cloudAgSetPref(v){ try{ if(v)localStorage.setItem(CLOUD_AG_PREF,v); else localStorage.removeItem(CLOUD_AG_PREF); }catch(e){} }
  function cloudAgJobs(){ try{ const j=JSON.parse(localStorage.getItem(CLOUD_AG_JOBS)||'[]'); return Array.isArray(j)?j:[]; }catch(e){ return []; } }
  function cloudAgSaveJobs(j){ try{ localStorage.setItem(CLOUD_AG_JOBS,JSON.stringify(j)); }catch(e){} }

  async function cloudAgCall(p,body){
    const res=await fetch(p.url.replace(/\/+$/,'')+'/functions/v1/cloud-agent',{method:'POST',headers:syncHeaders(p),body:JSON.stringify(body)});
    if(!res.ok)throw new Error('HTTP '+res.status);
    return res.json();
  }
  // their private words and whether a mini PC is on, read now and then (both are rows next to the Agent list)
  async function cloudAgRefresh(p){
    const now=Date.now();
    if(now-cloudAgUI.privateAt>10*60*1000){
      cloudAgUI.privateAt=now;
      try{ const r=await syncPullRow(Object.assign({},p,{syncKey:p.syncKey+':routing'})); const d=r&&r.doc;
        cloudAgUI.privateWords=d&&typeof d.private==='string'?d.private:CLOUD_AG_PRIVATE; }catch(e){ if(cloudAgUI.privateWords==null)cloudAgUI.privateWords=CLOUD_AG_PRIVATE; }
    }
    if(now-cloudAgUI.workerAt>2*60*1000){
      cloudAgUI.workerAt=now;
      try{ const r=await syncPullRow(Object.assign({},p,{syncKey:p.syncKey+':worker'})); const d=r&&r.doc;
        cloudAgUI.workerUp=!!(d&&d.at&&now-Number(d.at)<6*60*1000); }catch(e){}
    }
  }
  function cloudAgEligible(t){ return !cloudAgWhyNot(t,cloudAgUI.privateWords)&&!cloudAgTriedThisRound(t); }

  async function cloudAgSend(t){
    const p=cloudAgProfile(); if(!p||cloudAgUI.busy[t.id])return;
    cloudAgUI.busy[t.id]=true;
    try{
      let prefs='';
      try{ const pp=typeof prefsProfile==='function'&&prefsProfile(); if(pp){ const r=await syncPullRow(pp); prefs=(r&&r.doc&&r.doc.text)||''; } }catch(e){}
      const keys=await cloudAgKeyPair();
      const today=new Date().toLocaleString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
      const r=await cloudAgCall(p,{action:'start',syncKey:await syncRowKey(p),pub:keys.pub,task:cloudAgTask(t),prefs:prefs,today:today});
      const cur=state.tasks.find(function(x){ return x.id===t.id; });
      if(!cur||cur.done||cur.status!=='queued')return; // a computer took it meanwhile: the answer, if any, is dropped
      if(!r||!r.ok){
        cur.cloudTried=(cur.history||[]).length; agentSay(cur,'sys',cloudAgWhyText(r&&r.why,r)); touch(); return;
      }
      const jobs=cloudAgJobs(); jobs.push({job:r.job,id:t.id,priv:keys.priv,at:Date.now()}); cloudAgSaveJobs(jobs);
      cur.status='working'; cur.lane='claude'; cur.claimedBy=CLOUD_AG_NAME; cur.claimedAt=Date.now(); cur.runFrom=Date.now(); delete cur.cloud;
      agentSay(cur,'sys','Sent to '+CLOUD_AG_NAME+(r.limit?' ('+r.used+' of '+r.limit+' this month)':'')+'. Usually a minute or two.');
      cloudAgUI.status=null; touch(); cloudAgTick();
    }catch(e){ voiceToast('Couldn’t reach Romulus cloud: '+(e&&e.message||e),true); }
    finally{ delete cloudAgUI.busy[t.id]; }
  }
  // collect finished answers for this device
  async function cloudAgCollect(p){
    const jobs=cloudAgJobs(); if(!jobs.length)return;
    const keep=[]; let changed=false; const key=await syncRowKey(p);
    for(const j of jobs){
      let r; try{ r=await cloudAgCall(p,{action:'take',syncKey:key,job:j.job}); }catch(e){ keep.push(j); continue; }
      if(r.state==='working'){ keep.push(j); continue; }
      const t=state.tasks.find(function(x){ return x.id===j.id; });
      const waiting=t&&!t.done&&t.status==='working'&&t.claimedBy===CLOUD_AG_NAME;
      if(r.state==='done'&&r.sealed&&waiting){
        let res=null; try{ res=cloudAgResult(t.id,await cloudAgOpen(j.priv,r.sealed)); }catch(e){}
        if(res){ agentApplyResult(res); delete t.claimedBy; delete t.claimedAt; changed=true; continue; }
      }
      if(waiting){ // failed, lost, or couldn't be opened: back in the queue for a computer
        t.status='queued'; delete t.claimedBy; delete t.claimedAt; delete t.runFrom; t.cloudTried=(t.history||[]).length;
        agentSay(t,'sys',CLOUD_AG_NAME+' couldn’t answer: '+String(r.why||'it couldn’t be opened on this device')+' It waits for your computer.');
        changed=true;
      }
    }
    cloudAgSaveJobs(keep);
    if(changed)touch();
  }
  /* every few seconds while the app is open: collect answers, and offer or send waiting tasks */
  async function cloudAgTick(){
    clearTimeout(cloudAgUI.timer);
    const p=cloudAgProfile();
    if(p&&!document.hidden){
      try{ await cloudAgRefresh(p); await cloudAgCollect(p); }catch(e){}
      const now=Date.now(), pref=cloudAgPref();
      if(pref!=='never'){
        const due=state.tasks.filter(function(t){ return taskWs(t)==='agent'&&cloudAgDue(t,now,cloudAgUI.workerUp)&&cloudAgEligible(t); });
        if(pref==='always')due.forEach(function(t){ cloudAgSend(t); });
        else if(due.some(function(t){ return !cloudAgUI.shown||!cloudAgUI.shown[t.id]; })&&state.activeTab==='agent')render(); // the offer appears
      }
    }
    cloudAgUI.timer=setTimeout(cloudAgTick,cloudAgJobs().length?8000:15000);
  }
  document.addEventListener('visibilitychange',function(){ if(!document.hidden)cloudAgTick(); });

  /* the offer, inside a waiting task's status box (lists.js) */
  function cloudAgOffer(t,box){
    const p=cloudAgProfile(); if(!p||cloudAgPref()!=='')return;
    if(!cloudAgDue(t,Date.now(),cloudAgUI.workerUp)||!cloudAgEligible(t))return;
    cloudAgUI.shown=cloudAgUI.shown||{}; cloudAgUI.shown[t.id]=true;
    const o=el('div','cloud-offer');
    o.appendChild(el('b',null,'None of your computers has picked this up'));
    o.appendChild(el('p',null,'Romulus cloud can answer it now, with web search. The AI and the Romulus server see this one task and your notes about yourself; your lists stay encrypted, and nothing private is sent. Your plan includes a number of these each month.'));
    const row=el('div','cloud-offer-row');
    const add=function(label,cls,fn){ const b=el('button',cls,label); b.addEventListener('click',function(e){ e.stopPropagation(); fn(); }); row.appendChild(b); };
    add('Always use it','btn-accent',function(){ cloudAgSetPref('always'); cloudAgSend(t); });
    add('Just this once','ghost',function(){ cloudAgSend(t); });
    add('No thanks','ghost',function(){ cloudAgSetPref('never'); render(); voiceToast('Tasks will wait for your computer. Settings, Agent changes this.'); });
    o.appendChild(row);
    box.appendChild(o);
  }
  window.cloudAgOffer=cloudAgOffer;

  /* Settings → Agent: the choice, and this month's use */
  async function cloudAgDraw(){
    const sec=$('cloudAgSection'); if(!sec)return;
    const p=cloudAgProfile();
    if(!p){ sec.hidden=true; return; }
    sec.hidden=false; sec.innerHTML='';
    sec.appendChild(el('h3','settings-subhead',CLOUD_AG_NAME));
    sec.appendChild(el('p','settings-hint','When none of your computers is on, Romulus cloud can answer Agent tasks with web search. Only the task and your notes about yourself go; your lists stay encrypted, and Finance, photos and tasks with private words never go. It can’t shop, send or sign in for you.'));
    const sel=document.createElement('select');
    [['','Ask each time'],['always','Always, when no computer is on'],['never','Never: wait for my computer']].forEach(function(o){ const x=document.createElement('option'); x.value=o[0]; x.textContent=o[1]; sel.appendChild(x); });
    sel.value=cloudAgPref();
    sel.addEventListener('change',function(){ cloudAgSetPref(sel.value); cloudAgTick(); });
    const row=el('div','settings-row'); row.appendChild(sel); sec.appendChild(row);
    const use=el('p','settings-hint',''); sec.appendChild(use);
    try{
      if(!cloudAgUI.status||Date.now()-cloudAgUI.statusAt>60*1000){ cloudAgUI.status=await cloudAgCall(p,{action:'status',syncKey:await syncRowKey(p)}); cloudAgUI.statusAt=Date.now(); }
      const s=cloudAgUI.status;
      use.textContent=!s.enabled?'Romulus cloud isn’t switched on yet.':s.used+' of '+s.limit+' cloud tasks used this month'+(s.plan==='free'?' (free plan)':'')+'.';
    }catch(e){ use.textContent=''; }
  }
  window.cloudAgDraw=cloudAgDraw;
  window.addEventListener('DOMContentLoaded',function(){ cloudAgDraw(); setTimeout(cloudAgTick,3000); });
  if(document.readyState!=='loading'){ cloudAgDraw(); setTimeout(cloudAgTick,3000); }
}
