/* Settings → AI connections: more than one account per AI (a second Claude plan, another ChatGPT plan, a
   spare Gemini or Groq key). Each extra account is an entry of its own in the order, so when one account
   runs out of usage the next one carries on. wiring.js's aiDraw draws these; h = {save, say, set} from there
   (save: a change to config.ai, set: a fresh status from the main process). Backed by agent/ai-accounts.js. */
const AI_ACCT_KEY={claude:'anthropicKey',gemini:'geminiKey',openai:'openaiKey',openrouter:'openrouterKey'};
const aiAcctKeyField=function(base){ return AI_ACCT_KEY[base]||base+'Key'; };
// the short line beside its name in the order; the "not ..." / "no key yet" ones mark it disconnected
function aiAccountStatusText(a){
  if(a.held)return 'out of usage until '+fmtWhen(a.held);
  if(a.base==='claude'){
    if(!a.installed)return 'not installed';
    if(a.hasKey)return 'API key '+a.key;
    return a.signedIn?'signed in'+(a.email?' as '+a.email:'')+(a.plan?' · '+a.plan:''):'not signed in'; }
  if(a.base==='openai'){
    if(a.via==='chatgpt')return a.codex&&a.codex.signedIn?'its own ChatGPT plan (via Codex)':'not signed in';
    return a.hasKey?'key '+a.key:'no key yet'; }
  return a.hasKey?'key '+a.key:'no key yet';
}
// the inside of an extra account's card: its name, its own sign-in or key, and Remove
function aiAccountCard(box,a,h,mainName){
  const row=function(top){ const r=el('div','settings-row'); r.style.marginTop=(top||8)+'px'; box.appendChild(r); return r; };
  const btn=function(r,cls,text,fn){ const b=el('button',cls,text); b.addEventListener('click',function(){ fn(b); }); r.appendChild(b); return b; };
  const hint=function(text){ const p=el('p','settings-hint',text); p.style.margin='8px 0 0'; box.appendChild(p); return p; };
  // a button that waits on the main process, then redraws with what came back
  const run=async function(b,busyText,call,okText){
    const was=b.textContent; b.disabled=true; b.textContent=busyText;
    try{ const res=await call(); if(res&&res.status)h.set(res.status); h.say(res&&res.ok===false?'didn’t work: '+(res.error||'unknown'):okText); }
    catch(e){ h.say('didn’t work'); }
    if(b.isConnected){ b.disabled=false; b.textContent=was; }
  };
  const keyRow=function(ph){
    const r=row(); const k=el('input','settings-inp'); k.type='password'; k.placeholder=ph; k.autocomplete='off'; k.style.cssText='flex:1;margin:0';
    r.appendChild(k);
    btn(r,'ghost mono',a.hasKey?'Replace':'Save key',function(){ const v=k.value.trim(); if(!v)return; const c={account:a.id}; c[aiAcctKeyField(a.base)]=v; h.save(c,'key saved'); });
    if(a.hasKey)btn(r,'ghost mono','Remove key',function(){ const c={account:a.id}; c[aiAcctKeyField(a.base)]=''; h.save(c,'key removed'); });
    return r;
  };
  // its own name, so the order, the logs and the notes tell the accounts apart
  const nr=row();
  const ni=el('input','settings-inp'); ni.placeholder='a name for it, e.g. Work (optional)'; ni.value=a.label||''; ni.maxLength=40; ni.style.cssText='flex:1;margin:0';
  nr.appendChild(ni);
  btn(nr,'ghost mono','Save name',function(){ h.save({account:a.id,label:ni.value.trim()},'name saved'); });
  if(a.base==='claude'){
    if(!a.installed)hint('Install Claude Code on the main Claude card first, then sign in here.');
    else{
      const r=row();
      if(a.signedIn&&!a.hasKey){ const ok=el('span','','Signed in'+(a.email?' as '+a.email:'')); ok.style.cssText='font-size:13px;flex:1'; r.appendChild(ok); }
      btn(r,a.ready?'ghost mono':'btn-accent',a.signedIn?'Sign in again':'Sign in to this Claude account',function(b){
        run(b,'finish signing in in the window that opened…',function(){ return window.desktop.aiClaudeLogin(a.id); },'signed in'); });
      if(a.ready)btn(r,'ghost mono','Check',async function(){ h.say('asking Claude…');
        const res=await window.desktop.aiClaudeCheck(a.id); h.say(res.ok?'Claude answered'+(res.model?' ('+res.model+')':''):'didn’t work: '+res.error); });
      keyRow(a.hasKey?'replace this account’s Anthropic API key':'or an Anthropic API key for this account');
      hint('A window opens to sign in. Use the other Claude account there: if the browser opens on the one you already added, sign out of claude.ai in the browser first.');
    }
  } else if(a.base==='openai'){
    const r=row();
    if(a.via==='chatgpt'){
      if(!a.codex||!a.codex.installed){ const p=el('span','','Install Codex on the main ChatGPT card first, then sign in here.'); p.style.cssText='font-size:13px;flex:1'; r.appendChild(p); }
      else{
        if(a.codex.signedIn){ const ok=el('span','','Signed in with ChatGPT'); ok.style.cssText='font-size:13px;flex:1'; r.appendChild(ok); }
        btn(r,a.codex.signedIn?'ghost mono':'btn-accent',a.codex.signedIn?'Sign in again':'Sign in with this ChatGPT account',function(b){
          run(b,'finish signing in in your browser…',function(){ return window.desktop.aiCodexLogin(a.id); },'signed in'); });
      }
      btn(row(4),'ghost mono','Use an API key instead',function(){ h.save({account:a.id,openaiVia:'key'}); });
      hint('Runs on this account’s own ChatGPT plan. If the browser signs in to the account you already added, sign out of chatgpt.com there first.');
    } else {
      r.remove(); keyRow(a.hasKey?'replace this account’s OpenAI API key':'OpenAI API key (platform.openai.com/api-keys)');
      btn(row(4),'ghost mono','Use a ChatGPT plan instead',function(){ h.save({account:a.id,openaiVia:'chatgpt'}); });
    }
  } else if(a.base==='openrouter'){
    if(!a.hasKey){ const r=row();
      btn(r,'btn-accent','Connect with OpenRouter ↗',function(b){ run(b,'finish in your browser…',function(){ return window.desktop.aiOpenRouterConnect(a.id); },'OpenRouter connected'); }); }
    keyRow(a.hasKey?'replace this account’s OpenRouter key':'or paste an OpenRouter key (openrouter.ai/keys)');
    if(a.hasKey)btn(row(4),'ghost mono','Test key',async function(){ h.say('checking…'); const res=await window.desktop.aiOpenRouterCheck(a.id); h.say(res.ok?'key works':'key failed: '+res.error); });
  } else {
    keyRow(a.hasKey?'replace this account’s '+mainName+' API key':mainName+' API key for this account');
    if(a.hasKey&&a.base!=='gemini')btn(row(4),'ghost mono','Test key',async function(){ h.say('checking…'); const res=await window.desktop.aiCompatCheck(a.id); h.say(res.ok?'key works · '+res.count+' models':'key failed: '+res.error); });
  }
  hint('Uses the same model and settings as the main '+mainName+' card. When one account is out of usage, the next one in the order takes over.');
  // two presses, since its sign-in or key goes with it
  const rr=row(6);
  btn(rr,'ghost mono','Remove this account',function(b){
    if(b.dataset.sure!=='1'){ b.dataset.sure='1'; b.textContent='Press again to remove it (its sign-in and key are deleted)'; return; }
    run(b,'removing…',function(){ return window.desktop.aiAccountRemove(a.id); },'account removed'); });
}
// at the bottom of a main AI's card: one more account of it
function aiAddAccountRow(box,base,mainName,h){
  const r=el('div','settings-row'); r.style.marginTop='8px';
  const b=el('button','ghost mono','+ Add another '+mainName+' account');
  b.title='A second account joins the order: when one runs out, the other carries on';
  b.addEventListener('click',async function(){ b.disabled=true;
    try{ const res=await window.desktop.aiAccountAdd(base); if(res&&res.status)h.set(res.status); h.say(res&&res.ok?'added: set it up in its card below':'couldn’t add: '+((res&&res.error)||'unknown')); }
    catch(e){ h.say('couldn’t add'); b.disabled=false; } });
  r.appendChild(b); box.appendChild(r);
}
