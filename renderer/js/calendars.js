/* Settings → Calendars: accounts on the desktop or the phone.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── Calendars: Google / Microsoft / calendar links, on the desktop (main process) or the phone (mobile/cal-phone.js) ──
   Per calendar: "Tasks go here" (one calendar at a time; the desktop's main puts the tasks on it) and "Add to to-dos"
   (its events in the next two weeks become personal to-dos, tagged with the calendar's name). Repeating
   events (classes, weekly meetings) are skipped unless allowed, and so are ones with a skipped word. */
let gcalRefreshFn=null;
const calApi=(window.desktop&&window.desktop.calOverview)?window.desktop:(window.phoneCal||null);
if(calApi){
  // When background sync finishes, update in-memory event ids silently
  if(window.desktop&&window.desktop.onSyncDone)window.desktop.onSyncDone(function(updatedTasks){
    updatedTasks.forEach(function(t){
      const ex=state.tasks.find(function(x){ return x.id===t.id; });
      if(ex){ ex.googleEventId=t.googleEventId; ex.calRef=t.calRef||null; }
    });
  });
  const calErr=function(m){ $('calErr').textContent=m||''; };
  const escH=function(x){ return String(x==null?'':x).replace(/[&<>"]/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); };
  const PROV={google:'Google',microsoft:'Microsoft',ics:'Calendar link'};
  let calData=null;
  gcalRefreshFn=async function(fresh){
    try{ calData=await calApi.calOverview(!!fresh); }catch(e){ calErr('Couldn’t load calendars: '+e.message); return; }
    const box=$('calAccounts'); box.innerHTML='';
    calData.accounts.forEach(function(a){
      const el=document.createElement('div'); el.className='cal-acct';
      // "Google account" already says Google: only tag the provider when the name doesn't
      const tag=String(a.label||'').toLowerCase().indexOf(PROV[a.provider].toLowerCase())<0?'<span class="mono">'+PROV[a.provider]+'</span>':'<span></span>';
      let h='<div class="cal-acct-head"><b>'+escH(a.label)+'</b>'+tag+'<button class="ghost mono danger" data-remove>Remove</button></div>';
      if(a.broken||a.error)h+='<div class="cal-acct-err">'+(a.broken?'Signed out — sign in with '+PROV[a.provider]+' again.':escH(a.error))+'</div>';
      a.calendars.forEach(function(c){
        h+='<div class="cal-row" data-ref="'+escH(c.ref)+'"><span class="cal-name" title="'+escH(c.name)+'">'+escH(c.name)+'</span>'+
          (c.canWrite?'<label class="switch"><input type="checkbox" data-push'+(c.push?' checked':'')+'><span class="track" aria-hidden="true"></span><span>Send my tasks here</span></label>':'')+
          '<label class="switch"><input type="checkbox" data-pull'+(c.pull?' checked':'')+'><span class="track" aria-hidden="true"></span><span>Add its events as to-dos</span></label></div>';
        if(c.pull)h+='<div class="cal-opts" data-ref="'+escH(c.ref)+'"><label class="chk"><input type="checkbox" data-rep'+(c.pull.skipRepeating!==false?' checked':'')+'> Skip repeating events (classes, weekly meetings)</label>'+
          '<input class="settings-inp" data-words placeholder="Also skip events with these words, e.g. lecture, lab, office hours" value="'+escH(c.pull.skipWords||'')+'"></div>';
        if(c.needsReconnect)h+='<p class="settings-hint" style="margin:2px 0 6px">Only your main calendar shows. <a href="#" data-reconnect>Sign in again</a> to see the rest.</p>';
      });
      el.innerHTML=h;
      el.querySelectorAll('[data-reconnect]').forEach(function(x){ x.addEventListener('click',function(e){ e.preventDefault(); $('calGoogleBtn').click(); }); });
      el.querySelector('[data-remove]').addEventListener('click',async function(){
        if(this.dataset.armed!=='1'){ this.dataset.armed='1'; this.textContent='Remove?'; return; }
        await calApi.calRemove(a.id); gcalRefreshFn();
      });
      el.querySelectorAll('[data-push]').forEach(function(inp){ inp.addEventListener('change',async function(){
        const ref=inp.closest('[data-ref]').dataset.ref;
        await calApi.calSetPrefs({push:inp.checked?ref:null});
        $('calStatus').textContent=inp.checked?'putting your tasks on it…':'taking your tasks off it…';
        gcalRefreshFn();
      }); });
      el.querySelectorAll('[data-pull]').forEach(function(inp){ inp.addEventListener('change',async function(){
        const ref=inp.closest('[data-ref]').dataset.ref, ch={}; ch[ref]=inp.checked?{skipRepeating:true,skipWords:''}:null;
        await calApi.calSetPrefs({pull:ch});
        await gcalRefreshFn();
        if(inp.checked)calTick();
      }); });
      el.querySelectorAll('.cal-opts').forEach(function(o){
        const save=async function(){ const ch={}; ch[o.dataset.ref]={skipRepeating:o.querySelector('[data-rep]').checked,skipWords:o.querySelector('[data-words]').value}; await calApi.calSetPrefs({pull:ch}); calTick(); };
        o.querySelector('[data-rep]').addEventListener('change',save);
        o.querySelector('[data-words]').addEventListener('change',save);
      });
      box.appendChild(el);
    });
    $('calSyncRow').hidden=!calData.accounts.length;
    if(calData.phone)$('gcalSection').querySelector('.settings-hint').textContent='Sign in to connect your calendars, then choose which calendars’ events show up as to-dos. Nothing comes off a calendar until you switch it on. Putting your tasks on a calendar is set up in the desktop app.';
    $('mailEventsBox').hidden=!calData.accounts.some(function(a){ return a.provider==='google'; });
    if(window.mailRefresh)window.mailRefresh();
  };

  /* calendar events → to-dos. Each keeps the id main gives it, so it's added once; a deleted one isn't
     brought back; an event that moves is followed unless he changed the to-do's date himself */
  const CAL_SEEN_KEY='tasks.calSeen';
  const calTick=async function(){
    let r; try{ r=await calApi.calPull(state.tasks.map(function(t){ return t.googleEventId; }).filter(Boolean)); }catch(e){ return; }
    let seen={}; try{ seen=JSON.parse(localStorage.getItem(CAL_SEEN_KEY)||'{}')||{}; }catch(e){}
    const byId={}; state.tasks.forEach(function(t){ byId[t.id]=t; });
    const tombed={}; state.tombstones.forEach(function(x){ tombed[x.id]=1; });
    const norm=function(x){ return String(x||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); };
    let added=0, moved=0;
    r.items.forEach(function(e){
      const was=seen[e.id], now=e.due+' '+(e.dueTime||'');
      seen[e.id]=now;
      const t=byId[e.id];
      if(t){
        if(was&&was!==now&&!t.done&&(t.due+' '+(t.dueTime||''))===was){ t.due=e.due; t.dueTime=e.dueTime; moved++; }
        return;
      }
      if(was||tombed[e.id])return;
      if(state.tasks.some(function(x){ return x.due===e.due&&norm(x.title)===norm(e.title); }))return;
      state.tasks.push({id:e.id,title:e.title,done:false,due:e.due,dueTime:e.dueTime||null,tag:e.tag||null,notes:e.notes||null,ws:'personal',subs:[],googleEventId:null,fromCal:e.cal,created:Date.now()});
      added++;
    });
    try{ localStorage.setItem(CAL_SEEN_KEY,JSON.stringify(seen)); }catch(e){}
    if(added||moved)touch();
    $('calStatus').textContent=r.errors.length?r.errors[0]:(added?added+' event'+(added>1?'s':'')+' added to your to-dos':'')+'';
  };

  $('calGoogleBtn').addEventListener('click',async function(){
    calErr('');
    if(calData&&!calData.builtIn.google&&calData.phone){ calErr('Google sign-in isn’t set up in this copy of the app yet (oauth-clients.json).'); return; }
    if(calData&&!calData.builtIn.google){ $('gcalSetup').hidden=false; const c=await window.desktop.gcalGetCfg(); if(c.clientId)$('gcalClientId').value=c.clientId; if(c.clientSecret)$('gcalClientSecret').value=c.clientSecret; return; }
    const b=this; b.textContent='Opening browser…'; b.disabled=true;
    const r=await calApi.calConnect('google');
    b.textContent='+ Google'; b.disabled=false;
    if(!r.ok)calErr(r.error||'Sign-in failed.'); gcalRefreshFn(true);
  });
  $('calMsBtn').addEventListener('click',async function(){
    calErr('');
    const b=this; b.textContent='Opening browser…'; b.disabled=true;
    const r=await calApi.calConnect('microsoft');
    b.textContent='+ Microsoft'; b.disabled=false;
    if(!r.ok)calErr(r.needsClient?'Microsoft sign-in isn’t set up in this copy of the app yet (oauth-clients.json).':(r.error||'Sign-in failed.')); gcalRefreshFn(true);
  });
  $('calLinkBtn').addEventListener('click',function(){ $('calLinkBox').hidden=!$('calLinkBox').hidden; if(!$('calLinkBox').hidden)$('calLinkUrl').focus(); });
  $('calLinkAdd').addEventListener('click',async function(){
    calErr('');
    const b=this; b.textContent='Checking…'; b.disabled=true;
    const r=await calApi.calAddLink($('calLinkUrl').value,$('calLinkName').value);
    b.textContent='Add'; b.disabled=false;
    if(!r.ok){ calErr(r.error); return; }
    $('calLinkUrl').value=''; $('calLinkName').value=''; $('calLinkBox').hidden=true; gcalRefreshFn(true);
  });
  $('gcalConsoleLink').addEventListener('click',function(e){
    e.preventDefault();
    window.desktop.gcalOpenUrl('https://console.cloud.google.com/apis/credentials');
  });
  $('gcalConnectBtn').addEventListener('click',async function(){
    const id=$('gcalClientId').value.trim(); const sec=$('gcalClientSecret').value.trim();
    calErr('');
    if(!id||!sec){ calErr('Enter both fields.'); return; }
    $('gcalConnectBtn').textContent='Opening browser…'; $('gcalConnectBtn').disabled=true;
    await window.desktop.gcalSaveCfg({clientId:id,clientSecret:sec});
    const r=await window.desktop.calConnect('google',{clientId:id,clientSecret:sec});
    $('gcalConnectBtn').textContent='Connect'; $('gcalConnectBtn').disabled=false;
    if(r.ok){ $('gcalSetup').hidden=true; gcalRefreshFn(true); }
    else calErr(r.error||'Connection failed.');
  });
  $('gcalSyncBtn').addEventListener('click',async function(){
    $('gcalSyncBtn').textContent='Syncing…'; $('gcalSyncBtn').disabled=true;
    if(window.desktop&&window.desktop.gcalSyncNow)await window.desktop.gcalSyncNow(); await calTick();
    $('gcalSyncBtn').textContent='Sync now'; $('gcalSyncBtn').disabled=false;
  });
  gcalRefreshFn();
  if(calApi.onConnected)calApi.onConnected(function(){ gcalRefreshFn(true); }); // phone: a sign-in that finished after Android closed the app
  // shortly after start (sync has loaded the lists by then), then every 15 minutes
  setTimeout(calTick,45*1000); setInterval(calTick,15*60*1000);

  /* Dates from Gmail: main checks the mailbox (free when nothing's new) and asks Claude
     about new mail that mentions a date. Each found date is a personal task with its own id, added once:
     one he deleted isn't brought back, and one already on a list (same day, same name) isn't doubled. */
  if(window.desktop&&window.desktop.mailCheck){
    const mailSay=function(st,r){
      if(!st.connected)return '';
      if(!st.allowed)return 'Sign in with Google again, and tick Gmail on Google’s screen, to allow this.';
      if(!st.enabled)return '';
      if(r&&r.error)return 'last check failed: '+r.error;
      if(r&&r.items&&r.items.length)return r.items.length+' date'+(r.items.length>1?'s':'')+' added from email just now.';
      return st.last?'Last checked '+new Date(st.last).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+'.':'';
    };
    const addMailItems=function(items){
      const tombed={}; state.tombstones.forEach(function(x){ tombed[x.id]=1; });
      const norm=function(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); };
      let added=0;
      (items||[]).forEach(function(e){
        if(tombed[e.id]||state.tasks.some(function(x){ return x.id===e.id||(x.due===e.due&&norm(x.title)===norm(e.title)); }))return;
        state.tasks.push({id:e.id,title:e.title,done:false,due:e.due,dueTime:e.dueTime||null,tag:'email',notes:e.notes||null,ws:'personal',subs:[],googleEventId:null,created:Date.now()});
        added++;
      });
      if(added)touch();
      return added;
    };
    const mailTick=async function(){
      try{
        const r=await window.desktop.mailCheck();
        if(r&&r.items)addMailItems(r.items);
        $('mailStatus').textContent=mailSay(await window.desktop.mailStatus(),r);
      }catch(e){}
    };
    window.mailRefresh=function(){ window.desktop.mailStatus().then(function(st){ $('mailOn').checked=st.enabled; $('mailStatus').textContent=mailSay(st); }).catch(function(){}); };
    window.mailRefresh();
    $('mailOn').addEventListener('change',async function(){
      await window.desktop.mailSetEnabled($('mailOn').checked);
      if($('mailOn').checked)mailTick(); else $('mailStatus').textContent='';
    });
    // a minute after start (sync has loaded the lists by then), then every 15 minutes
    setTimeout(mailTick,60*1000); setInterval(mailTick,15*60*1000);
  } else $('mailEventsBox').hidden=true;
} else {
  $('gcalSection').hidden=true; // a plain browser: no calendar accounts
}
