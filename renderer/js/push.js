/* Phone notifications when the Agent needs you or has finished, with the answer typed right in the notification.
   Three jobs, all on the lists' own Supabase project:
   - The computer that ran a task sends the notification (supabase/functions/push hands it to Firebase).
   - The phone app registers its Firebase token and hands the Android side what it needs to show a
     notification and send a reply back while the app is closed (Push*.java, through the Push plugin).
   - Any device with the lists open takes the replies typed into notifications and puts them on their tasks,
     the same as a reply typed in the app. So a reply is acted on as soon as a computer that runs the Agent is on.
   The task's title and note, and a reply's words, are sealed on the device with a key made from the sync key
   (HKDF-SHA256, salt 'romulus-push-v1', then AES-256-GCM: {iv, ct} in base64, the tag at the end of ct), so the
   server and Firebase only carry ciphertext (supabase/migrations/20261125_push.sql). Push.java opens and seals
   the same way. The account is named by the lists' row key, never the sync key.
   A project without the push function or the migration answers 404: this then stays quiet until the next start.
   Loads after agent-results.js, so its answer is on the task before this looks at it. */
'use strict';

const PUSH_SALT='romulus-push-v1';
const PUSH_NOTE_MAX=600;

/* ── pure, for tests ── */
function pushLine(s,n){ return String(s==null?'':s).replace(/[*_`#>]+/g,'').replace(/\s+/g,' ').trim().slice(0,n); }
// what the phone shows: no history, no pictures, just which task and what it says now
function pushPayload(t){
  return {v:1,id:String(t.id),title:pushLine(t.title,120),note:pushLine(t.note,PUSH_NOTE_MAX),st:t.status==='done'?'done':'needs-you',at:Date.now()};
}
// an answer (u, from the run) that is now on the task (t): worth a notification?
function pushWants(t,u){
  if(!t||!u||u.handoff||t.ws!=='agent'||t.done||t.parked)return false;
  if(u.status!=='needs-you'&&u.status!=='done')return false;
  if(t.status!=='needs-you'&&t.status!=='done')return false;
  return (t.note||'')===(u.note||''); // the page took this answer (it drops one for a task he moved or finished)
}
// the task a reply from a notification goes on, or null (finished, deleted or moved meanwhile: the reply is dropped)
function pushReplyTarget(tasks,r){
  if(!r||typeof r.id!=='string'||!String(r.text||'').trim())return null;
  const t=(tasks||[]).find(function(x){ return x.id===r.id; });
  return t&&t.ws==='agent'&&!t.done?t:null;
}
// the reply goes on the task the way one typed under it does (lists.js): mid-run it stacks onto what he already sent
function pushReplyOnto(t,text,say){
  const busy=t.status==='working'||t.status==='queued';
  t.reply=(busy&&t.reply)?t.reply+'\n'+text:text;
  say(t,'you',text);
  if(t.status!=='working')t.status='queued';
  delete t.askSeen; delete t.parked;
}
// is there anything a reply could still come in for? (so an idle account isn't asked every half minute)
function pushAwaits(tasks,now){
  return (tasks||[]).some(function(t){
    return t.ws==='agent'&&!t.done&&(t.status==='needs-you'||t.status==='done')&&(!t.updatedAt||now-t.updatedAt<3*86400000);
  });
}

/* ── sealing ── */
function pushB64(bytes){ let s=''; bytes.forEach(function(b){ s+=String.fromCharCode(b); }); return btoa(s); }
function pushUnB64(s){ return Uint8Array.from(atob(String(s)),function(c){ return c.charCodeAt(0); }); }
// 32 bytes from the list's sync key (without a ':side' suffix). The phone keeps these, not the sync key, for its notifications.
async function pushKeyBytes(syncKeyBase){
  const enc=new TextEncoder();
  const raw=await crypto.subtle.importKey('raw',enc.encode(String(syncKeyBase)),'HKDF',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:enc.encode(PUSH_SALT),info:enc.encode('push')},raw,256));
}
async function pushAes(keyBytes){ return crypto.subtle.importKey('raw',keyBytes,{name:'AES-GCM'},false,['encrypt','decrypt']); }
async function pushSeal(keyBytes,obj){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv:iv},await pushAes(keyBytes),new TextEncoder().encode(JSON.stringify(obj)));
  return {iv:pushB64(iv),ct:pushB64(new Uint8Array(ct))};
}
async function pushOpen(keyBytes,env){
  const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:pushUnB64(env.iv)},await pushAes(keyBytes),pushUnB64(env.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

if(typeof module!=='undefined'&&module.exports)module.exports={pushLine,pushPayload,pushWants,pushReplyTarget,pushReplyOnto,pushAwaits,pushKeyBytes,pushSeal,pushOpen,PUSH_SALT};

/* ── the page ── */
if(typeof document!=='undefined'){
  const pushState={sendOffUntil:0,takeOff:false,sent:{},registered:false,taking:false};
  // the lists these notifications belong to: the personal ones (every device of the account has them)
  const pushProfile=function(){
    const c=typeof syncState!=='undefined'&&syncState.cfg, p=c&&(c.personal||c.agent);
    return p&&p.url&&p.key&&p.syncKey&&!syncKeyLocked(p)?p:null;
  };
  const pushAccount=async function(p){ return String(await syncRowKey(p)).replace(/:.*$/,''); };
  const pushKeyOf=function(p){ return pushKeyBytes(syncSplitKey(p.syncKey).base); };
  const pushNative=function(){
    const cap=window.Capacitor;
    if(!cap||typeof cap.nativePromise!=='function'||!cap.isPluginAvailable||!cap.isPluginAvailable('Push'))return null;
    return function(method,opts){ return cap.nativePromise('Push',method,opts||{}); };
  };

  // the computer that ran the task: tell the phones
  const pushSend=async function(t){
    const p=pushProfile(); if(!p||Date.now()<pushState.sendOffUntil)return;
    const body=pushPayload(t), k=body.st+'|'+body.note;
    if(pushState.sent[t.id]===k)return; // the same answer twice: one notification
    pushState.sent[t.id]=k;
    try{
      const env=await pushSeal(await pushKeyOf(p),body);
      const res=await fetch(p.url.replace(/\/+$/,'')+'/functions/v1/push',{method:'POST',headers:syncHeaders(p),body:JSON.stringify({account:await pushAccount(p),env:env}),signal:AbortSignal.timeout(20000)});
      // no push function here (404), or it has no Firebase key yet (503): quiet for an hour
      if(res.status===404||res.status===503)pushState.sendOffUntil=Date.now()+3600000;
    }catch(e){ delete pushState.sent[t.id]; }
  };
  if(window.desktop&&window.desktop.onAgentResults)window.desktop.onAgentResults(function(updates){
    setTimeout(function(){ // after agent-results.js has put the answers on their tasks
      (updates||[]).forEach(function(u){
        const t=state.tasks.find(function(x){ return x.id===u.id; });
        if(pushWants(t,u))pushSend(t);
      });
    },0);
  });

  // replies typed into a notification, onto their tasks
  const pushApply=function(list){
    let n=0;
    (list||[]).forEach(function(r){
      const t=pushReplyTarget(state.tasks,r); if(!t)return;
      pushReplyOnto(t,String(r.text).trim().slice(0,2000),agentSay); n++;
    });
    if(n)touch();
  };
  const pushTake=async function(){
    const p=pushProfile(); if(!p||pushState.takeOff||pushState.taking)return; // also while the window is in the tray: that is when a reply matters
    if(!pushAwaits(state.tasks,Date.now()))return;
    pushState.taking=true;
    try{
      const rows=await syncRpc(p,'push_reply_take',{p_row_key:await pushAccount(p)});
      if(Array.isArray(rows)&&rows.length){
        const key=await pushKeyOf(p), list=[];
        for(const env of rows){ try{ list.push(await pushOpen(key,env)); }catch(e){} } // sealed with another key: not ours to read
        pushApply(list);
      }
    }catch(e){ if(/HTTP 404/.test(String(e&&e.message)))pushState.takeOff=true; } // this project has no push tables
    finally{ pushState.taking=false; }
  };

  // the phone: its Firebase token to the server, and to the Android side what a closed app needs
  const pushRegister=async function(){
    const call=pushNative(), p=pushProfile();
    if(!call||!p||pushState.registered||typeof agentAvailable!=='function'||!agentAvailable())return;
    try{
      const account=await pushAccount(p);
      const r=await call('register',{key:pushB64(await pushKeyOf(p)),url:p.url.replace(/\/+$/,''),apikey:p.key,account:account});
      if(!r||!r.token)return; // this build has no Firebase project, or Google Play services are missing
      if(await syncRpc(p,'push_register',{p_row_key:account,p_token:r.token,p_platform:'android'})===true)pushState.registered=true;
    }catch(e){}
  };
  // replies the phone couldn't send (no connection when he typed them): put on their tasks here
  const pushTakeLocal=function(){
    const call=pushNative(); if(!call)return;
    call('takeReplies').then(function(r){ pushApply(r&&r.replies); }).catch(function(){});
  };

  const pushTick=function(){ pushRegister(); pushTakeLocal(); pushTake(); };
  document.addEventListener('visibilitychange',function(){ if(!document.hidden)pushTick(); });
  setTimeout(pushTick,6000); // once the first sync has had a moment (an account exists on the server after it)
  setInterval(pushTake,30000);
}
