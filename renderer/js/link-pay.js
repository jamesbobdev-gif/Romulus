/* Settings → Agent features → Pay with Link (desktop only): connects his Stripe Link account
   (agent/link-wallet.js), so the Agent can pay at any card form with a one-time card he approves on his phone.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

if(window.desktop&&window.desktop.linkStatus){
  $('linkPaySection').hidden=false;
  let linkLoginUrl='';
  const linkDraw=function(st){
    if(!st)return;
    $('linkPayState').textContent=st.connected?'Connected'+(st.email?' as '+st.email:'')+(st.test?' · test mode':'')+'.':'Not connected.';
    $('linkPayConnect').hidden=!!st.connected;
    $('linkPayDisconnect').hidden=!st.connected;
    $('linkPayOptions').hidden=!st.connected;
    $('linkPayTest').checked=!!st.test;
    if(document.activeElement!==$('linkPayCap'))$('linkPayCap').value=st.capDollars;
    const lg=!st.connected&&st.login;
    $('linkPayLogin').hidden=!lg;
    if(lg){ $('linkPayCode').textContent=lg.userCode; linkLoginUrl=lg.url; }
    $('linkPayStatus').textContent=st.error||'';
  };
  const linkLoad=function(){ window.desktop.linkStatus().then(linkDraw).catch(function(){}); };
  $('linkPayConnect').addEventListener('click',async function(){
    $('linkPayStatus').textContent='opening Link…';
    let st=null; try{ st=await window.desktop.linkConnect(); }catch(e){ st={error:e.message}; }
    linkDraw(st);
    if(st&&st.ok)$('linkPayStatus').textContent='waiting for you in Link…';
  });
  $('linkPayOpen').addEventListener('click',function(e){ e.preventDefault(); if(linkLoginUrl)window.desktop.linkOpen(); });
  $('linkPayDisconnect').addEventListener('click',async function(){
    if(!confirm('Disconnect Link? The Agent will no longer be able to pay with Link cards.'))return;
    try{ linkDraw(await window.desktop.linkDisconnect()); }catch(e){ $('linkPayStatus').textContent=e.message; }
  });
  $('linkPayTest').addEventListener('change',async function(){
    try{ linkDraw(await window.desktop.linkSave({test:$('linkPayTest').checked})); }catch(e){}
  });
  $('linkPayCap').addEventListener('change',async function(){
    try{ linkDraw(await window.desktop.linkSave({capDollars:Number($('linkPayCap').value)})); $('linkPayStatus').textContent='saved'; }catch(e){}
    setTimeout(function(){ $('linkPayStatus').textContent=''; },2000);
  });
  if(window.desktop.onLinkChanged)window.desktop.onLinkChanged(function(st){ linkDraw(st); if(st&&st.connected&&!st.error)$('linkPayStatus').textContent='connected'; });
  linkLoad();
}
