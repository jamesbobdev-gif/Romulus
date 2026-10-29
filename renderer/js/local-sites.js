/* The local model's sites, kept up on their own (agent/local-sites.js). Desktop only: the local lane says
   which sites a run reached ('local:sites-seen' → added to the routing row's sites) and which it was refused
   ('local:site-ask' → a to-do on the Human list). Checking that to-do off allows the site, and the task
   that wanted it goes again. Deleting the to-do is a no.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

const SITE_ASK_PREFIX='Allow the local model on ';
const siteClean=function(s){ return String(s||'').trim().replace(/^https?:\/\//i,'').replace(/^\*\./,'').replace(/\/.*$/,'').replace(/^www\./,'').toLowerCase(); };
function siteAskHost(t){ const x=String(t&&t.title||''); return taskWs(t)==='personal'&&x.startsWith(SITE_ASK_PREFIX)?siteClean(x.slice(SITE_ASK_PREFIX.length).split('?')[0]):null; }
// the routing row's sites with these added (a site covers its subdomains) → true when something was added
async function localSitesAdd(hosts){
  const p=(typeof routingProfile==='function')?routingProfile():null; if(!p)return false;
  let d=null; try{ d=await syncPull(p); }catch(e){ return false; }
  if(!d||!Array.isArray(d.rules))d=Object.assign({},(typeof ROUTING_START!=='undefined')?ROUTING_START:{v:2,default:'auto',rules:[]});
  const sites=(Array.isArray(d.sites)?d.sites:[]).map(siteClean).filter(Boolean);
  let added=0;
  (hosts||[]).map(siteClean).forEach(function(h){
    if(!h||h.indexOf('.')===-1||sites.some(function(s){ return h===s||h.endsWith('.'+s); }))return;
    sites.push(h); added++;
  });
  if(!added)return false;
  await syncPushDoc(p,Object.assign({},d,{v:2,sites:sites}));
  if(window.desktop&&window.desktop.routingChanged)window.desktop.routingChanged();
  if(typeof routingLoad==='function'&&!$('settingsPanel').hidden)routingLoad().catch(function(){});
  return true;
}
// he checked the to-do off: the site is allowed, and the task that wanted it goes again
function siteAskAllowed(host){
  localSitesAdd([host]).then(function(){
    let changed=false;
    state.tasks.forEach(function(x){
      if(taskWs(x)!=='agent'||x.done||x.status!=='needs-you')return;
      if(!(x.history||[]).some(function(h){ return h.siteWant===host; }))return;
      x.status='queued'; x.stuck=null; x.shot=null; agentSay(x,'sys',host+' is allowed now: going again'); changed=true;
    });
    voiceToast('The local model may open '+host+' now',true);
    if(changed)touch();
  }).catch(function(e){ voiceToast('Couldn’t allow '+host+': '+e.message,true); });
}
if(window.desktop&&window.desktop.onLocalSitesSeen){
  window.desktop.onLocalSitesSeen(function(p){ const hosts=Array.isArray(p&&p.hosts)?p.hosts:[]; if(hosts.length)localSitesAdd(hosts).catch(function(){}); });
  window.desktop.onLocalSiteAsk(function(p){
    const hosts=Array.isArray(p&&p.hosts)?p.hosts.map(siteClean).filter(Boolean):[]; if(!hosts.length)return;
    let added=0;
    hosts.forEach(function(h){
      if(state.tasks.some(function(t){ return !t.done&&siteAskHost(t)===h; }))return;
      const title=SITE_ASK_PREFIX+h+'? Check this off to let it open that site'+(p.title?' (for “'+String(p.title).replace(/\s+/g,' ').slice(0,60)+'”)':'');
      state.tasks.push({id:uid(),title:title,done:false,due:null,dueTime:null,tag:null,ws:'personal',subs:[],googleEventId:null,created:Date.now()});
      voiceToast(title,true); added++;
    });
    if(added)touch();
  });
}
