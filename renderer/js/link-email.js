/* "Email me links": the links someone picks on an Agent task (Choose this, Print this, Send me link, the mail
   button) go to an address they confirmed, on any device, for everyone on the Romulus server. Settings → Device
   sync takes the address, mails it a 6-digit code (supabase/functions/buy-email, action 'start'), and the code
   typed back in confirms it ('confirm'). The server keeps the address with the account and only ever mails that
   one (supabase/migrations/20261118_link_email.sql), so nobody can use it to mail someone else.
   The account is named by the personal lists' row key (the lookup id they sync under), never the sync key.
   A pick on a device with a confirmed address is marked via:'hosted' and sent from here, so the desktop's own
   older path (main/buy-emails.js) leaves it alone. Loads after hosted-sync.js. */
'use strict';

const LINK_EMAIL_KEY='tasks.linkEmail'; // the confirmed address, remembered so a pick knows at once
const LINK_EMAIL_WHY={
  no_account:'sync hasn’t started on this device yet; try again in a minute',
  bad_email:'that doesn’t look like an email address',
  wait:'a code just went out; wait a minute before asking for another',
  too_many:'too many tries today; try again tomorrow',
  busy:'the server has sent all the email it can today; try again tomorrow',
  not_ready:'the Romulus server can’t email that address yet; it’s still being set up',
  wrong:'that code isn’t right',
  expired:'that code is over 15 minutes old; ask for a new one',
  no_code:'ask for a code first',
  no_email:'no email address is set: add one in Settings, Device sync',
};
// pure, for tests
function linkEmailValid(s){ s=String(s||'').trim(); return s.length<=254&&/^[^@\s<>",;]+@[^@\s<>",;]+\.[a-z]{2,}$/i.test(s); }
function linkEmailWhy(code,action){
  if(code==='too_many'&&action==='confirm')return 'too many wrong tries; ask for a new code';
  return LINK_EMAIL_WHY[code]||'that didn’t work; try again';
}
function linkEmailCodeClean(s){ return String(s||'').replace(/\D/g,'').slice(0,6); }
// what goes to the server for one pick (no task ids, no notes: just the link card)
function linkEmailSendBody(account,b){
  return {action:'send',account:account,kind:b.kind==='print'||b.kind==='link'?b.kind:'buy',label:b.label,url:b.url,price:b.price||null,rating:b.rating||null,image:b.image||null};
}

function linkEmailRemembered(){ try{ return localStorage.getItem(LINK_EMAIL_KEY)||''; }catch(e){ return ''; } }
function linkEmailRemember(email){ try{ if(email)localStorage.setItem(LINK_EMAIL_KEY,email); else localStorage.removeItem(LINK_EMAIL_KEY); }catch(e){} }
// the personal lists on the Romulus server, or null
function linkEmailProfile(){
  const c=typeof syncState!=='undefined'&&syncState.cfg, p=c&&c.personal;
  return p&&p.syncKey&&typeof hostedIs==='function'&&hostedIs(p.url)?p:null;
}
async function linkEmailCall(body){
  const h=hostedServer(), p=linkEmailProfile();
  if(!h||!p)throw new Error('turn on sync with the Romulus server first');
  body.account=String(await syncRowKey(p)).replace(/:.*$/,'');
  let res, out=null;
  try{ res=await fetch(hostedTrim(h.url)+'/functions/v1/buy-email',{method:'POST',headers:syncHeaders({key:h.key}),body:JSON.stringify(body),signal:AbortSignal.timeout(20000)}); }
  catch(e){ throw new Error('no connection; try again'); }
  try{ out=await res.json(); }catch(e){}
  if(!res.ok||!out||!out.ok)throw new Error(linkEmailWhy(out&&out.error,body.action));
  return out;
}

