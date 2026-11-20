/* Settings → Get set up: the four things worth setting up on a computer, each shown as done or one button
   away. A private model (optional, and listed only where the hardware can run one: Local model → Set it up
   for me, local-model.js), calendar and email (the picker in
   connect-accounts.js), the Agent using websites (its browser is built in; it needs an AI to drive it), and
   running in the background (start at login, main/tray.js). Once the first AI key is saved, a fifth row says the
   keys are passwords and what to do if one gets out, until "Got it". The list goes away once everything on it is done.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';
const SETUP_ROWS=[
  // optional, and only listed on a computer that can run one; the button shows what it would install, it doesn't start
  { id:'local', title:'A private model on this computer', optional:true,
    todo:'Optional. Keeps private tasks on this computer.',
    done:'Your own model is answering.',
    btn:'See how',
    check:async function(){
      const s=await window.desktop.localStatus(); if(s&&s.configured&&s.online)return true;
      const i=await window.desktop.localSetupInfo(); return i&&i.fit&&i.fit.ok?false:null;
    },
    go:function(){ openSettingsAt('agentGroup','localSection'); } },
  { id:'cal', title:'Calendar and email',
    todo:'Events become to-dos.',
    done:'Connected.',
    btn:'Connect',
    check:async function(){ const o=await window.desktop.calOverview(false); return !!(o&&o.accounts&&o.accounts.some(function(a){ return !a.broken; })); },
    go:function(){ if(window.openConnect)window.openConnect(); else openSettingsAt('calGroup','gcalSection'); } },
  { id:'browser', title:'Let the Agent use websites',
    todo:'Needs an AI connected.',
    done:'Ready.',
    btn:'Connect an AI',
    check:async function(){ return !!window.agentAiReady; },
    go:function(){ openSettingsAt('agentGroup','aiSection'); } },
  // shows once the first AI key is in, and stays until it has been read
  { id:'keys', title:'Keep your keys private',
    todo:'Treat them like passwords. Leaked one? Make a new one.',
    done:'Done.',
    btn:'Got it',
    check:async function(){
      if(!window.agentAiReady)return null;
      try{ return localStorage.getItem('setupKeysRead')==='1'; }catch(e){ return true; }
    },
    go:function(){ try{ localStorage.setItem('setupKeysRead','1'); }catch(e){} } },
  { id:'bg', title:'Run in the background',
    todo:'Keeps tasks running on time.',
    done:'Starts when you log in.',
    btn:'Turn on',
    check:async function(){ const r=await window.desktop.loginGet(); return r&&r.can?!!r.on:null; }, // null: this copy can't (a dev run, Linux)
    go:async function(){ await window.desktop.loginSet(true); } }
];
let setupDrawing=false;
async function drawSetupList(){
  const box=$('setupList'); if(!box||!(window.desktop&&window.desktop.loginGet)||setupDrawing)return;
  setupDrawing=true;
  try{
    const states=await Promise.all(SETUP_ROWS.map(function(r){ return r.check().catch(function(){ return false; }); }));
    const rows=$('setupRows'); rows.innerHTML='';
    let left=0;
    SETUP_ROWS.forEach(function(r,i){
      const st=states[i]; if(st===null)return;
      if(!st&&!r.optional)left++; // the list goes once the rest is done: the local model is a choice, not a step
      const row=document.createElement('div'); row.className='setup-row'+(st?' done':'');
      const dot=document.createElement('span'); dot.className='setup-dot'; dot.setAttribute('aria-hidden','true');
      const text=document.createElement('div'); text.className='setup-text';
      const b=document.createElement('b'); b.textContent=r.title;
      const s=document.createElement('span'); s.textContent=st?r.done:r.todo;
      text.appendChild(b); text.appendChild(s);
      row.appendChild(dot); row.appendChild(text);
      if(!st){
        const btn=document.createElement('button'); btn.className='ghost mono'; btn.textContent=r.btn;
        btn.addEventListener('click',async function(){ btn.disabled=true; try{ await r.go(); }finally{ btn.disabled=false; setTimeout(drawSetupList,800); } });
        row.appendChild(btn);
      }
      rows.appendChild(row);
    });
    box.hidden=left===0;
  }finally{ setupDrawing=false; }
}
// a sign-in or install finishes in another window: look again on coming back
window.addEventListener('focus',function(){ if(!$('settingsPanel').hidden)drawSetupList(); });
