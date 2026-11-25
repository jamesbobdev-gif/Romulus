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
    $('localEasy').hidden=!!cur.configured;
    $('localWorkerRow').hidden=!cur.configured&&!cur.worker; $('localWorkerOn').checked=!!cur.worker;
    window.localWorkerHere=!!cur.worker;
    if(cur.configured){
      const s=await window.desktop.localStatus().catch(function(){ return null; });
      if(s&&s.via==='worker'){ say(s.name+' is taking local tasks for all your devices'+(s.model?' ('+s.model+')':'')+(s.busy?' · working on one now':'')); return; }
      say(s&&s.online?'using '+cur.model+' at '+cur.url+(s.loaded?' (loaded)':s.installed?'':' · model not found there'):'using '+cur.model+' at '+cur.url+' · not answering right now');
    } else {
      // nothing set up: see whether Ollama is already running on this computer
      const r=await probe(cur.defaultUrl,true);
      if(r.ok)say(r.models.length?'Ollama is running on this computer with '+r.models.length+' model'+(r.models.length===1?'':'s')+': pick one':'Ollama is running here but has no models yet: run "ollama pull" one first');
      else{
        // the model's own computer may be taking local tasks for every device: then nothing is needed here
        const s=await window.desktop.localStatus().catch(function(){ return null; });
        if(s&&s.via==='worker')say(s.name+' is taking local tasks for all your devices'+(s.model?' ('+s.model+')':'')+'. Nothing to set up here.');
        else say('Off. Install Ollama (link above), or type the address of a machine running it, then Find models.');
      }
    }
  };
  $('localWorkerOn').addEventListener('change',async function(){
    const on=$('localWorkerOn').checked;
    const r=await window.desktop.localWorker(on);
    if(!r.ok){ $('localWorkerOn').checked=!on; say(r.error,true); return; }
    await draw(); if(typeof refreshLocalStatus==='function')refreshLocalStatus();
  });
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
  /* Set it up for me (agent/ollama-setup.js): Ollama running on this computer (started, or installed on
     Windows), a model that fits its memory (downloaded here with a progress bar if it has none), switched on. */
  const easy=$('localEasyBtn'), note=function(t){ $('localEasyNote').textContent=t||''; };
  const gb=function(b){ return (b/1024/1024/1024).toFixed(1)+' GB'; };
  // only offered where it can run: enough memory and disk (agent/ollama-setup.js hardwareFit)
  window.desktop.localSetupInfo().then(function(i){
    if(i.fit&&!i.fit.ok){ easy.disabled=true; note(i.fit.why+' A computer that can run one can take local tasks for this one: set it up there and turn on Run local tasks here.'); return; }
    note((i.running?'Ollama is running here.':i.installed?'Ollama is installed; this starts it.':i.canInstall?'Installs Ollama and a '+i.suggest.model+' model ('+i.suggest.sizeGb+' GB) for this computer’s '+i.ramGb+' GB of memory.':'Opens Ollama’s download page; press this again once it’s installed.')+(i.fit&&i.fit.why?' '+i.fit.why:''));
  }).catch(function(){});
  window.desktop.onLocalPullProgress(function(p){
    const bar=$('localPullBar'); bar.hidden=false;
    const pct=p.total?Math.min(100,Math.round(p.done/p.total*100)):0;
    $('localPullFill').style.width=pct+'%';
    note(p.total?'Downloading '+p.model+': '+gb(p.done)+' of '+gb(p.total):(p.status||'Downloading '+p.model+'…'));
  });
  const setUp=async function(){
    easy.disabled=true;
    try{
      note('Getting Ollama going…');
      const inst=await window.desktop.localInstall();
      if(!inst.ok){ note(inst.error); return; }
      const info=await window.desktop.localSetupInfo();
      const r=await window.desktop.localProbe(info.url);
      if(!r.ok){ note(r.error); return; }
      // a model it already has: the suggested one, else the one loaded, else the first
      let model=r.models.indexOf(info.suggest.model)>=0?info.suggest.model:(r.running[0]||r.models[0]);
      if(!model){
        note('Downloading '+info.suggest.model+' ('+info.suggest.sizeGb+' GB)…');
        const p=await window.desktop.localPull(info.suggest.model);
        if(!p.ok){ note('The download stopped: '+p.error+'. Press again to pick up where it left off.'); return; }
        model=info.suggest.model;
      }
      const s=await window.desktop.localSave({url:info.url,model:model});
      if(!s.ok){ note(s.error); return; }
      $('localPullBar').hidden=true;
      note('Done: '+model+' is on.');
      await draw(); if(typeof refreshLocalStatus==='function')refreshLocalStatus();
      if(typeof drawSetupList==='function')drawSetupList();
    }catch(e){ note('Something went wrong: '+(e&&e.message||e)); }
    finally{ easy.disabled=false; }
  };
  easy.addEventListener('click',setUp);
  window.localEasySetup=setUp; // the setup list at the top of Settings
  draw();
}