/* A pick (lists.js): with a confirmed address, send it from here. Without one, say where to add it. */
function linkEmailPick(t){
  const b=t&&t.buyEmail; if(!b||!b.url)return;
  if(!linkEmailProfile())return; // own Supabase or no sync: the desktop's own path, if it has one
  if(!linkEmailRemembered()){ agentSay(t,'sys','To get links by email, add your address in Settings, Device sync.'); return; }
  b.via='hosted';
  linkEmailCall(linkEmailSendBody(null,b)).then(function(){
    b.mailed=Date.now(); touch();
  },function(e){
    b.mailError=e.message; agentSay(t,'sys','The email didn’t go out: '+e.message+'.'); touch();
  });
}

if(typeof document!=='undefined'&&document.getElementById('linkEmailBox')){
  const box=$('linkEmailBox'), info=$('linkEmailInfo'), askRow=$('linkEmailAskRow'), codeRow=$('linkEmailCodeRow'), doneRow=$('linkEmailDoneRow');
  const inp=$('linkEmailIn'), codeIn=$('linkEmailCode'), sendBtn=$('linkEmailSendBtn'), okBtn=$('linkEmailConfirmBtn');
  let pending='';
  function show(mode,text){
    askRow.hidden=mode!=='ask'; codeRow.hidden=mode!=='code'; doneRow.hidden=mode!=='done';
    info.textContent=text;
  }
  function idle(){
    const email=linkEmailRemembered();
    if(email)show('done','Links you choose on Agent tasks are emailed to '+email+'.');
    else show('ask','Get the links you choose on Agent tasks (Choose this, Send me link) by email. We send a code to check the address is yours.');
  }
  const draw=window.linkEmailDraw=async function(){
    if(!linkEmailProfile()){ box.hidden=true; return; }
    box.hidden=false;
    if(codeRow.hidden)idle();
    try{ const out=await linkEmailCall({action:'status'}); linkEmailRemember(out.email||''); if(codeRow.hidden)idle(); }catch(e){ /* keep what's remembered */ }
  };
  sendBtn.addEventListener('click',async function(){
    const email=inp.value.trim();
    if(!linkEmailValid(email)){ info.textContent='That doesn’t look like an email address.'; return; }
    sendBtn.disabled=true;
    try{ await linkEmailCall({action:'start',email:email}); pending=email; codeIn.value=''; show('code','We sent a 6-digit code to '+email+'. Type it here. It can take a minute, and may land in spam.'); codeIn.focus(); }
    catch(e){ info.textContent='Couldn’t send the code: '+e.message+'.'; }
    finally{ sendBtn.disabled=false; }
  });
  okBtn.addEventListener('click',async function(){
    const code=linkEmailCodeClean(codeIn.value);
    if(code.length!==6){ info.textContent='The code is 6 digits.'; return; }
    okBtn.disabled=true;
    try{ const out=await linkEmailCall({action:'confirm',code:code}); linkEmailRemember(out.email||pending); pending=''; idle(); }
    catch(e){ info.textContent=e.message.charAt(0).toUpperCase()+e.message.slice(1)+'.'; }
    finally{ okBtn.disabled=false; }
  });
  codeIn.addEventListener('keydown',function(e){ if(e.key==='Enter')okBtn.click(); });
  inp.addEventListener('keydown',function(e){ if(e.key==='Enter')sendBtn.click(); });
  $('linkEmailBack').addEventListener('click',function(){ pending=''; idle(); if(linkEmailRemembered())show('ask','Type the new address. Links keep going to '+linkEmailRemembered()+' until it’s confirmed.'); });
  $('linkEmailChange').addEventListener('click',function(){ inp.value=''; show('ask','Type the new address. Links keep going to '+linkEmailRemembered()+' until it’s confirmed.'); inp.focus(); });
  $('linkEmailForget').addEventListener('click',async function(){
    try{ await linkEmailCall({action:'forget'}); linkEmailRemember(''); idle(); }
    catch(e){ info.textContent='Couldn’t do that: '+e.message+'.'; }
  });
  // drawn with the rest of the Romulus server box
  const prev=window.hostedDraw;
  if(typeof prev==='function')window.hostedDraw=async function(){ const r=await prev.apply(this,arguments); draw(); return r; };
}

if(typeof module!=='undefined')module.exports={linkEmailValid,linkEmailWhy,linkEmailCodeClean,linkEmailSendBody};
