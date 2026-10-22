/* Settings → Local model: point the local lane at any Ollama (this computer by default), pick a model, done.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';
if(window.desktop&&window.desktop.localGet){
  $('localSection').hidden=false;
  const say=function(msg,isErr){ const n=$('localStatusLine'); n.textContent=msg||''; n.style.color=isErr?'var(--late)':'var(--muted)'; };
  $('ollamaLink').addEventListener('click',function(e){ e.preventDefault(); openExternal('https://ollama.com/download'); });
  let cur=null; // {url, model, enabled, configured, defaultUrl}
  const fillModels=function(models,running,pick){
    const sel=$('localModelSel'); sel.innerHTML='';
    models.forEach(function(m){ const o=document.createElement('option'); o.value=m; o.textContent=m+(running.indexOf(m)>=0?' (loaded)':''); sel.appendChild(o); });
    if(pick&&models.indexOf(pick)>=0)sel.value=pick; else if(running[0])sel.value=running[0];
    $('localModelRow').hidden=!models.length;
  };
  const probe=async function(url,quiet){
    if(!quiet)say('looking…');
    const r=await window.desktop.localProbe(url);
    if(!r.ok){ $('localModelRow').hidden=true; if(!quiet)say(r.error,true); return r; }
    fillModels(r.models,r.running,cur&&cur.model);
    say(r.models.length?r.models.length+' model'+(r.models.length===1?'':'s')+' at '+r.url+(cur&&cur.configured&&cur.url===r.url?' · in use: '+cur.model:''):'Ollama answered at '+r.url+', but has no models yet: run "ollama pull" one first');
    return r;
  };
  const draw=async function(){
    try{ cur=await window.desktop.localGet(); }catch(e){ return; }
    $('localUrl').value=cur.url||'';
    $('localOffBtn').hidden=!cur.configured;
    if(cur.configured){
      const s=await window.desktop.localStatus().catch(function(){ return null; });
      say(s&&s.online?'using '+cur.model+' at '+cur.url+(s.loaded?' (loaded)':s.installed?'':' · model not found there'):'using '+cur.model+' at '+cur.url+' · not answering right now');
    } else {
      // nothing set up: see whether Ollama is already running on this computer
      const r=await probe(cur.defaultUrl,true);
      if(r.ok)say(r.models.length?'Ollama is running on this computer with '+r.models.length+' model'+(r.models.length===1?'':'s')+': pick one':'Ollama is running here but has no models yet: run "ollama pull" one first');
      else say('Off. Install Ollama (link above), or type the address of a machine running it, then Find models.');
    }
  };
  $('localProbeBtn').addEventListener('click',function(){ probe($('localUrl').value.trim()||(cur&&cur.defaultUrl)); });
  $('localUrl').addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); $('localProbeBtn').click(); } });
  $('localSaveBtn').addEventListener('click',async function(){
    const model=$('localModelSel').value; if(!model)return;
    say('saving…');
    const r=await window.desktop.localSave({url:$('localUrl').value.trim()||(cur&&cur.defaultUrl),model:model});
    if(!r.ok){ say(r.error,true); return; }
    await draw(); if(typeof refreshLocalStatus==='function')refreshLocalStatus();
  });
  $('localOffBtn').addEventListener('click',async function(){
    const r=await window.desktop.localSave({enabled:false});
    if(!r.ok){ say(r.error,true); return; }
    $('localModelRow').hidden=true; await draw(); if(typeof refreshLocalStatus==='function')refreshLocalStatus();
  });
  draw();
}
