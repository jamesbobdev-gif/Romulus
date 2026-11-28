/* Romulus cloud: an Agent task answered on the Romulus server when none of the person's own computers is on to
   take it, so the Agent works with nothing set up. Only on a device with no Agent runner of its own (a phone, or
   the app in a browser) whose lists sync on the Romulus server (hosted-sync.js), and only after they say yes:
   the first time, the waiting task asks "Always / Just this once / No thanks" (Settings → Agent changes it).
   - What goes: this one task (title, notes, their conversation on it) and their "What Claude knows about you"
     notes, minus any line with a private word or a card or ID number. The app doesn't send Finance, the Locked
     profile, photos, or a task with private words, a card or ID number in it. The account goes as a hash
     (cloudAgAccount), never a sync key. The one-time private key can't be exported (IndexedDB, cloudAgIdb).
   - The server (supabase/functions/cloud-agent) asks the AI with web search, then keeps the answer sealed with a
     one-time key made here, so only this device can open it; it's deleted once picked up. The task itself is
     never stored there.
   - Each account has a monthly allowance (free / paid plan); past it, tasks wait for a computer as before.
   Scheduled runs (cloudSched*, further down): a repeating task can also run on the server when every device is
   off. That is the one case where a copy of a task is kept there, so it is its own switch on the task, on any
   device whose lists sync on the Romulus server (a computer too), for paid plans.
   - The copy is sealed to a key only the cloud-agent function has; the answer is sealed to a key pair made for
     that task, whose private half stays on the task (t.cloudRun), inside the person's own encrypted list.
   - A device that is on runs the round itself and moves the time on; the server only runs one that is late.
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
/* → what makes this text private (plain words), or '': one of their private words, a card number or an ID number */
function cloudAgPrivateIn(text,privateWords){
  const low=String(text||'').toLowerCase();
  const words=String(privateWords==null?CLOUD_AG_PRIVATE:privateWords).split(',').map(function(w){ return w.trim().toLowerCase(); }).filter(Boolean);
  const hit=words.find(function(w){ return new RegExp('(^|[^a-z0-9])'+cloudAgEsc(w)+'([^a-z0-9]|$)').test(low); });
  if(hit)return 'it mentions “'+hit+'”, one of your private words';
  if(/(^|[^0-9])(\d[ -]?){12,18}\d([^0-9]|$)/.test(low))return 'it has a card number in it';
  if(/(^|[^0-9])\d{3}-\d{2}-\d{4}([^0-9]|$)/.test(low))return 'it has an ID number in it';
  return '';
}
/* → why this task stays off Romulus cloud (plain words), or '' when it may go. privateWords: their routing list */
function cloudAgWhyNot(t,privateWords){
  if(!t||t.done)return 'finished';
  if(t.lane==='local')return 'it’s set to your own model';
  if(t.financeSeen)return 'it’s about your finances';
  if(t.cart||t.list)return 'it shops in your store accounts';
  if(t.replyImages&&t.replyImages.length)return 'it has photos';
  const text=cloudAgTheirText(t);
  const priv=cloudAgPrivateIn(text,privateWords);
  if(priv)return priv;
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
/* their "What Claude knows about you" notes as they go with a cloud task: a line with a private word, a card number
   or an ID number is left out (headings stay, so the rest still reads in context) */
function cloudAgPrefs(text,privateWords){
  return String(text||'').split('\n').filter(function(l){ return /^\s*#/.test(l)||!cloudAgPrivateIn(l,privateWords); }).join('\n').slice(0,6000);
}
/* What his computers learned (agent/learned-sync.js keeps it in the agent list's ':learned' row), for a task
   going to the cloud: the one or two how-tos closest to it and the tips about the sites it links to, as a few
   lines of text. Picked the way agent/howtos.js forTask and agent/site-notes.js forUrls pick them on a computer
   (test/cloud-agent.test.js holds the two to the same answer). Never a how-to from a private task (h.priv), and
   never a line with one of his private words in it. */
const CLOUD_AG_STOP=('a an the my me i you your our for of on in at to from up out into onto through about and or but '+
  'is are be it this that what which who with please can could should would will just also some any all '+
  'look find get check see go use do make help try want need have has had new next last one '+
  'what\'s whats im i\'m it\'s due today tomorrow week local claude').split(' ');
function cloudAgKeyWords(text){
  const out=[];
  (String(text||'').toLowerCase().replace(/#\S+/g,' ').match(/[a-z0-9$][a-z0-9$'+]{2,}/g)||[]).forEach(function(w){
    w=w.replace(/'s$/,'').replace(/(?<=[a-z]{3})s$/,'');
    if(CLOUD_AG_STOP.indexOf(w)<0&&out.indexOf(w)<0)out.push(w);
  });
  return out;
}
function cloudAgHost(u){ const m=/^https?:\/\/([^\/?#:\s]+)/i.exec(String(u||'')); return m?m[1].toLowerCase().replace(/^www\./,''):''; }
function cloudAgLearned(doc,t,privateWords){
  if(!doc||typeof doc!=='object')return '';
  const mine=cloudAgTheirText(t), words=cloudAgKeyWords(String(t.title||'')+'\n'+String(t.notes||'')+'\n'+String(t.reply||''));
  const hosts=[]; (mine.match(/https?:\/\/[^\s"'<>)\\]+/g)||[]).forEach(function(u){ const h=cloudAgHost(u); if(h&&hosts.indexOf(h)<0)hosts.push(h); });
  const covers=function(domain,host){ return host===domain||host.slice(-domain.length-1)==='.'+domain; };
  const clean=function(s){ return typeof s==='string'&&!cloudAgPrivateIn(s,privateWords); };
  const lines=[];
  (Array.isArray(doc.howtos)?doc.howtos:[]).filter(function(h){ return h&&!h.priv&&clean(h.text)&&clean(String(h.task||'')); }).map(function(h){
    const hw=Array.isArray(h.words)?h.words:[], hs=Array.isArray(h.sites)?h.sites:[];
    const shared=hw.filter(function(w){ return words.indexOf(w)>=0; }).length;
    const site=hs.some(function(s){ return hosts.some(function(x){ return covers(s,x)||covers(x,s); }); });
    const specific=hw.some(function(w){ return w.length>=8&&words.indexOf(w)>=0; });
    return {h:h,shared:shared,site:site,specific:specific,total:shared+(site?2:0)};
  }).filter(function(x){ return x.shared>=2||(x.shared>=1&&(x.site||x.specific)); })
    .sort(function(a,b){ return b.total-a.total||String(b.h.date).localeCompare(String(a.h.date)); }).slice(0,2)
    .forEach(function(x){ lines.push('- For "'+String(x.h.task||'').slice(0,120)+'" ('+x.h.date+'): '+String(x.h.text).slice(0,400)); });
  const tips=doc.tips&&typeof doc.tips==='object'?doc.tips:{};
  Object.keys(tips).sort().filter(function(d){ return hosts.some(function(h){ return covers(d,h); }); }).slice(0,3).forEach(function(d){
    const l=(Array.isArray(tips[d])?tips[d]:[]).filter(clean).slice(-5);
    if(l.length)lines.push('Tips about '+d+' from earlier runs (unchecked: may be wrong):\n'+l.join('\n'));
  });
  return lines.join('\n').slice(0,2500);
}
/* the account the server should count this task against, without sending any sync key: 'tk_acct_' + the same
   SHA-256 of the key's id part that sync_account_of makes (supabase/setup.sql), from the row key this device syncs under */
async function cloudAgAccount(rowKey){
  const id=String(rowKey||'').replace(/^tk_(work_|agent_|school_)?([^:]+)(:.*)?$/,'$2');
  const d=await cloudAgCrypto().subtle.digest('SHA-256',new TextEncoder().encode(id));
  return 'tk_acct_'+Array.from(new Uint8Array(d),function(b){ return b.toString(16).padStart(2,'0'); }).join('');
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
/* → {pub (JWK, to send), priv}. With locked: true the private half is a CryptoKey that can't be exported, so a script
   running in the page could use it while the app is open but never copy it out (it is stored as is, in IndexedDB);
   otherwise a JWK (tests, and devices without IndexedDB) */
async function cloudAgKeyPair(locked){
  const c=cloudAgCrypto();
  const k=await c.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},!locked,['deriveKey']);
  const pub=await c.subtle.exportKey('jwk',k.publicKey); // the public half is always exportable
  return {pub:{kty:pub.kty,crv:pub.crv,x:pub.x,y:pub.y},priv:locked?k.privateKey:await c.subtle.exportKey('jwk',k.privateKey)};
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
// priv: the CryptoKey kept in IndexedDB, or a JWK
async function cloudAgOpen(priv,sealed){
  const c=cloudAgCrypto();
  const mine=priv&&priv.type==='private'&&priv.algorithm?priv:await c.subtle.importKey('jwk',priv,{name:'ECDH',namedCurve:'P-256'},false,['deriveKey']);
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
  if(why==='new_account')return 'New accounts get a few Romulus cloud tasks on their first day, and the full allowance from the next. It waits for your computer until then.';
  if(why==='busy')return 'Romulus cloud is still on your other tasks. This one starts when one of them finishes.';
  return 'Romulus cloud couldn’t take it. It waits for your computer.';
}

/* ── scheduled runs: a repeating task on the server while every device is off ── */
const CLOUD_SCHED_REFRESH_MS=5*24*3600*1000; // sent again this often even unchanged: the server drops one no device has refreshed in 14 days
/* → why this task can't be scheduled on the server (plain words), or '' */
function cloudSchedWhyNot(t,privateWords){
  if(!t||!t.repeat||!t.repeat.every)return 'it doesn’t repeat';
  return cloudAgWhyNot(Object.assign({},t,{done:false}),privateWords); // a repeating task is "finished" between rounds
}
// the task as the server knows it: a hash of its id, never the id
async function cloudSchedId(id){
  const d=await cloudAgCrypto().subtle.digest('SHA-256',new TextEncoder().encode('romulus-sched|'+String(id)));
  return Array.from(new Uint8Array(d).slice(0,20),function(b){ return b.toString(16).padStart(2,'0'); }).join('');
}
// what the server needs to run a round: fewer and shorter turns than a live task sends, since it is kept
function cloudSchedTask(t){
  const c=cloudAgTask(t);
  return {title:c.title,notes:c.notes,reply:'',history:c.history.slice(-8).map(function(h){ return {who:h.who,text:h.text.slice(0,1500)}; })};
}
function cloudSchedRule(t,tz){ return {every:t.repeat.every,at:t.repeat.at||'08:00',day:t.repeat.day!=null?t.repeat.day:null,tz:tz||'UTC'}; }
/* a short mark of everything a stored copy depends on: when it differs from the one last sent (t.cloudRun.sent),
   the copy on the server is out of date. It lives on the task, so every device sees what was sent. */
function cloudSchedPrint(t,tz){
  const h=(Array.isArray(t.history)?t.history:[]).filter(function(x){ return x&&(x.who==='you'||x.who==='claude'); });
  const s=JSON.stringify([t.title||'',t.notes||'',cloudSchedRule(t,tz),t.nextRun||0,h.length,h.length?h[h.length-1].at||0:0]);
  let n=0x811c9dc5; for(let i=0;i<s.length;i++){ n^=s.charCodeAt(i); n=Math.imul(n,0x01000193)>>>0; }
  return n.toString(16)+'.'+s.length;
}
/* what to do about the scheduled tasks now → {put: tasks to send (again), drop: tasks to take back, clear: tasks
   whose switch is off and that the server no longer has} */
function cloudSchedPlan(tasks,privateWords,now,tz){
  const put=[],drop=[],clear=[];
  (tasks||[]).forEach(function(t){
    const c=t&&t.cloudRun; if(!c||typeof c!=='object')return;
    if(c.on&&!cloudSchedWhyNot(t,privateWords)){
      if(c.sent!==cloudSchedPrint(t,tz)||now-(Number(c.at)||0)>CLOUD_SCHED_REFRESH_MS)put.push(t);
    }
    else if(c.sent)drop.push(t); // switched off, no longer repeats, or it turned private: the server's copy goes
    else if(!c.on)clear.push(t);
  });
  return {put:put,drop:drop,clear:clear};
}
// why the server didn't run a round, or wouldn't keep the task → what the task says
function cloudSchedWhyText(why,r){
  if(why==='plan')return 'Running a repeating task while all your devices are off comes with a paid plan (Settings, Device sync). It runs when one of your devices is on, as before.';
  if(why==='limit'&&r&&r.limit)return 'Your plan keeps up to '+r.limit+' repeating tasks on Romulus cloud. Switch one off to add this one.';
  if(why==='limit'||why==='spend'||why==='new_account')return 'This month’s Romulus cloud allowance is used up, so this round didn’t run while your devices were off. It starts again by itself in the new month, and runs on your own devices meanwhile.';
  if(why==='off'||why==='no_account')return 'Romulus cloud can’t keep repeating tasks for this account yet. It runs when one of your devices is on, as before.';
  return 'Romulus cloud couldn’t run this round while your devices were off: '+String(why||'no reason given').slice(0,300);
}

// said under every Romulus cloud answer that has links: a web page could have planted one
const CLOUD_AG_LINK_NOTE='Answered by Romulus cloud with web search. Its links come from the web and aren’t checked: look at the address before you sign in or pay anywhere.';

if(typeof module!=='undefined'&&module.exports)module.exports={cloudAgLearned,cloudAgKeyWords,cloudSchedWhyNot,cloudSchedId,cloudSchedTask,cloudSchedRule,cloudSchedPrint,cloudSchedPlan,cloudSchedWhyText,CLOUD_SCHED_REFRESH_MS,cloudAgPrivateIn,cloudAgPrefs,cloudAgAccount,CLOUD_AG_LINK_NOTE,cloudAgWhyNot,cloudAgTask,cloudAgDue,cloudAgTriedThisRound,cloudAgKeyPair,cloudAgSeal,cloudAgOpen,cloudAgResult,cloudAgWhyText,CLOUD_AG_WAIT_MS,CLOUD_AG_WORKER_WAIT_MS};

if(typeof document!=='undefined'){
  // the ':learned' row, read at most every ten minutes; '' when there is none or it can't be read
  const cloudAgLearnedSeen={at:0,doc:null};
  async function cloudAgLearnedFor(t){
    try{
      if(Date.now()-cloudAgLearnedSeen.at>10*60*1000){
        const a=typeof syncState!=='undefined'&&syncState.cfg&&syncState.cfg.agent;
        if(!a||!validProfile(a))return '';
        const r=await syncPullRow({url:a.url,key:a.key,syncKey:a.syncKey+':learned',v2:a.v2});
        cloudAgLearnedSeen.at=Date.now(); cloudAgLearnedSeen.doc=(r&&r.doc)||null;
      }
      return cloudAgLearned(cloudAgLearnedSeen.doc,t,cloudAgUI.privateWords);
    }catch(e){ return ''; }
  }
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

  /* the one-time private keys, as CryptoKeys that can't be exported, in IndexedDB (job → key). Unavailable (an old
     web view, private mode): null, and the key goes in the job list as a JWK the way it did before */
  let cloudAgDb=null;
  function cloudAgIdb(){
    if(cloudAgDb)return cloudAgDb;
    cloudAgDb=new Promise(function(ok){
      try{
        const r=indexedDB.open('romulus-cloud',1);
        r.onupgradeneeded=function(){ r.result.createObjectStore('keys'); };
        r.onsuccess=function(){ ok(r.result); }; r.onerror=function(){ ok(null); };
      }catch(e){ ok(null); }
    });
    return cloudAgDb;
  }
  async function cloudAgKeyDo(mode,job,val){
    const db=await cloudAgIdb(); if(!db)return mode==='put'?false:null;
    return new Promise(function(ok){
      try{
        const tx=db.transaction('keys',mode==='get'?'readonly':'readwrite'), st=tx.objectStore('keys');
        const q=mode==='put'?st.put(val,job):mode==='get'?st.get(job):st.delete(job);
        q.onsuccess=function(){ ok(mode==='put'?true:q.result||null); }; q.onerror=function(){ ok(mode==='put'?false:null); };
      }catch(e){ ok(mode==='put'?false:null); }
    });
  }
  // what the server knows this account by, with no sync key in it (cloudAgAccount)
  async function cloudAgId(p){ return cloudAgAccount(await syncRowKey(p)); }

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
      try{ const pp=typeof prefsProfile==='function'&&prefsProfile(); if(pp){ const r=await syncPullRow(pp); prefs=cloudAgPrefs((r&&r.doc&&r.doc.text)||'',cloudAgUI.privateWords); } }catch(e){}
      let keys; try{ keys=await cloudAgKeyPair(!!(await cloudAgIdb())); }catch(e){ keys=await cloudAgKeyPair(false); }
      const today=new Date().toLocaleString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
      const r=await cloudAgCall(p,{action:'start',syncKey:await cloudAgId(p),pub:keys.pub,task:cloudAgTask(t),prefs:prefs,learned:await cloudAgLearnedFor(t),today:today});
      const cur=state.tasks.find(function(x){ return x.id===t.id; });
      if(!cur||cur.done||cur.status!=='queued')return; // a computer took it meanwhile: the answer, if any, is dropped
      if(r&&r.why==='busy')return; // two of theirs are being answered: this one goes on a later tick, no note
      if(!r||!r.ok){
        cur.cloudTried=(cur.history||[]).length; agentSay(cur,'sys',cloudAgWhyText(r&&r.why,r)); touch(); return;
      }
      // the private half stays in IndexedDB as an unexportable key; only without IndexedDB does a JWK go in the list
      const kept=keys.priv&&keys.priv.type==='private'&&await cloudAgKeyDo('put',r.job,keys.priv);
      const jobs=cloudAgJobs(); jobs.push(Object.assign({job:r.job,id:t.id,at:Date.now()},kept?{}:{priv:keys.priv})); cloudAgSaveJobs(jobs);
      cur.status='working'; cur.lane='claude'; cur.claimedBy=CLOUD_AG_NAME; cur.claimedAt=Date.now(); cur.runFrom=Date.now(); delete cur.cloud;
      agentSay(cur,'sys','Sent to '+CLOUD_AG_NAME+(r.limit?' ('+r.used+' of '+r.limit+' this month)':'')+'. Usually a minute or two.');
      cloudAgUI.status=null; touch(); cloudAgTick();
    }catch(e){ voiceToast('Couldn’t reach Romulus cloud: '+(e&&e.message||e),true); }
    finally{ delete cloudAgUI.busy[t.id]; }
  }
  // collect finished answers for this device
  async function cloudAgCollect(p){
    const jobs=cloudAgJobs(); if(!jobs.length)return;
    const keep=[]; let changed=false; const key=await cloudAgId(p);
    for(const j of jobs){
      let r; try{ r=await cloudAgCall(p,{action:'take',syncKey:key,job:j.job}); }catch(e){ keep.push(j); continue; }
      if(r.state==='working'){ keep.push(j); continue; }
      const t=state.tasks.find(function(x){ return x.id===j.id; });
      const waiting=t&&!t.done&&t.status==='working'&&t.claimedBy===CLOUD_AG_NAME;
      const priv=j.priv||await cloudAgKeyDo('get',j.job);
      cloudAgKeyDo('del',j.job); // handed over once: the key is no use any more
      if(r.state==='done'&&r.sealed&&waiting&&priv){
        let res=null; try{ res=cloudAgResult(t.id,await cloudAgOpen(priv,r.sealed)); }catch(e){}
        if(res){
          agentApplyResult(res); delete t.claimedBy; delete t.claimedAt;
          if(res.options&&res.options.some(function(o){ return o.url; }))agentSay(t,'sys',CLOUD_AG_LINK_NOTE);
          changed=true; continue;
        }
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
      if(!cloudAgUI.status||Date.now()-cloudAgUI.statusAt>60*1000){ cloudAgUI.status=await cloudAgCall(p,{action:'status',syncKey:await cloudAgId(p)}); cloudAgUI.statusAt=Date.now(); }
      const s=cloudAgUI.status;
      use.textContent=!s.enabled?'Romulus cloud isn’t switched on yet.':s.used+' of '+s.limit+' cloud tasks used this month'+(s.plan==='free'?' (free plan)':'')+'.';
    }catch(e){ use.textContent=''; }
  }
  window.cloudAgDraw=cloudAgDraw;

  /* ── scheduled runs (the pure part is above) ── */
  const cloudSchedUI={pub:null,pubAt:0,busy:false,timer:null};
  // any device whose Agent list syncs on the Romulus server, a computer included: whichever is open keeps the copy fresh
  function cloudSchedProfile(){
    const a=syncState&&syncState.cfg&&syncState.cfg.agent;
    if(!validProfile(a)||typeof hostedIs!=='function'||!hostedIs(a.url))return null;
    return a;
  }
  function cloudSchedTz(){ try{ return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'; }catch(e){ return 'UTC'; } }
  // the key a stored copy is sealed to (the function's own), or null when this server doesn't offer scheduled runs
  async function cloudSchedPub(p){
    if(Date.now()-cloudSchedUI.pubAt<10*60*1000)return cloudSchedUI.pub;
    cloudSchedUI.pubAt=Date.now();
    try{ const s=await cloudAgCall(p,{action:'status',syncKey:await cloudAgId(p)}); cloudSchedUI.pub=(s&&s.schedPub)||null; }catch(e){}
    return cloudSchedUI.pub;
  }
  // one task's copy to the server (new, or changed since the last one)
  async function cloudSchedSend(p,key,pub,t,prefs,tz){
    const c=t.cloudRun;
    if(!c.pub||!c.priv){ const k=await cloudAgKeyPair(false); c.pub=k.pub; c.priv=k.priv; } // stays on the task: any of their devices can open the answers
    const print=cloudSchedPrint(t,tz);
    const r=await cloudAgCall(p,{action:'schedule',syncKey:key,task:await cloudSchedId(t.id),next:t.nextRun||null,rule:cloudSchedRule(t,tz),
      sealed:await cloudAgSeal(pub,{task:cloudSchedTask(t),prefs:prefs,learned:await cloudAgLearnedFor(t)}),pub:c.pub});
    if(r&&r.ok){ c.sent=print; c.at=Date.now(); if(r.next&&(!t.nextRun||t.nextRun<Date.now()))t.nextRun=Date.parse(r.next)||t.nextRun; return; }
    c.on=false; c.sent=null; // it can't be kept there: the switch goes off and the task says why
    agentSay(t,'sys',cloudSchedWhyText(r&&r.why,r));
  }
  // what ran while every device was off, onto its tasks
  async function cloudSchedCollect(p,key,byId){
    const r=await cloudAgCall(p,{action:'results',syncKey:key});
    let changed=false;
    for(const x of (r&&Array.isArray(r.results)?r.results:[])){
      const t=byId[x.task]; if(!t||!t.cloudRun)continue;
      changed=true;
      if(x.next&&(!t.nextRun||t.nextRun<x.next))t.nextRun=x.next;
      let res=null;
      if(x.sealed&&t.cloudRun.priv){ try{ res=cloudAgResult(t.id,await cloudAgOpen(t.cloudRun.priv,x.sealed)); }catch(e){} }
      if(!res){ agentSay(t,'sys',cloudSchedWhyText(x.sealed?'its answer couldn’t be opened on this device':x.why)); continue; }
      const when=fmtWhen(x.ran||Date.now());
      if(!t.done&&(t.status==='working'||t.status==='queued')){
        // a round is going or waiting here already: the server's answer joins the conversation without taking it over
        agentSay(t,'sys','Romulus cloud also ran this '+when+', while your devices were off:');
        agentSay(t,'claude',res.note,{model:CLOUD_AG_NAME});
        continue;
      }
      t.done=false; t.status='working'; t.lane='claude'; delete t.cloud; t.runFrom=x.ran||Date.now(); t.reply=null;
      agentSay(t,'sys','Scheduled run ('+repeatText(t.repeat)+') on Romulus cloud '+when+', while your devices were off');
      agentApplyResult(res);
      if(res.options&&res.options.some(function(o){ return o.url; }))agentSay(t,'sys',CLOUD_AG_LINK_NOTE);
    }
    // a copy the server still has for a task that is gone here (deleted, or its switch came off on an older app): take it back
    for(const k of (r&&Array.isArray(r.kept)?r.kept:[])){
      if(!byId[k.task]||!byId[k.task].cloudRun||!byId[k.task].cloudRun.on){ try{ await cloudAgCall(p,{action:'unschedule',syncKey:key,task:k.task}); }catch(e){} }
    }
    return changed;
  }
  /* every few minutes while the app is open, and when it comes back: collect, then send what changed */
  async function cloudSchedTick(){
    clearTimeout(cloudSchedUI.timer);
    cloudSchedUI.timer=setTimeout(cloudSchedTick,5*60*1000);
    const p=cloudSchedProfile();
    const mine=state.tasks.filter(function(t){ return taskWs(t)==='agent'&&t.cloudRun; });
    if(!p||!mine.length||cloudSchedUI.busy)return; // nothing scheduled: the server is never asked
    cloudSchedUI.busy=true;
    try{
      await cloudAgRefresh(p);
      const key=await cloudAgId(p), tz=cloudSchedTz(), byId={};
      for(const t of mine)byId[await cloudSchedId(t.id)]=t;
      let changed=false;
      if(mine.some(function(t){ return t.cloudRun.sent; }))changed=await cloudSchedCollect(p,key,byId);
      const plan=cloudSchedPlan(mine,cloudAgUI.privateWords,Date.now(),tz);
      plan.clear.forEach(function(t){ delete t.cloudRun; changed=true; });
      for(const t of plan.drop){
        await cloudAgCall(p,{action:'unschedule',syncKey:key,task:await cloudSchedId(t.id)});
        if(t.cloudRun.on)t.cloudRun.sent=null; else delete t.cloudRun;
        changed=true;
      }
      if(plan.put.length){
        const pub=await cloudSchedPub(p);
        if(pub){
          let prefs='';
          try{ const pp=typeof prefsProfile==='function'&&prefsProfile(); if(pp){ const r=await syncPullRow(pp); prefs=cloudAgPrefs((r&&r.doc&&r.doc.text)||'',cloudAgUI.privateWords); } }catch(e){}
          for(const t of plan.put){ await cloudSchedSend(p,key,pub,t,prefs,tz); changed=true; }
        }
      }
      if(changed){ touch(); if(state.activeTab==='agent')render(); }
    }catch(e){} // no connection: the next tick tries again
    finally{ cloudSchedUI.busy=false; }
  }
  document.addEventListener('visibilitychange',function(){ if(!document.hidden)cloudSchedTick(); });

  /* the switch under a task's Repeat row (lists.js) */
  function cloudSchedRow(t,opts){
    const p=cloudSchedProfile(); if(!p||!t.repeat)return;
    if(!cloudSchedUI.pubAt){ cloudSchedPub(p).then(function(pub){ if(pub&&state.activeTab==='agent')render(); }); return; }
    if(!cloudSchedUI.pub&&!t.cloudRun)return; // this server doesn't offer it
    const row=el('div','panel-meta repeat-row cloud-sched-row');
    const lab=document.createElement('label');
    const box=document.createElement('input'); box.type='checkbox'; box.checked=!!(t.cloudRun&&t.cloudRun.on);
    const why=cloudSchedWhyNot(t,cloudAgUI.privateWords);
    box.disabled=!!why&&!box.checked;
    lab.appendChild(box); lab.appendChild(document.createTextNode(' Also run it when all my devices are off'));
    row.appendChild(lab);
    row.appendChild(el('span','next',why?'Not this one: '+why+'.'
      :box.checked?(t.cloudRun.sent?'On: Romulus cloud runs it if none of your devices has.':'Saving it on Romulus cloud…')
      :'Romulus cloud runs it then, with web search only. A copy of this task is kept on the Romulus server for that, locked so only the cloud Agent can open it. Paid plans.'));
    box.addEventListener('click',function(e){ e.stopPropagation(); });
    box.addEventListener('change',function(){
      t.cloudRun=Object.assign({},t.cloudRun,{on:box.checked});
      touch(); render(); cloudSchedTick();
    });
    opts.appendChild(row);
  }
  window.cloudSchedRow=cloudSchedRow;

  window.addEventListener('DOMContentLoaded',function(){ cloudAgDraw(); setTimeout(cloudAgTick,3000); setTimeout(cloudSchedTick,8000); });
  if(document.readyState!=='loading'){ cloudAgDraw(); setTimeout(cloudAgTick,3000); setTimeout(cloudSchedTick,8000); }
}
