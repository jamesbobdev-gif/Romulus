/* Morning look-ahead (desktop only): main/look-ahead.js decides when it's due and asks Claude; here its
   proposals become Agent tasks waiting on the user ("needs you"). His reply starts the work like any
   other Agent task; deleting one skips it, and it isn't suggested again.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

if(window.desktop&&window.desktop.lookAheadTick){
  $('lookAheadSection').hidden=false;
  const laSay=function(st,r){
    if(!st.runner)return 'Off on this computer: the Agent runner is turned off here.';
    if(!st.enabled)return '';
    if(r&&r.error)return 'last run failed: '+r.error;
    if(r&&r.items)return r.added?r.added+' suggestion'+(r.added>1?'s':'')+' added to Agent.':'Nothing new needs doing right now.';
    if(r&&r.skipped&&r.skipped!=='not due'&&r.skipped!=='busy')return r.skipped+'.';
    if(st.error)return 'last run failed: '+st.error;
    return st.last?'Last looked '+fmtWhen(st.last)+(st.lastCount!=null?' · '+st.lastCount+' suggestion'+(st.lastCount===1?'':'s'):'')+'. Runs after '+fmtTime(st.at)+'.':'Runs after '+fmtTime(st.at)+'.';
  };
  const addProposals=function(items){
    const tombed={}; state.tombstones.forEach(function(x){ tombed[x.id]=1; });
    let added=0;
    (items||[]).forEach(function(p){
      if(!p||!p.id||tombed[p.id]||state.tasks.some(function(x){ return x.id===p.id; }))return;
      const note=p.note+'\n\nReply to have me start, or delete this to skip it.';
      const t={id:p.id,title:p.title,done:false,due:p.due||null,dueTime:null,tag:'look-ahead',ws:'agent',subs:[],googleEventId:null,
        created:Date.now(),status:'needs-you',note:note,reply:null,options:null,history:[]};
      agentSay(t,'sys','Morning look-ahead');
      agentSay(t,'claude',note);
      state.tasks.push(t);
      added++;
    });
    if(added)touch();
    return added;
  };
  const laTick=async function(force){
    try{
      const r=await window.desktop.lookAheadTick(!!force);
      if(r&&r.items)r.added=addProposals(r.items);
      if(force||(r&&(r.items||r.error)))$('lookAheadStatus').textContent=laSay(await window.desktop.lookAheadStatus(),r);
      return r;
    }catch(e){ $('lookAheadStatus').textContent='couldn’t run: '+e.message; }
  };
  window.desktop.lookAheadStatus().then(function(st){ $('lookAheadOn').checked=st.enabled; $('lookAheadStatus').textContent=laSay(st); }).catch(function(){});
  $('lookAheadOn').addEventListener('change',async function(){
    await window.desktop.lookAheadSetEnabled($('lookAheadOn').checked);
    $('lookAheadStatus').textContent=laSay(await window.desktop.lookAheadStatus());
  });
  $('lookAheadRun').addEventListener('click',async function(){
    if(!$('lookAheadOn').checked){ $('lookAheadStatus').textContent='Turn it on first.'; return; }
    $('lookAheadRun').disabled=true; $('lookAheadStatus').textContent='Looking ahead… (about a minute)';
    await laTick(true);
    $('lookAheadRun').disabled=false;
  });
  // two minutes after start (sync has loaded the lists by then), then every 15 minutes; main says when it's due
  setTimeout(laTick,2*60*1000); setInterval(laTick,15*60*1000);
}
