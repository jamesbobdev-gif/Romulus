/* First launch: connect Gmail and Google Calendar before anything else.
   The first thing a new install shows, ahead of the welcome card (welcome.js), is one card with the two
   logos and a Sign in with Google button under each. The sign-in is the real one (connectGoogleQuick in
   connect-accounts.js, then agent/calendars.js on the computer or mobile/cal-phone.js on the phone): the
   browser opens on Google's page, and the account lands in Settings → Calendars & email like any other.
   One Google sign-in covers both. Gmail's button asks for the mail permissions as well, Calendar's for the
   calendar only, and pressing the other button afterwards adds what is missing to the same account. The
   phone has no mail, so it shows the calendar only. Skip for now puts the card away for good
   (GOOGLE_FIRST_KEY); so does an install that already has an account connected.
   googleFirstState() is plain and loads in node for the tests (test/google-first.test.js).
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';
const GOOGLE_FIRST_KEY='tasks.googleFirst.v1';
let googleFirstUp=false; // the card is up, or still deciding whether to be (welcome.js keeps the sync bar away meanwhile)
function googleFirstShowing(){ return googleFirstUp; }

/* what each tile shows, from the account overview Settings uses: 'done' (connected), 'todo' (sign in), 'off' (no mail on this device) */
function googleFirstState(overview,canMail){
  const accts=(overview&&Array.isArray(overview.accounts))?overview.accounts:[];
  const google=accts.filter(function(a){ return a.provider==='google'&&!a.broken; });
  const withAddress=google.find(function(a){ return a.label&&String(a.label).indexOf('@')>0; });
  return {
    calendar:google.length?'done':'todo',
    gmail:!canMail?'off':google.some(function(a){ return a.gmail; })?'done':'todo',
    email:withAddress?withAddress.label:'',
    any:accts.length>0 // an install with any account connected has been through Settings already: nothing to ask
  };
}

if(typeof module!=='undefined'&&module.exports)module.exports={googleFirstState:googleFirstState};
else if(typeof document!=='undefined'&&document.getElementById('googleFirst'))(function(){
  const api=typeof calApi!=='undefined'?calApi:null; // calendars.js: the desktop bridge, or the phone's
  if(!api)return; // a plain browser has nothing to sign in to
  let seen=false; try{ seen=!!localStorage.getItem(GOOGLE_FIRST_KEY); }catch(e){}
  if(seen)return;
  googleFirstUp=true;
  const card=$('googleFirst'), welcome=$('welcomeCard'), err=$('googleFirstErr'), wait=$('googleFirstWait');
  const canMail=!!(window.desktop&&window.desktop.mailSetEnabled);
  const tiles={gmail:card.querySelector('[data-tile="gmail"]'),calendar:card.querySelector('[data-tile="calendar"]')};
  let last=null; // the tiles as last drawn
  const mark=function(){ try{ localStorage.setItem(GOOGLE_FIRST_KEY,String(Date.now())); }catch(e){} };
  // the welcome card is already up (welcome.js shows it at load): it waits behind this one
  const welcomeWas=!!(welcome&&!welcome.hidden); if(welcomeWas)welcome.hidden=true;
  const welcomed=function(){ try{ return !!localStorage.getItem(WELCOME_KEY); }catch(e){ return false; } };
  const letWelcomeBack=function(){
    if(welcomeWas&&welcome&&!welcomed()){
      welcome.hidden=false;
      if(last&&last.calendar==='done'&&$('welcomeCalBtn'))$('welcomeCalBtn').hidden=true; // its calendar button is done with
    }
    if(typeof drawSyncNudge==='function')drawSyncNudge();
  };
  const close=function(){ googleFirstUp=false; mark(); card.hidden=true; letWelcomeBack(); };
  const draw=function(st){
    last=st;
    ['gmail','calendar'].forEach(function(k){
      const t=tiles[k], s=st[k];
      t.hidden=s==='off';
      t.classList.toggle('done',s==='done');
      t.querySelector('[data-sign]').hidden=s==='done';
      const d=t.querySelector('[data-done]'); d.hidden=s!=='done';
      if(s==='done')d.textContent='Connected'+(st.email?' as '+st.email:'');
    });
    // the calendar is in but Gmail isn't: the same account, signed in once more with the mail permissions
    if(st.gmail==='todo'&&st.calendar==='done')tiles.gmail.querySelector('[data-note]').textContent='Adds Gmail to the same sign-in.';
    const some=st.calendar==='done'||st.gmail==='done';
    $('googleFirstGo').hidden=!some; $('googleFirstSkip').hidden=some;
  };
  const overview=async function(){ try{ return await api.calOverview(false); }catch(e){ return null; } };
  const refresh=async function(){ if(card.hidden)return; const o=await overview(); if(o)draw(googleFirstState(o,canMail)); };

  /* sign in from one of the tiles */
  card.addEventListener('click',async function(e){
    const b=e.target.closest('button[data-sign]'); if(!b)return;
    const mail=b.dataset.sign==='gmail';
    err.textContent='';
    const btns=card.querySelectorAll('button[data-sign]');
    btns.forEach(function(x){ x.disabled=true; });
    b.textContent='Opening browser…';
    wait.hidden=false;
    let r;
    try{ r=typeof window.connectGoogleQuick==='function'?await window.connectGoogleQuick({mail:mail}):{ok:false,error:'not ready yet'}; }
    catch(e2){ r={ok:false,error:e2.message}; }
    btns.forEach(function(x){ x.disabled=false; x.textContent='Sign in with Google'; });
    if(r&&r.pending){ wait.textContent='Finish signing in in your browser, then come back here.'; return; } // the phone hears back later (onConnected)
    wait.hidden=true;
    if(!r||!r.ok){
      if(r&&r.needsClient){
        // a copy built without its own Google sign-in: the paste-your-own-credential form in Settings
        err.textContent='This copy has no Google sign-in built in. ';
        const a=document.createElement('a'); a.href='#'; a.textContent='Paste your own credential in Settings';
        a.addEventListener('click',function(ev){ ev.preventDefault(); if(window.openConnect)window.openConnect('google'); });
        err.appendChild(a); err.appendChild(document.createTextNode('.'));
      } else err.textContent='Not connected: '+((r&&r.error)||'sign-in didn’t finish')+'. Try again.';
      return;
    }
    await refresh();
  });
  $('googleFirstGo').addEventListener('click',close);
  $('googleFirstSkip').addEventListener('click',function(e){ e.preventDefault(); close(); });
  // a sign-in that finished elsewhere (Settings, or the phone's browser): the tiles catch up
  window.addEventListener('focus',refresh);
  if(api.onConnected)api.onConnected(function(){ setTimeout(refresh,500); });

  /* show it, unless this install already has an account connected */
  overview().then(function(o){
    const st=googleFirstState(o,canMail);
    if(st.any){ googleFirstUp=false; mark(); letWelcomeBack(); return; }
    if(!canMail)$('googleFirstTitle').textContent='Connect Google Calendar';
    draw(st); card.hidden=false;
  });
})();
