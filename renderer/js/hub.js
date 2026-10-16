/* Settings → Mini PC server: this computer as a client of the hub mini PC (main/hub.js).
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

if(window.desktop&&window.desktop.hubGet){
  const say=function(msg,isErr){ const n=$('hubStatus'); n.textContent=msg; n.style.color=isErr?'var(--late)':'var(--muted)'; };
  const draw=function(st){
    $('hubSection').hidden=false;
    const on=st.role==='client';
    if(st.role==='server'){ // the mini PC itself: nothing to set here
      $('hubUrl').hidden=$('hubToken').hidden=true; $('hubTestBtn').hidden=$('hubOnBtn').hidden=true;
      say('This is the mini PC server.'); return;
    }
    $('hubUrl').value=st.url||'';
    $('hubToken').placeholder=st.hasToken?'saved (paste a new one to change it)':'hub token (from hub-token.txt on the mini PC)';
    $('hubOnBtn').hidden=on; $('hubOffBtn').hidden=!on; $('hubSendBtn').hidden=!on;
    say(on?'On: the mini PC does the agent, mail and calendar work.':'Off: everything runs on this computer.');
  };
  const refresh=function(){ window.desktop.hubGet().then(draw).catch(function(){}); };
  refresh();
  const restart=async function(){
    if(confirm('Tasks restarts to switch. Restart now?'))await window.desktop.hubRestart();
    else say('Switches the next time Tasks starts.');
  };
  $('hubTestBtn').addEventListener('click',async function(){
    say('testing…');
    const r=await window.desktop.hubTest($('hubUrl').value.trim(),$('hubToken').value.trim());
    say(r.ok?'Reached '+(r.host||'the mini PC')+(r.version?' (Tasks '+r.version+')':'')+'.':'Couldn’t reach it: '+r.error,!r.ok);
  });
  $('hubOnBtn').addEventListener('click',async function(){
    const url=$('hubUrl').value.trim(), token=$('hubToken').value.trim();
    say('testing…');
    const t=await window.desktop.hubTest(url,token);
    if(!t.ok){ say('Couldn’t reach it: '+t.error,true); return; }
    const r=await window.desktop.hubSave({role:'client',url:url,token:token});
    if(!r.ok){ say(r.error,true); return; }
    $('hubToken').value='';
    refresh();
    await restart();
  });
  $('hubOffBtn').addEventListener('click',async function(){
    if(!confirm('Run the agent, mail and calendar work on this computer again? Turn the mini PC’s app off first, or both will do the work.'))return;
    await window.desktop.hubSave({role:null});
    refresh();
    await restart();
  });
  $('hubSendBtn').addEventListener('click',async function(){
    if(!confirm('Send this computer’s settings to the mini PC: calendar and Gmail sign-ins, AI keys, sync links, course feeds and what the agent has learned? It goes over Tailscale only.'))return;
    say('sending…');
    const r=await window.desktop.hubSendSettings();
    say(r.ok?'Sent. The mini PC has your settings now.':'Couldn’t send: '+r.error,!r.ok);
  });
}
