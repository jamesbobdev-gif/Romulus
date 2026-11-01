/* The installed app's update prompt (main/updater.js decides; this only shows it). When a new version is out
   the window shows "Romulus 1.0.9 is out" with Not now / Update, like the phone's banner (mobile/update-phone.js).
   Update downloads it, then the bar offers Restart now; Later lets it install on quit or when idle.
   The answer goes to his other devices (update-sync.js), and theirs comes here: an Update said on the phone
   or another computer downloads it here without asking, a Not now there takes the bar away here.
   Settings → Updates: "Ask me" (the default) or "Automatically". The phone has no window.desktop, so none of this runs there. */
(function(){
  if(!window.desktop||!window.desktop.updateState)return;
  let bar=null, hiddenFor=null; // hiddenFor: the 'ready' version he said Later to, so the bar stays away until the next one

  function button(text,cls,onclick){ const b=document.createElement('button'); b.className=cls; b.textContent=text; b.onclick=onclick; return b; }
  function close(){ if(bar){ bar.remove(); bar=null; } }

  function show(s){
    if(!s||s.state==='none'||(s.state==='ready'&&hiddenFor===s.version)){ close(); return; }
    if(!bar){
      bar=document.createElement('div');
      bar.id='desktopUpdateBar';
      bar.setAttribute('role','status');
      bar.style.cssText='position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:9999;width:min(460px,calc(100% - 24px));'+
        'display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:var(--surface,#fff);'+
        'color:var(--ink,#161616);border:1px solid var(--hairline,#E9E9E5);box-shadow:0 6px 24px rgba(0,0,0,.18);font-size:14px';
      document.body.appendChild(bar);
    }
    bar.textContent='';
    const text=document.createElement('span');
    text.style.flex='1';
    bar.appendChild(text);
    if(s.state==='offered'){
      text.textContent='Romulus '+s.version+' is out';
      bar.appendChild(button('Not now','ghost mono',function(){ updateChoiceWrite('no',s.version); window.desktop.updateSkip().then(show).catch(close); }));
      bar.appendChild(button('Update','btn-accent',function(){ updateChoiceWrite('yes',s.version); window.desktop.updateAccept().then(show).catch(close); }));
    }else if(s.state==='downloading'){
      text.textContent='Downloading Romulus '+s.version+(s.percent?' · '+s.percent+'%':'…');
    }else if(s.state==='ready'){
      text.textContent='Romulus '+s.version+' is ready';
      bar.appendChild(button('Later','ghost mono',function(){ hiddenFor=s.version; close(); }));
      bar.appendChild(button('Restart now','btn-accent',function(){ window.desktop.updateInstall().catch(function(){}); }));
    }
  }

  // what he answered on his other devices; checked when a version is offered here, and every 15 minutes
  // (so a yes on the phone reaches a computer that hasn't looked for updates yet)
  function follow(){ updateChoiceRead().then(function(doc){ if(doc)window.desktop.updateShared(doc).then(show).catch(function(){}); }); }
  window.desktop.onUpdateState(function(s){ show(s); if(s&&s.state==='offered')follow(); });
  window.desktop.updateState().then(show).catch(function(){});
  setTimeout(follow,20*1000);
  setInterval(follow,15*60*1000);

  // Settings → Updates
  const sel=document.getElementById('updateMode');
  if(sel){
    document.getElementById('updateSection').hidden=false;
    window.desktop.updateGetMode().then(function(m){ sel.value=m; }).catch(function(){});
    sel.addEventListener('change',function(){ window.desktop.updateSetMode(sel.value).then(function(m){ sel.value=m; }).catch(function(){}); });
  }
})();
