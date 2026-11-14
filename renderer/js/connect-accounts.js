/* Settings → Calendars & email: one picker that walks a new user through connecting where their calendar and
   email live. Each choice is one short step:
     Google            one sign-in for Google Calendar and (if left ticked) Gmail
     Outlook / 365     Microsoft sign-in when this build has it; otherwise the steps to publish an Outlook calendar link
     iPhone / iCloud   on the computer: Apple ID + app-specific password (CalDAV), so tasks can go on it;
                       or the steps to share an iCloud calendar as a link (read only; the phone always does this)
     School            Canvas / Blackboard / D2L calendar link; its events are due dates (wiring.js feeds on the computer)
     Other             on the computer: any CalDAV server (Fastmail, Nextcloud, Yahoo…), or any calendar link
   What it should do is asked before signing in (ticked by default), so nothing extra has to be found afterwards:
   the new account's main calendar is switched on for to-dos, Gmail's dates check is turned on, and (on the
   computer, when no calendar takes tasks yet) the tasks go onto its main calendar. A calendar link can't take them.
   A phone sign-in can finish after Android closed the app, so the choices wait in localStorage (PENDING_KEY)
   and are applied to whichever account shows up new.
   linkKind() is plain and loads in node for the tests (test/connect-accounts.test.js).
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* a pasted calendar link → { url, name, kind } ready to add, or { warn } saying what is wrong with it */
function linkKind(raw){
  let s=String(raw==null?'':raw).trim().replace(/^<|>$/g,'');
  if(!s)return null;
  // a link copied out of an email or a page sometimes comes with words around it
  const m=s.match(/(?:webcals?|https?):\/\/\S+/i); if(m)s=m[0];
  s=s.replace(/^webcals?:\/\//i,'https://');
  if(/^http:\/\//i.test(s))s='https://'+s.slice(7);
  let u; try{ u=new URL(s); }catch(e){ return {warn:'Paste the whole link. It starts with https:// or webcal://.'}; }
  if(u.protocol!=='https:')return {warn:'Paste the whole link. It starts with https:// or webcal://.'};
  const host=u.hostname.toLowerCase(), p=u.pathname;
  if(host==='calendar.google.com'||host==='www.google.com'&&/^\/calendar\//.test(p)){
    if(/\/calendar\/ical\//.test(p))return {url:u.href,name:'Google Calendar',kind:'google'};
    return {warn:'That is the Google Calendar page, not a calendar link. Choose Google instead and sign in.'};
  }
  if(/(^|\.)outlook\.(live|office|office365)\.com$/.test(host)||host==='outlook.com'){
    if(/\/owa\/calendar\/.+\/(reachcalendar|calendar|index)\.(html|ics)$/i.test(p)){
      u.pathname=p.replace(/(reachcalendar|calendar|index)\.html$/i,'calendar.ics');
      return {url:u.href,name:'Outlook',kind:'outlook'};
    }
    return {warn:'That is the Outlook page, not a calendar link. Publish the calendar and copy the ICS link.'};
  }
  if(/(^|\.)icloud\.com$/.test(host)){
    if(/caldav\.icloud\.com$/.test(host)&&/^\/published\//.test(p))return {url:u.href,name:'iCloud',kind:'icloud'};
    return {warn:'That link only opens the calendar on iCloud.com. Turn on Public Calendar and copy that link instead.'};
  }
  if(/instructure\.com$/.test(host)||/\/feeds\/calendars\//.test(p))return {url:u.href,name:'Canvas',kind:'school'};
  if(/\/d2l\//i.test(p))return {url:u.href,name:'D2L',kind:'school'};
  if(/blackboard/.test(host)||/\/webapps\/calendar\//i.test(p)||/\/learn\/api\/public\/v1\/calendars/i.test(p))return {url:u.href,name:'Blackboard',kind:'school'};
  if(/(^|\.)yahoo\.com$/.test(host))return {url:u.href,name:'Yahoo',kind:'link'};
  return {url:u.href,name:host.replace(/^(www|calendar|cal)\./,'').split('.').slice(0,-1).join('.')||host,kind:'link'};
}

if(typeof module!=='undefined'&&module.exports){ module.exports={linkKind:linkKind}; }
else if(typeof calApi!=='undefined'&&calApi&&document.getElementById('connectPick'))(function(){
  const PENDING_KEY='tasks.connectPending';
  const desk=!!(window.desktop&&window.desktop.calOverview);
  const canMail=!!(desk&&window.desktop.mailSetEnabled);
  const canFeeds=!!(desk&&window.desktop.feedsSave&&typeof importCourseFeeds==='function');
  const canDav=!!(desk&&window.desktop.calAddCaldav);
  let hasPush=false; // some calendar already takes the tasks: then a new one doesn't, unless he ticks it
  const step=$('connectStep'), pick=$('connectPick');
  const esc=function(x){ return String(x==null?'':x).replace(/[&<>"]/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };

  /* ---------- after connecting: switch on what was ticked ---------- */
  const readPending=function(){ try{ const p=JSON.parse(localStorage.getItem(PENDING_KEY)||'null'); return p&&Date.now()-p.at<15*60*1000?p:null; }catch(e){ return null; } };
  const savePending=function(p){ try{ if(p)localStorage.setItem(PENDING_KEY,JSON.stringify(p)); else localStorage.removeItem(PENDING_KEY); }catch(e){} };
  // the accounts that weren't there before: their main calendar starts sending events to the to-do list
  const applyPending=async function(){
    const p=readPending(); if(!p)return 0;
    let o; try{ o=await calApi.calOverview(true); }catch(e){ return 0; }
    const fresh=o.accounts.filter(function(a){ return p.before.indexOf(a.id)<0&&(!p.provider||a.provider===p.provider); });
    if(!fresh.length)return 0;
    savePending(null);
    const ch={}; let push=null;
    fresh.forEach(function(a){
      const main=a.calendars.find(function(c){ return c.primary; })||a.calendars[0];
      if(p.pull&&main&&!main.pull)ch[main.ref]={skipRepeating:true,skipWords:''};
      if(p.push&&!push){ const w=main&&main.canWrite?main:a.calendars.find(function(c){ return c.canWrite; }); if(w)push=w.ref; }
    });
    if(Object.keys(ch).length||push)await calApi.calSetPrefs(Object.assign(Object.keys(ch).length?{pull:ch}:{},push?{push:push}:{}));
    if(p.mail&&canMail&&fresh.some(function(a){ return a.provider==='google'&&a.gmail; }))await window.desktop.mailSetEnabled(true);
    return fresh.length;
  };
  const afterConnect=async function(){
    const n=await applyPending();
    if(typeof gcalRefreshFn==='function')await gcalRefreshFn(true);
    if(n&&window.calPullNow)window.calPullNow();
    if(n&&window.mailRefresh)window.mailRefresh();
    return n;
  };
  if(calApi.onConnected)calApi.onConnected(function(){ afterConnect().then(function(n){ if(n)done('Connected.'); }); });
  setTimeout(function(){ if(readPending())afterConnect(); },1500); // the phone app reopened after its sign-in

  /* ---------- the step panel ---------- */
  const close=function(){ step.hidden=true; step.innerHTML=''; pick.querySelectorAll('button').forEach(function(b){ b.classList.remove('on'); }); };
  const done=function(msg){
    close();
    if(typeof jobsOfferAfterConnect==='function')jobsOfferAfterConnect(); // jobs.js: with the Agent list empty, its first task (once)
    const n=$('connectDone'); n.textContent=msg+' Its events show up on your to-do list within a few minutes. Change what each calendar does below.'; n.hidden=false;
    setTimeout(function(){ n.hidden=true; },20000);
  };
  const box=function(title,body){
    step.innerHTML='<div class="connect-step-head"><b>'+esc(title)+'</b><button class="ghost mono" data-close>Close</button></div>'+body+'<p class="connect-err" data-err></p>';
    step.hidden=false; $('connectDone').hidden=true;
    step.querySelector('[data-close]').addEventListener('click',close);
    requestAnimationFrame(function(){ step.scrollIntoView({block:'nearest',behavior:'smooth'}); });
  };
  const err=function(m){ const e=step.querySelector('[data-err]'); if(e)e.textContent=m||''; };
  const tick=function(key,label,on){ return '<label class="chk connect-chk"><input type="checkbox" data-opt="'+key+'"'+(on?' checked':'')+'> '+label+'</label>'; };
  const opt=function(key){ const i=step.querySelector('[data-opt="'+key+'"]'); return !!(i&&i.checked); };
  // the computer puts tasks on one calendar (main/gcal-sync.js); a new account takes them if none does yet
  const pushTick=function(){ return desk?tick('push','Put my tasks on its calendar, so I can see and change them there',!hasPush):''; };
  const before=async function(){ try{ return (await calApi.calOverview(false)).accounts.map(function(a){ return a.id; }); }catch(e){ return []; } };

  /* sign in with Google or Microsoft */
  const signIn=function(provider){
    const g=provider==='google', name=g?'Google':'Microsoft';
    box(g?'Google':'Outlook or Microsoft 365',
      '<p class="settings-hint">'+(g?'One sign-in connects your Google Calendar'+(canMail?' and Gmail':'')+'. Sign in with the account you use, then come back here.'
        :'One sign-in connects your Outlook, Microsoft 365, work or school calendar.')+'</p>'+
      tick('pull','Put my upcoming events on my to-do list',true)+
      pushTick()+
      (g&&canMail?tick('mail','Use my Gmail too: find dates in new email, and send emails I approve',true):'')+
      (!g&&desk?tick('mail','Let the Agent send emails I approve from Outlook',true):'')+
      '<div class="settings-row"><button class="btn-accent connect-go" data-go>Sign in with '+name+'</button></div>'+
      '<p class="settings-hint connect-wait" data-wait hidden>Finish signing in in the browser window that opened. '+(g?'If Google says it hasn’t verified the app, press <b>Advanced</b>, then <b>Go to Romulus</b>. ':'')+'Tick every box on the permissions screen.</p>');
    const go=step.querySelector('[data-go]');
    go.addEventListener('click',async function(){
      err(''); go.disabled=true; go.textContent='Opening browser…';
      const mail=opt('mail');
      savePending({at:Date.now(),provider:provider,before:await before(),pull:opt('pull'),push:opt('push'),mail:g&&mail});
      step.querySelector('[data-wait]').hidden=false;
      let r; try{ r=await calApi.calConnect(provider,desk&&!mail?{noMail:true}:undefined); }catch(e){ r={ok:false,error:e.message}; }
      go.disabled=false; go.textContent='Sign in with '+name;
      if(!r||!r.ok){
        step.querySelector('[data-wait]').hidden=true;
        // the phone hands sign-in to the browser and hears back later (onConnected)
        if(r&&r.pending)return;
        savePending(null);
        err(r&&r.needsClient?name+' sign-in isn’t built into this copy of the app.':'Not connected: '+((r&&r.error)||'sign-in didn’t finish')+'. Try again.');
        return;
      }
      await afterConnect();
      done('Connected'+(r.email?' '+r.email:'')+'.');
    });
  };

  /* steps that end in a pasted calendar link */
  const GUIDES={
    microsoft:{title:'Outlook or Microsoft 365',lead:'Outlook can share your calendar as a link. It takes about a minute:',
      steps:['Open your Outlook calendar settings: <a href="#" data-open="https://outlook.live.com/calendar/0/options/calendar/SharedCalendars">Outlook.com</a> or <a href="#" data-open="https://outlook.office.com/calendar/options/calendar/SharedCalendars">work or school</a>.',
        'Under <b>Publish a calendar</b>, pick your calendar and <b>Can view all details</b>, then press <b>Publish</b>.',
        'Copy the <b>ICS</b> link and paste it below.'],
      foot:'A published link only shows your Outlook events here; your tasks can’t go onto it. Some workplaces and schools turn publishing off. If you don’t see it, ask whoever runs your account, or use <b>Other calendar</b> with a link they give you.'},
    icloud:{title:'iPhone or iCloud',lead:'Share your iCloud calendar as a link:',
      steps:['On your iPhone, open <b>Calendar</b> and tap <b>Calendars</b> at the bottom.',
        'Tap the <b>i</b> next to the calendar you want.',
        'Turn on <b>Public Calendar</b>, tap <b>Share Link</b>, then <b>Copy</b>.',
        'Paste it below (it starts with webcal://). On a computer you can do the same at <a href="#" data-open="https://www.icloud.com/calendar/">icloud.com/calendar</a>: the share button next to the calendar, then <b>Public Calendar</b>.'],
      foot:'Your calendar on the phone itself (not iCloud) can’t be shared this way. Turn on iCloud for Calendar first in Settings on the iPhone.'},
    school:{title:'School',lead:'Your class site can give you a link to every due date:',
      steps:['<b>Canvas:</b> Calendar, then <b>Calendar Feed</b> at the bottom right. Copy the link.',
        '<b>Blackboard:</b> Calendar, the gear or settings button, then <b>Share Calendar</b>. Copy the link.',
        '<b>D2L / Brightspace:</b> Calendar, then <b>Subscribe</b>. Copy the link.',
        'Paste it below. Add one link for each school.'],
      foot:canFeeds?'Each due date becomes a to-do on its day, on your School list if you use it.':''},
    link:{title:'Other calendar',lead:'Any calendar app that can share or publish a calendar gives you a link (it ends in .ics or starts with webcal://). Copy it and paste it below.',steps:[],foot:''}
  };
  const linkStep=function(kind){
    const g=GUIDES[kind];
    box(g.title,'<p class="settings-hint">'+g.lead+'</p>'+
      (g.steps.length?'<ol class="connect-steps">'+g.steps.map(function(s){ return '<li>'+s+'</li>'; }).join('')+'</ol>':'')+
      '<div class="connect-paste"><input class="settings-inp" data-url placeholder="Paste the calendar link here" autocomplete="off" spellcheck="false">'+
      (navigator.clipboard&&navigator.clipboard.readText?'<button class="ghost mono" data-paste>Paste</button>':'')+'</div>'+
      '<p class="connect-seen" data-seen></p>'+
      (kind==='school'&&canFeeds?'':tick('pull','Put its upcoming events on my to-do list',true))+
      '<div class="settings-row"><button class="btn-accent connect-go" data-add disabled>Add calendar</button></div>'+
      (g.foot?'<p class="settings-hint">'+g.foot+'</p>':'')+
      (canDav&&(kind==='icloud'||kind==='link')?'<p class="settings-hint">A link only shows your events here. To put your tasks on it too, <a href="#" data-dav>sign in instead</a>.</p>':''));
    step.querySelectorAll('[data-open]').forEach(function(a){ a.addEventListener('click',function(e){ e.preventDefault(); openExternal(a.dataset.open); }); });
    const inp=step.querySelector('[data-url]'), add=step.querySelector('[data-add]'), seen=step.querySelector('[data-seen]');
    let got=null;
    const check=function(){
      got=linkKind(inp.value); err('');
      seen.textContent=!got?'':got.warn?got.warn:got.kind==='link'?'Looks like a calendar link.':'Looks like a link from '+got.name+'.';
      seen.classList.toggle('bad',!!(got&&got.warn));
      add.disabled=!got||!!got.warn;
    };
    inp.addEventListener('input',check);
    inp.addEventListener('keydown',function(e){ if(e.key==='Enter'&&!add.disabled)add.click(); });
    const pb=step.querySelector('[data-paste]');
    if(pb)pb.addEventListener('click',async function(){
      try{ inp.value=await navigator.clipboard.readText(); check(); }catch(e){ inp.focus(); err('Press Ctrl+V (or long-press, then Paste) in the box.'); }
    });
    add.addEventListener('click',async function(){
      if(!got||got.warn)return;
      err(''); add.disabled=true; add.textContent='Checking the link…';
      const schoolFeed=(kind==='school'||got.kind==='school')&&canFeeds;
      try{
        if(schoolFeed){
          const urls=(await window.desktop.feedsGet())||[];
          if(urls.indexOf(got.url)>=0){ err('That link is already added.'); return; }
          const s=await window.desktop.feedsSave(urls.concat([got.url]));
          if(!s.ok){ err(s.error); return; }
          if($('feedsText'))$('feedsText').value=urls.concat([got.url]).join('\n');
          const r=await importCourseFeeds();
          if(r&&r.errors&&r.errors.length&&!r.count){ err('Saved, but it couldn’t be read yet: '+r.errors[0]); return; }
          close(); $('connectDone').textContent='Added. '+(r&&r.count?r.count+' upcoming due date'+(r.count>1?'s':'')+' found.':'No due dates coming up yet; new ones show up as they are posted.'); $('connectDone').hidden=false;
          return;
        }
        if(opt('pull'))savePending({at:Date.now(),provider:'ics',before:await before(),pull:true,mail:false});
        const r=await calApi.calAddLink(got.url,got.kind==='link'?'':got.name);
        if(!r.ok){ savePending(null); err(/already/i.test(r.error||'')?'That calendar is already added.':r.error+'. Check that you copied the whole link.'); return; }
        await afterConnect();
        done(got.name+' calendar added.');
      }catch(e){ err('Couldn’t add it: '+e.message); }
      finally{ add.disabled=!got||!!got.warn; add.textContent='Add calendar'; }
    });
    // on the computer: back to signing in, which lets tasks go on the calendar too
    const back=step.querySelector('[data-dav]');
    if(back)back.addEventListener('click',function(e){ e.preventDefault(); davStep(kind==='icloud'?'icloud':'other'); });
    setTimeout(function(){ inp.focus(); },50);
  };

  /* sign in with an address and app password (CalDAV: iCloud, Fastmail, Nextcloud, Yahoo…), so the
     calendar can be read AND written. A link only reads; the link steps are one click away. */
  const davStep=function(kind){
    const ic=kind==='icloud';
    box(ic?'iPhone or iCloud':'Other calendar',
      (ic?'<p class="settings-hint">Sign in with your Apple ID so your tasks can go on your iPhone calendar too. Apple wants an app-specific password for this, not your normal one. It takes about a minute:</p>'+
        '<ol class="connect-steps"><li>Open <a href="#" data-open="https://account.apple.com/account/manage">your Apple Account</a> and sign in.</li>'+
        '<li>Under <b>Sign-In and Security</b>, choose <b>App-Specific Passwords</b>, then the <b>+</b> button. Name it Tasks.</li>'+
        '<li>Copy the password it shows (four groups of letters) and paste it below with your Apple ID.</li></ol>'
      :'<p class="settings-hint">Fastmail, Nextcloud, Yahoo, mailbox.org and most other calendars connect with your address and an app password (make one in that service’s security settings). Your tasks can go on it too.</p>')+
      '<input class="settings-inp" data-user placeholder="'+(ic?'Apple ID (email)':'Email or user name')+'" autocomplete="off" spellcheck="false">'+
      '<input class="settings-inp" data-pass type="password" placeholder="'+(ic?'App-specific password':'App password')+'" autocomplete="off">'+
      (ic?'':'<input class="settings-inp" data-server placeholder="Server address, e.g. cloud.example.org/remote.php/dav" autocomplete="off" spellcheck="false" hidden>')+
      tick('pull','Put my upcoming events on my to-do list',true)+
      pushTick()+
      '<div class="settings-row"><button class="btn-accent connect-go" data-go>Connect</button></div>'+
      '<p class="settings-hint">Only want to see it here, not change it? <a href="#" data-link>'+(ic?'Share it as a link instead':'Paste a calendar link instead')+'</a>.</p>');
    step.querySelectorAll('[data-open]').forEach(function(a){ a.addEventListener('click',function(e){ e.preventDefault(); openExternal(a.dataset.open); }); });
    step.querySelector('[data-link]').addEventListener('click',function(e){ e.preventDefault(); linkStep(ic?'icloud':'link'); });
    const user=step.querySelector('[data-user]'), pass=step.querySelector('[data-pass]'), server=step.querySelector('[data-server]'), go=step.querySelector('[data-go]');
    const submit=async function(){
      err('');
      if(!user.value.trim()||!pass.value.trim()){ err('Enter both.'); return; }
      go.disabled=true; go.textContent='Checking…';
      try{
        savePending({at:Date.now(),provider:'caldav',before:await before(),pull:opt('pull'),push:opt('push'),mail:false});
        const r=await window.desktop.calAddCaldav({username:user.value.trim(),password:pass.value,server:ic?'https://caldav.icloud.com/':(server&&server.value.trim())||''});
        if(!r||!r.ok){
          savePending(null);
          // not a service it knows: ask where its calendar server is
          if(r&&r.needsServer&&server){ server.hidden=false; server.focus(); err('What’s your calendar server’s address? It’s in that service’s help pages, often under CalDAV.'); return; }
          err((r&&r.error)||'Not connected.');
          return;
        }
        pass.value='';
        await afterConnect();
        done('Connected '+r.email+'.');
      }catch(e){ savePending(null); err('Couldn’t connect: '+e.message); }
      finally{ go.disabled=false; go.textContent='Connect'; }
    };
    go.addEventListener('click',submit);
    [user,pass,server].forEach(function(i){ if(i)i.addEventListener('keydown',function(e){ if(e.key==='Enter')submit(); }); });
    setTimeout(function(){ user.focus(); },50);
  };

  /* the first-launch card (google-first.js) signs in from outside Settings, with the usual choices ticked: events
     onto the to-do list, tasks onto its calendar when none takes them yet, and Gmail when its tile was pressed */
  window.connectGoogleQuick=async function(o){
    const mail=!!(o&&o.mail)&&canMail;
    let ov=null; try{ ov=await calApi.calOverview(false); }catch(e){}
    if(ov&&ov.builtIn&&ov.builtIn.google===false)return {ok:false,needsClient:true};
    const ids=ov?ov.accounts.map(function(a){ return a.id; }):[];
    const taken=!!(ov&&ov.accounts.some(function(a){ return a.calendars.some(function(c){ return c.push; }); }));
    savePending({at:Date.now(),provider:'google',before:ids,pull:true,push:desk&&!taken,mail:mail});
    let r; try{ r=await calApi.calConnect('google',desk&&!mail?{noMail:true}:undefined); }catch(e){ r={ok:false,error:e.message}; }
    if(!r||!r.ok){ if(!(r&&r.pending))savePending(null); return r||{ok:false,error:'sign-in didn’t finish'}; }
    await afterConnect();
    // Gmail added to an account that was already here: applyPending only switches on new accounts
    if(mail&&r.id){ try{ const o2=await calApi.calOverview(false); if(o2.accounts.some(function(a){ return a.id===r.id&&a.gmail; }))await window.desktop.mailSetEnabled(true); }catch(e){} }
    if(typeof jobsOfferAfterConnect==='function')jobsOfferAfterConnect(); // jobs.js: with the Agent list empty, its first task (once)
    return r;
  };
  pick.addEventListener('click',async function(e){
    const b=e.target.closest('button[data-pick]'); if(!b)return;
    const k=b.dataset.pick;
    pick.querySelectorAll('button').forEach(function(x){ x.classList.toggle('on',x===b); });
    let o=null; try{ o=await calApi.calOverview(false); }catch(err2){}
    const built=(o&&o.builtIn)||{};
    hasPush=!!(o&&o.accounts.some(function(a){ return a.calendars.some(function(c){ return c.push; }); }));
    if(k==='google'){
      // a copy built without its own Google sign-in (a fork): the paste-your-own-credential form
      if(!built.google&&desk){ close(); $('gcalSetup').hidden=false; window.desktop.gcalGetCfg().then(function(c){ if(c.clientId)$('gcalClientId').value=c.clientId; if(c.clientSecret)$('gcalClientSecret').value=c.clientSecret; }); return; }
      if(!built.google){ linkStep('link'); err('Google sign-in isn’t built into this copy of the app. In Google Calendar settings, copy the “Secret address in iCal format” and paste it here.'); return; }
      signIn('google');
    }
    else if(k==='microsoft'){ if(built.microsoft)signIn('microsoft'); else linkStep('microsoft'); }
    else if(canDav&&(k==='icloud'||k==='link'))davStep(k==='icloud'?'icloud':'other');
    else linkStep(k);
  });

  // other parts of the app ("Connect Gmail or Outlook to send email") open the picker straight on a choice
  window.openConnect=function(k){
    openSettingsAt('calGroup','gcalSection');
    const b=k&&pick.querySelector('[data-pick="'+k+'"]'); if(b)setTimeout(function(){ b.click(); },250);
  };
})();
