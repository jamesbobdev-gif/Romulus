/* Wiring the page up: buttons and inputs, search, keyboard navigation.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── wiring ── */
$('addBtn').addEventListener('click',addTask);
if(window.desktop&&window.desktop.openAgentBrowser){
  $('agentBrowserSection').hidden=false;
  // it has no window of its own (headless): open it in the live view, which starts it if needed
  $('agentBrowserBtn').addEventListener('click',function(){ $('agentBrowserStatus').textContent=''; openLiveView(); });
}
/* AI connections (desktop only): Claude / Gemini / ChatGPT / OpenRouter / Grok / Groq / Cloudflare / NVIDIA for the cloud Agent lane, in his order */
// where each free-tier AI's key comes from, and what it does with what's sent (their terms, Oct 2026)
const COMPAT_INFO={
  xai:{where:'console.x.ai',url:'https://console.x.ai',note:'xAI doesn’t train on API data unless you join its data-sharing program for extra free credits.'},
  cloudflare:{where:'account ID + API token, from Workers AI → Use REST API',url:'https://dash.cloudflare.com/?to=/:account/ai/workers-ai',label:'Cloudflare account ID and API token (paste both)',note:'Free: 10,000 “neurons” a day, roughly 10–30 tasks, reset at 8 pm Eastern. Paste the account ID and the token together, with a space between. Cloudflare doesn’t train on what’s sent.'},
  groq:{where:'console.groq.com/keys',url:'https://console.groq.com/keys',note:'Very fast, but the free tier caps tokens per minute, so a big task can be too large for it. Groq doesn’t train on what’s sent.'},
  nvidia:{where:'build.nvidia.com → Get API Key',url:'https://build.nvidia.com/settings/api-keys',note:'Free for trying its models: about 40 requests a minute (it may ask to verify a phone number). It’s a trial, so NVIDIA doesn’t promise not to keep what’s sent; private tasks never go to cloud AIs anyway.'},
};
if(window.desktop&&window.desktop.aiStatus){
  $('aiSection').hidden=false; $('aiUsage').hidden=false;
  let ai=null;
  const say=function(t){ $('aiStatusLine').textContent=t||''; if(t)setTimeout(function(){ if($('aiStatusLine').textContent===t)$('aiStatusLine').textContent=''; },4000); };
  const save=async function(change,msg){
    Object.keys(change).forEach(function(k){ if(/Key$/.test(k)){ delete modelLists[k.slice(0,-3)]; delete keyBad[k.slice(0,-3)]; } }); // a new key: ask for its models again
    try{ ai=await window.desktop.aiSave(change); aiDraw(); say(msg||'saved'); }catch(e){ say('save failed'); } };
  // the Agent tab's "Connect free" button (welcome.js): OpenRouter's sign-in, then switched on → {ok, error}
  window.quickConnectAi=async function(){
    const res=await window.desktop.aiOpenRouterConnect(); ai=res.status; aiDraw(); return res;
  };
  const keyRow=function(ph,saveAs,label){
    const r=el('div','settings-row'); r.style.marginTop='8px';
    const k=el('input','settings-inp'); k.type='password'; k.placeholder=ph; k.style.flex='1'; k.style.margin='0'; k.autocomplete='off';
    const b=el('button','ghost mono',label||'Save key');
    b.addEventListener('click',function(){ const v=k.value.trim(); if(!v)return; const c={}; c[saveAs]=v; save(c,'key saved'); });
    r.appendChild(k); r.appendChild(b); return r;
  };
  /* a model menu: Auto (the best one that AI has right now, falling back when it's busy or used up), its models
     best first, or Other… to type one. listId: whose models to ask for; saveAs: the setting it saves to */
  const modelLists={}; // listId → its models, asked once per Settings visit (again after a new key)
  const OTHER='\u0000other';
  const modelRow=function(listId,saveAs,current,autoValue){
    const r=el('div','settings-row'); r.style.marginTop='4px';
    const sel=document.createElement('select'); sel.className='settings-inp'; sel.style.cssText='flex:1;margin:0;min-width:0';
    const used=ai.used&&ai.used[listId==='codex'?'codex':listId];
    const add=function(v,t){ const o=document.createElement('option'); o.value=v; o.textContent=t; sel.appendChild(o); };
    const fill=function(list){
      sel.innerHTML='';
      add('','Auto: best available'+(used?' (last used '+used+')':''));
      (list||[]).forEach(function(m){ if(m!==autoValue)add(m,m); });
      if(current&&current!==autoValue&&(list||[]).indexOf(current)<0)add(current,current);
      add(OTHER,'Other…');
      sel.value=current&&current!==autoValue?current:'';
    };
    fill(modelLists[listId]);
    const other=el('input','settings-inp'); other.placeholder='model name'; other.style.cssText='flex:1;margin:0'; other.hidden=true;
    const ob=el('button','ghost mono','Save'); ob.hidden=true;
    ob.addEventListener('click',function(){ const v=other.value.trim(); if(!v)return; const c={}; c[saveAs]=v; save(c,'model saved'); });
    sel.addEventListener('change',function(){
      if(sel.value===OTHER){ other.hidden=false; ob.hidden=false; other.focus(); return; }
      const c={}; c[saveAs]=sel.value||(autoValue||''); save(c,sel.value?'model saved':'model: Auto');
    });
    r.appendChild(sel); r.appendChild(other); r.appendChild(ob);
    if(!modelLists[listId]){ modelLists[listId]=[];
      window.desktop.aiModels(listId).then(function(res){ modelLists[listId]=(res&&res.models)||[]; if(sel.isConnected&&sel.value!==OTHER)fill(modelLists[listId]); }).catch(function(){}); }
    return r;
  };
  const statusText=function(id){
    if(id==='claude'){ const c=ai.claude||{};
      if(!c.installed)return 'not installed';
      if(!c.ready)return 'not signed in';
      if(ai.claudeBlockedUntil)return 'out of usage until '+fmtWhen(ai.claudeBlockedUntil);
      return c.via==='key'?'API key '+c.key:'signed in'+(c.email?' as '+c.email:'')+(c.plan?' · '+c.plan:''); }
    if(id==='gemini'){ const g=ai.gemini;
      if(!g.hasKey)return 'needs an API key';
      return 'API key '+g.key+(g.installed?' · CLI (browser)':' · API (search only)'); }
    if(id==='openai'){ const g=ai.openai;
      if(g.via==='chatgpt')return g.codex.signedIn?'your ChatGPT plan (via Codex)':'not signed in';
      return g.hasKey?'key '+g.key+' · '+(g.model||'Auto'):'no key yet'; }
    const o=ai[id]; return o.hasKey?'key '+o.key+' · '+(o.model&&o.model!=='openrouter/auto'?o.model:'Auto'):'no key yet';
  };
  /* an AI that stopped working (key expired, sign-in ran out, credits gone): the runner's open "Reconnect X:" to-do
     on his Human list, or a failed Test key. Its card says so, with a button to the site to fix it */
  const keyBad={}; // id → why, from Test key
  const SITE={gemini:['Google AI Studio','https://aistudio.google.com/apikey'],openai:['OpenAI','https://platform.openai.com/api-keys'],
    openrouter:['OpenRouter','https://openrouter.ai/keys']};
  const siteFor=function(id){
    if(id==='openai'&&ai.openai.via==='chatgpt')return ['ChatGPT','https://chatgpt.com'];
    if(SITE[id])return SITE[id];
    const info=COMPAT_INFO[id]; return info?[ai.names[id],info.url]:null; // Claude's fix is claude /login in a terminal
  };
  const brokenWhy=function(id){
    if(keyBad[id])return keyBad[id];
    const prefix='Reconnect '+ai.names[id]+':';
    const t=(typeof state!=='undefined'&&state.tasks||[]).find(function(x){ return !x.done&&taskWs(x)==='personal'&&x.title.startsWith(prefix); });
    return t?t.title.slice(prefix.length).trim():null;
  };
  // the runner flagged one (or it answered again): redraw once agent-results.js has added or checked off the to-do
  const redrawSoon=function(){ setTimeout(function(){ if(ai)aiDraw(); },0); };
  if(window.desktop.onAgentReconnect)window.desktop.onAgentReconnect(redrawSoon);
  if(window.desktop.onAgentReconnected)window.desktop.onAgentReconnected(function(p){ const id=p&&p.id; if(id)delete keyBad[id]; redrawSoon(); });
  function aiDraw(){
    usageDraw();
    // the Agent tab's "Pick an AI" card and nudge (welcome.js) follow this
    const readyNow=!!(ai&&ai.ready);
    if(window.agentAiReady!==readyNow){ window.agentAiReady=readyNow; if(typeof render==='function')render(); }
    const list=$('aiList'); list.innerHTML='';
    ai.order.forEach(function(p,i){
      const box=el('div',''); box.style.cssText='border:1px solid var(--hairline);border-radius:10px;padding:10px 12px;margin-bottom:8px';
      // switched on but it can't be used: listed at the top of Settings
      const why=statusText(p.id);
      if(p.on&&/^(not installed|not signed in|needs an API key|no key yet)$/.test(why))box.dataset.disconnected=ai.names[p.id]+': '+why;
      const head=el('div','settings-row'); head.style.marginTop='0';
      const sw=el('label','switch'); const cb=document.createElement('input'); cb.type='checkbox'; cb.checked=p.on;
      sw.appendChild(cb); const tr=el('span','track'); tr.setAttribute('aria-hidden','true'); sw.appendChild(tr);
      sw.appendChild(el('span','',(i+1)+'. '+ai.names[p.id]));
      cb.addEventListener('change',function(){ const o=ai.order.map(function(x){ return {id:x.id,on:x.id===p.id?cb.checked:x.on}; }); save({order:o}); });
      head.appendChild(sw);
      const st=el('span','mono',statusText(p.id)); st.style.cssText='font-size:11px;color:var(--muted);flex:1;text-transform:none;letter-spacing:0';
      head.appendChild(st);
      if(i>0){ const up=el('button','ghost mono','↑'); up.title='Try this one earlier';
        up.addEventListener('click',function(){ const o=ai.order.slice(); o.splice(i-1,0,o.splice(i,1)[0]); save({order:o}); }); head.appendChild(up); }
      box.appendChild(head);
      const broke=!box.dataset.disconnected&&brokenWhy(p.id);
      if(broke){
        if(p.on)box.dataset.disconnected=ai.names[p.id]+': disconnected';
        const w=el('div','settings-row'); w.style.cssText='margin-top:6px;align-items:center';
        const m=el('span','','⚠ Disconnected: '+broke); m.style.cssText='flex:1;font-size:13px;color:var(--late)';
        w.appendChild(m);
        const site=siteFor(p.id);
        if(site){ const go=el('button','ghost mono','Open '+site[0]+' ↗'); go.addEventListener('click',function(){ openExternal(site[1]); }); w.appendChild(go); }
        box.appendChild(w);
      }
      if(p.id==='claude'){
        const c=ai.claude||{};
        const busy=function(b,t){ b.disabled=true; b.textContent=t; };
        if(!c.installed){
          // step 1: Claude Code itself (the official installer; no Node needed)
          const how=el('p','settings-hint','Claude runs through Claude Code, a small program from Anthropic. Install it, then sign in with your Claude account (Pro or Max) or paste an Anthropic API key.'); how.style.margin='8px 0 0'; box.appendChild(how);
          const r=el('div','settings-row'); r.style.marginTop='8px';
          const b=el('button','btn-accent','Install Claude Code');
          b.addEventListener('click',async function(){ busy(b,'installing… (a minute or two)');
            try{ const res=await window.desktop.aiClaudeInstall(); ai=res.status; aiDraw(); say(res.ok?'installed: now sign in':'install failed: '+res.error); }
            catch(e){ say('install failed'); b.disabled=false; b.textContent='Install Claude Code'; } });
          r.appendChild(b);
          const already=el('button','ghost mono','I already have it'); already.title='Look again for claude on this computer';
          already.addEventListener('click',async function(){ say('looking…'); try{ ai=await window.desktop.aiClaudeRefresh(); aiDraw(); say(ai.claude.installed?'found it':'still not found: is claude on your PATH?'); }catch(e){ say('couldn’t check'); } });
          r.appendChild(already); box.appendChild(r);
        } else {
          // step 2: a sign-in (the usual way) or an API key
          const r=el('div','settings-row'); r.style.marginTop='8px';
          if(c.signedIn&&c.via!=='key'){ const ok=el('span','','✓ Signed in'+(c.email?' as '+c.email:'')); ok.style.cssText='font-size:13px;flex:1'; r.appendChild(ok); }
          const b=el('button',c.ready?'ghost mono':'btn-accent',c.signedIn?'Sign in again':'Sign in to Claude');
          b.addEventListener('click',async function(){ busy(b,'finish signing in in the window that opened…');
            try{ const res=await window.desktop.aiClaudeLogin(); ai=res.status; aiDraw(); say(res.ok?'signed in':'sign-in failed: '+res.error); }
            catch(e){ say('sign-in failed'); b.disabled=false; } });
          r.appendChild(b);
          if(c.ready){ const t=el('button','ghost mono','Check'); t.addEventListener('click',async function(){ say('asking Claude…');
            const res=await window.desktop.aiClaudeCheck(); say(res.ok?'Claude answered'+(res.model?' ('+res.model+')':''):'didn’t work: '+res.error); }); r.appendChild(t); }
          box.appendChild(r);
          box.appendChild(modelRow('claude','claudeModel',ai.claudeModel));
          // the key: for people without a Claude plan; it wins over the sign-in when both are there
          box.appendChild(keyRow(c.hasKey?'replace Anthropic API key ('+c.key+')':'or an Anthropic API key (console.anthropic.com)','anthropicKey',c.hasKey?'Replace':'Save key'));
          const kr=el('div','settings-row'); kr.style.marginTop='4px';
          if(c.hasKey){ const rm=el('button','ghost mono','Remove key (use the sign-in)'); rm.addEventListener('click',function(){ save({anthropicKey:''},'key removed'); }); kr.appendChild(rm); }
          else { const g=el('button','ghost mono','Get an API key ↗'); g.addEventListener('click',function(){ openExternal('https://console.anthropic.com/settings/keys'); }); kr.appendChild(g); }
          box.appendChild(kr);
          box.appendChild(el('p','settings-hint',c.hasKey?'Runs are billed to this API key, pay as you go. Remove it to use your Claude plan instead.':'Signed in, runs count against your Claude plan’s usage. An API key is billed separately, pay as you go.'));
          box.lastChild.style.margin='8px 0 0';
        }
      }
      if(p.id==='gemini'){
        const g=ai.gemini;
        // unlike Claude, Gemini can't use a Google sign-in any more (Google ended that for personal accounts), so walk him through the key
        if(!g.hasKey){
          const how=el('div','settings-hint'); how.style.margin='8px 0 0';
          how.appendChild(el('p','','Gemini needs a free API key. Google no longer lets personal accounts sign in like Claude does.')); how.lastChild.style.margin='0';
          const ol=document.createElement('ol'); ol.style.cssText='margin:6px 0 0;padding-left:20px';
          ['Open Google AI Studio (button below) and sign in with your Google account.',
           'Click “Create API key”, then copy it. No card is needed.',
           'Paste it in the box below and press Save key.',
           'Optional: turn on billing for the key so Google doesn’t use your tasks. You only pay for what you use, usually pennies.'
          ].forEach(function(t){ ol.appendChild(el('li','',t)); });
          how.appendChild(ol);
          const ob=el('button','ghost mono','Open Google AI Studio ↗'); ob.style.marginTop='6px';
          ob.addEventListener('click',function(){ openExternal('https://aistudio.google.com/apikey'); });
          how.appendChild(ob);
          box.appendChild(how);
        }
        box.appendChild(keyRow(g.hasKey?'replace Gemini API key':'Gemini API key (aistudio.google.com/apikey)','geminiKey'));
        if(g.hasKey)box.appendChild(modelRow('gemini','geminiModel',g.model));
        // the CLI is optional: it gives Gemini the agent browser and your photos; without it, Google Search only
        if(!g.installed){
          const r=el('div','settings-row'); r.style.marginTop='8px';
          const b=el('button','ghost mono','Install Gemini CLI (optional: adds the browser)');
          b.addEventListener('click',async function(){ b.disabled=true; b.textContent='installing… (a minute or two)';
            try{ const res=await window.desktop.aiGeminiInstall(); ai=res.status; aiDraw(); say(res.ok?'installed':'install failed: '+res.error); }
            catch(e){ say('install failed'); b.disabled=false; } });
          r.appendChild(b); box.appendChild(r);
        }
        // Google's terms: free-tier prompts may be used to improve its models and read by people; paid ones aren't
        const gw=el('p','settings-hint','⚠️ Use a key with billing turned on. On a free key, Google may use your tasks to improve its models and people may read them. On a paid key it doesn’t.');
        gw.style.margin='8px 0 0'; box.appendChild(gw);
      }
      if(p.id==='openai'){
        const g=ai.openai, cx=g.codex;
        const swap=function(label,via){ const b=el('button','ghost mono',label); b.addEventListener('click',function(){ save({openaiVia:via}); }); return b; };
        if(g.via==='chatgpt'){
          // his ChatGPT plan, through OpenAI's Codex CLI: install it once, then sign in in the browser
          const r=el('div','settings-row'); r.style.marginTop='8px';
          if(!cx.installed){
            const b=el('button','ghost mono','Install Codex (needed to sign in)');
            b.addEventListener('click',async function(){ b.disabled=true; b.textContent='installing… (a minute or two)';
              try{ const res=await window.desktop.aiCodexInstall(); ai=res.status; aiDraw(); say(res.ok?'installed: now sign in':'install failed: '+res.error); }
              catch(e){ say('install failed'); b.disabled=false; } });
            r.appendChild(b);
          } else {
            if(cx.signedIn){ const ok=el('span','','✓ Signed in with ChatGPT'); ok.style.cssText='font-size:13px;flex:1'; r.appendChild(ok); }
            const b=el('button','ghost mono',cx.signedIn?'Sign in again':'Sign in with ChatGPT');
            b.addEventListener('click',async function(){ b.disabled=true; b.textContent='finish signing in in your browser…';
              try{ const res=await window.desktop.aiCodexLogin(); ai=res.status; aiDraw(); say(res.ok?'signed in':'sign-in failed: '+res.error); }
              catch(e){ say('sign-in failed'); b.disabled=false; } });
            r.appendChild(b);
          }
          box.appendChild(r);
          if(cx.signedIn)box.appendChild(modelRow('codex','codexModel',g.codexModel));
          const r2=el('div','settings-row'); r2.style.marginTop='4px'; r2.appendChild(swap('Use an API key instead','key')); box.appendChild(r2);
          box.appendChild(el('p','settings-hint','Runs on your ChatGPT plan through OpenAI’s Codex app, so it counts against your plan’s Codex limits, not a paid API key. It gets web search and the agent browser (mail closed): no files, Gmail or shell.'));
          box.lastChild.style.margin='8px 0 0';
        } else {
          box.appendChild(keyRow(g.hasKey?'replace OpenAI API key':'OpenAI API key (platform.openai.com/api-keys)','openaiKey'));
          if(g.hasKey)box.appendChild(modelRow('openai','openaiModel',g.model));
          const r2=el('div','settings-row'); r2.style.marginTop='4px'; r2.appendChild(swap('Use my ChatGPT plan instead','chatgpt')); box.appendChild(r2);
          box.appendChild(el('p','settings-hint','ChatGPT answers with web search and the agent browser (mail closed), but no files or Gmail. The API key is billed separately from a ChatGPT Plus subscription. OpenAI doesn’t train on API data.'));
          box.lastChild.style.margin='8px 0 0';
        }
      }
      if(ai[p.id]&&ai[p.id].compat){
        // Grok, Groq: a free API key and a model
        const o=ai[p.id], info=COMPAT_INFO[p.id], name=ai.names[p.id];
        box.appendChild(keyRow(o.hasKey?'replace '+name+' API key':(info.label||name+' API key')+' ('+info.where+')',p.id+'Key'));
        if(o.hasKey)box.appendChild(modelRow(p.id,p.id+'Model',o.model));
        const r=el('div','settings-row'); r.style.marginTop='4px';
        if(o.hasKey){ const t=el('button','ghost mono','Test key'); t.addEventListener('click',async function(){ say('checking…');
          const res=await window.desktop.aiCompatCheck(p.id);
          if(!res.ok!==!!keyBad[p.id]){ if(res.ok)delete keyBad[p.id]; else keyBad[p.id]='key failed: '+res.error; aiDraw(); }
          say(!res.ok?'key failed: '+res.error:res.hasModel?'key works · '+res.count+' models':'key works, but '+o.model+' isn’t one of its models'+(res.suggest?': try '+res.suggest:'')); }); r.appendChild(t); }
        else { const g=el('button','ghost mono','Get a free key ↗'); g.addEventListener('click',function(){ openExternal(info.url); }); r.appendChild(g); }
        box.appendChild(r);
        // a switch for each: free tiers browse poorly and run out fast, so it's off unless he turns it on
        const bs=el('label','switch'); bs.style.marginTop='8px'; const bc=document.createElement('input'); bc.type='checkbox'; bc.checked=!!o.browser;
        bs.appendChild(bc); const bt=el('span','track'); bt.setAttribute('aria-hidden','true'); bs.appendChild(bt);
        bs.appendChild(el('span','','Let '+name+' use the agent browser (slow, uses up its free tier)'));
        bc.addEventListener('change',function(){ const ch={}; ch[p.id+'Browser']=bc.checked; save(ch); });
        box.appendChild(bs);
        box.appendChild(el('p','settings-hint',name+' has a free tier. It answers without web search, files or Gmail'+(o.browser?'':' (or a browser, unless you turn it on above)')+', so it’s a backup for questions and writing. '+info.note));
        box.lastChild.style.margin='8px 0 0';
      }
      if(p.id==='openrouter'){
        const o=ai.openrouter;
        if(!o.hasKey){
          // one click: OpenRouter's sign-in in the browser makes a key for this app, nothing to paste
          const cr=el('div','settings-row'); cr.style.marginTop='8px';
          const cb2=el('button','btn-accent','Connect with OpenRouter ↗');
          cb2.addEventListener('click',async function(){ cb2.disabled=true; cb2.textContent='finish in your browser…';
            try{ const res=await window.desktop.aiOpenRouterConnect(); ai=res.status; aiDraw(); say(res.ok?'OpenRouter connected':'didn’t connect: '+res.error); }
            catch(e){ say('didn’t connect'); cb2.disabled=false; cb2.textContent='Connect with OpenRouter ↗'; } });
          cr.appendChild(cb2); box.appendChild(cr);
          box.appendChild(el('p','settings-hint','Sign in (or make a free account) and OpenRouter hands Romulus a key. One account, hundreds of models, some free. Or paste a key from openrouter.ai/keys below.'));
          box.lastChild.style.margin='8px 0 0';
        }
        box.appendChild(keyRow(o.hasKey?'replace OpenRouter key':'OpenRouter API key (openrouter.ai/keys)','openrouterKey'));
        if(o.hasKey)box.appendChild(modelRow('openrouter','openrouterModel',o.model,'openrouter/auto'));
        const r=el('div','settings-row'); r.style.marginTop='4px';
        if(o.hasKey){ const t=el('button','ghost mono','Test key'); t.addEventListener('click',async function(){ say('checking…');
          const res=await window.desktop.aiOpenRouterCheck();
          if(!res.ok!==!!keyBad.openrouter){ if(res.ok)delete keyBad.openrouter; else keyBad.openrouter='key failed: '+res.error; aiDraw(); }
          say(res.ok?'key works'+(res.usage!=null?' · $'+Number(res.usage).toFixed(2)+' used'+(res.limit!=null?' of $'+res.limit:''):''):'key failed: '+res.error); }); r.appendChild(t); }
        box.appendChild(r);
        const ws=el('label','switch'); ws.style.marginTop='8px'; const wc=document.createElement('input'); wc.type='checkbox'; wc.checked=o.web;
        ws.appendChild(wc); const wt=el('span','track'); wt.setAttribute('aria-hidden','true'); ws.appendChild(wt);
        ws.appendChild(el('span','','Add web search results (costs a little extra)'));
        wc.addEventListener('change',function(){ save({openrouterWeb:wc.checked}); });
        box.appendChild(ws);
        const zs=el('label','switch'); zs.style.marginTop='8px'; const zc=document.createElement('input'); zc.type='checkbox'; zc.checked=o.zdr;
        zs.appendChild(zc); const zt=el('span','track'); zt.setAttribute('aria-hidden','true'); zs.appendChild(zt);
        zs.appendChild(el('span','','Zero data retention only (fewer models, nothing kept)'));
        zc.addEventListener('change',function(){ save({openrouterZdr:zc.checked}); });
        box.appendChild(zs);
        // on Auto: its free models first, so credit is only spent when they're busy or used up
        const fs=el('label','switch'); fs.style.marginTop='8px'; const fc=document.createElement('input'); fc.type='checkbox'; fc.checked=o.free;
        fs.appendChild(fc); const ft=el('span','track'); ft.setAttribute('aria-hidden','true'); fs.appendChild(ft);
        fs.appendChild(el('span','','Try free models first (on Auto; 50 free a day, 1,000 once you’ve ever bought $10)'));
        fc.addEventListener('change',function(){ save({openrouterFree:fc.checked}); });
        box.appendChild(fs);
        box.appendChild(el('p','settings-hint','OpenRouter gets the agent browser (mail closed) when the model can use tools, but no files or Gmail. It only uses providers that don’t collect or train on what’s sent.'));
        box.lastChild.style.margin='8px 0 0';
      }
      list.appendChild(box);
    });
    // Claude after the others, so his Claude usage is kept for building the app
    const cs=el('label','switch'); cs.style.marginTop='6px'; const cc=document.createElement('input'); cc.type='checkbox'; cc.checked=ai.claudeLast;
    cs.appendChild(cc); const ct=el('span','track'); ct.setAttribute('aria-hidden','true'); cs.appendChild(ct);
    cs.appendChild(el('span','','Save Claude for last: the other AIs go first'));
    cc.addEventListener('change',function(){ save({claudeLast:cc.checked}); });
    list.appendChild(cs);
    list.appendChild(el('p','settings-hint','Claude only gets a task when the others can’t do it (it needs the browser, your inbox or a photo) or they’re out of usage. Inbox tasks always need Claude. Pick Claude on a task’s pill to send it straight there.'));
    list.lastChild.style.margin='6px 0 0';
    // the mini PC may hand research to these AIs as helpers (never private tasks or his details)
    const hs=el('label','switch'); hs.style.marginTop='6px'; const hc=document.createElement('input'); hc.type='checkbox'; hc.checked=ai.helpers;
    hs.appendChild(hc); const ht=el('span','track'); ht.setAttribute('aria-hidden','true'); hs.appendChild(ht);
    hs.appendChild(el('span','','The local model can send research to these as helpers'));
    hc.addEventListener('change',function(){ save({helpers:hc.checked}); });
    list.appendChild(hs);
    list.appendChild(el('p','settings-hint','Up to 4 questions at once, spread across the AIs above. Private tasks and your details never go out.'));
    list.lastChild.style.margin='6px 0 0';
  }
  /* the usage pool: one bar per AI that's on. Claude's are its real 5-hour and weekly limits; Gemini counts
     today's calls against the daily limit Google named (once it has); ChatGPT on his plan shows the plan's own
     Codex limit windows; with an API key it's pay as you go, so no bar */
  let use=null, useBusy=false;
  const pctTxt=function(x){ return Math.round((x||0)*100)+'%'; };
  const atTime=function(ms){ return new Date(ms).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}); };
  function usageDraw(){
    const box=$('aiUsage'); box.innerHTML='';
    if(!ai)return;
    // its own card at the top of Settings, always open
    const wrap=el('div','settings-panel');
    const head=el('div','settings-row'); head.style.cssText='margin-top:0;justify-content:space-between;align-items:center';
    head.appendChild(el('span','settings-label','Usage')); head.lastChild.style.marginBottom='0';
    const rf=el('button','ghost mono',useBusy?'checking…':'↻'); rf.title='Check again now'; rf.disabled=useBusy;
    rf.addEventListener('click',function(){ usageLoad(true); });
    head.appendChild(rf); wrap.appendChild(head);
    const row=function(name,pct,text,out){
      const r=el('div',''); r.style.cssText='display:flex;align-items:center;gap:10px;margin-top:8px';
      const n=el('span','',name); n.style.cssText='width:96px;flex:none;font-size:13px';
      const track=el('div',''); track.style.cssText='flex:1;height:8px;border-radius:4px;background:var(--chip);overflow:hidden;min-width:60px';
      if(out||pct!=null){ const f=el('div',''); const p=out?1:Math.max(0,Math.min(1,pct));
        f.style.cssText='height:100%;border-radius:4px;width:'+(p*100)+'%;background:'+(out||p>=0.8?'var(--late)':'var(--accent)');
        track.appendChild(f); }
      const t=el('span','mono',text); t.style.cssText='flex:1.3;font-size:11px;color:'+(out?'var(--late)':'var(--muted)')+';text-transform:none;letter-spacing:0';
      r.appendChild(n); r.appendChild(track); r.appendChild(t); wrap.appendChild(r);
    };
    const on=ai.order.filter(function(p){ return p.on; }).map(function(p){ return p.id; });
    if(!on.length){ wrap.appendChild(el('p','settings-hint','No AI is switched on.')); box.appendChild(wrap); return; }
    const u=use||{};
    on.forEach(function(id){
      if(id==='claude'){
        const c=u.claude;
        if(!c){ row('Claude · 5h',null,use?'no reading yet':'checking…'); return; }
        if(c.out){ row('Claude',1,'out until '+(c.out===true?'it resets':fmtWhen(c.out)),true); return; }
        row('Claude · 5h',c.pct,pctTxt(c.pct)+' used'+(c.fiveReset?' · resets '+atTime(c.fiveReset):''));
        row('Claude · week',c.week,pctTxt(c.week)+' used'+(c.weekReset?' · resets '+fmtWhen(c.weekReset):''));
      } else if(id==='gemini'){
        const g=u.gemini;
        if(!ai.gemini.hasKey){ row('Gemini',null,'no key yet'); return; }
        if(!g){ row('Gemini',null,'…'); return; }
        if(g.out){ row('Gemini',1,'out until '+fmtWhen(g.out),true); return; }
        row('Gemini',g.pct,g.perDay?g.calls+' of '+g.perDay+' today':g.calls+' today · daily limit not hit yet');
      } else if(id==='openai'){
        const o=u.openai;
        if(ai.openai.via==='chatgpt'){
          if(!ai.openai.codex.signedIn){ row('ChatGPT',null,'not signed in'); return; }
          if(!o){ row('ChatGPT',null,'…'); return; }
          const pl=o.plan, runs=o.calls+' run'+(o.calls===1?'':'s')+' · '+o.tokensText+' tokens this month';
          if(!pl||!pl.windows.length){ row('ChatGPT',null,runs+(pl?'':' · limit not read yet')); return; }
          if(pl.out){ row('ChatGPT',1,'out until '+(pl.out===true?'it resets':fmtWhen(pl.out)),true); return; }
          // Codex names each window by its length: 5 hours, a week, 30 days on the free plan
          const span=function(m){ return !m?'':m<=1440?' · '+Math.round(m/60)+'h':m<=10080?' · week':' · month'; };
          pl.windows.forEach(function(w,i){
            row('ChatGPT'+span(w.mins),w.used,pctTxt(w.used)+' used'+(w.resetsAt?' · resets '+fmtWhen(w.resetsAt):'')+(i===pl.windows.length-1?' · '+runs:''));
          });
          return; }
        if(!ai.openai.hasKey){ row('ChatGPT',null,'no key yet'); return; }
        row('ChatGPT',null,o?o.calls+' calls · '+o.tokensText+' tokens this month (pay as you go)':'…');
      } else if(ai[id]&&ai[id].compat){
        const o=u[id];
        if(!ai[id].hasKey){ row(ai.names[id],null,'no key yet'); return; }
        row(ai.names[id],null,o?o.calls+' calls · '+o.tokensText+' tokens this month (free tier)':'0 calls this month (free tier)');
      } else if(id==='openrouter'){
        const o=u.openrouter;
        if(!ai.openrouter.hasKey){ row('OpenRouter',null,'no key yet'); return; }
        if(!o){ row('OpenRouter',null,'…'); return; }
        const cr=o.credit;
        row('OpenRouter',o.pct,cr?'$'+Number(cr.usage||0).toFixed(2)+(cr.limit?' of $'+cr.limit:' used · no limit set'):o.calls+' calls this month');
      }
    });
    box.appendChild(wrap);
  }
  function usageLoad(refresh){
    if(!window.desktop.aiUsage||useBusy)return;
    useBusy=true; usageDraw();
    window.desktop.aiUsage(refresh).then(function(u){ use=u; }).catch(function(){}).then(function(){ useBusy=false; usageDraw(); });
  }
  window.desktop.aiStatus().then(function(s){ ai=s; aiDraw(); usageLoad(false); }).catch(function(){ $('aiSection').hidden=true; $('aiUsage').hidden=true; });
}
/* Course calendars: Blackboard / D2L iCal links → School list (desktop only; the links stay in its
   config). Each item keeps its id (from the feed's own UID), so a re-import never adds copies. What the
   feed last said per item is remembered here, so: a deadline the teacher moves is followed unless he set
   his own date; one he deleted (or finished and cleared) isn't brought back. */
const FEED_SEEN_KEY='tasks.feedSeen';
async function importCourseFeeds(){
  if(!window.desktop||!window.desktop.feedsFetch)return null;
  const r=await window.desktop.feedsFetch();
  let seen={}; try{ seen=JSON.parse(localStorage.getItem(FEED_SEEN_KEY)||'{}')||{}; }catch(e){}
  const ws=schoolConfigured()?'school':'personal';
  const byId={}; state.tasks.forEach(function(t){ byId[t.id]=t; });
  const tombed={}; state.tombstones.forEach(function(x){ tombed[x.id]=1; });
  const norm=function(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); };
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
    // he already put it on a list himself: same day, same name
    if(state.tasks.some(function(x){ return x.due===e.due&&norm(x.title)===norm(e.title); }))return;
    const n={id:e.id,title:e.title,done:false,due:e.due,dueTime:e.dueTime,tag:e.course||null,ws:ws,subs:[],googleEventId:null,created:Date.now()};
    if(ws==='school'){ n.kind=e.kind; n.notes=[e.notes,e.url].filter(Boolean).join('\n\n')||null; }
    state.tasks.push(n); added++;
  });
  try{ localStorage.setItem(FEED_SEEN_KEY,JSON.stringify(seen)); }catch(e){}
  const tidy=tidySchool(r);
  if(added||moved||tidy.merged||tidy.labeled||tidy.removed)touch();
  return {added:added,moved:moved,count:r.items.length,errors:r.errors,tidy:tidy};
}
/* Tidy the School list after each import, so each assignment is there once and labeled with its course:
   - course names and loose codes as tags ("Astronomy", "ecn322") become the code ("PHYS 1010", "ECN 322");
     a title that starts with the code gives the tag, and the code comes off the title (the chip shows it)
   - a task added by hand (or by Claude) that the course calendar also has, same course, within a day, same
     name give or take ("ECN 322 Homework 3" / "Homework 3"), is folded into the calendar one: its course,
     type, notes and plan carry over and the hand-made copy goes. Two calendar items are never merged:
     the school lists them separately, so they're separate things ("Chapter 19" / "Ch 19: Reading …")
   - Blackboard's feed doesn't say the course, but it numbers one course's items in a run, so a calendar item
     gets the course of its tagged neighbours: tag one "Ch 3 Quiz" and the rest of that class follows
   - "… - Available" / extra "Availability Ends" entries (no longer imported) are taken off if untouched */
const COURSE_RX=/^\s*([A-Za-z]{2,5})[ -]?(\d{3,4}[A-Za-z]?)\b/;
function courseTag(s){ const m=String(s||'').match(/^\s*([A-Za-z]{2,5})[ -]?(\d{3,4}[A-Za-z]?)\s*$/); return m?m[1].toUpperCase()+' '+m[2].toUpperCase():null; }
function schoolWords(title){
  const s=String(title||'').toLowerCase().replace(/&/g,' and ').replace(/\bch\b\.?/g,'chapter').replace(/\bhw\b/g,'homework')
    .replace(/\b[a-z]{2,5}[ -]?\d{3,4}[a-z]?\b/g,' ').replace(/\bsec(tion)?\.?\s*\d+/g,' ').replace(/[^a-z0-9]+/g,' ');
  const skip={the:1,a:1,an:1,and:1,of:1,assignment:1,proctored:1,due:1};
  return new Set(s.split(' ').filter(function(w){ return w&&!skip[w]; }));
}
function sameAssignment(a,b){
  const A=schoolWords(a), B=schoolWords(b);
  const nums=function(S){ return Array.from(S).filter(function(w){ return /^\d+$/.test(w); }).sort().join(','); };
  if(nums(A)!==nums(B))return false; // Homework 3 is never Homework 4
  const small=A.size<=B.size?A:B, big=small===A?B:A;
  let common=0; small.forEach(function(w){ if(big.has(w))common++; });
  if(small.size>=2&&common===small.size)return true;
  return common>=2&&common/(A.size+B.size-common)>=0.6;
}
function tidySchool(r){
  const out={merged:0,labeled:0,removed:0};
  const daysApart=function(a,b){ return Math.abs((new Date(a+'T12:00')-new Date(b+'T12:00'))/864e5); };
  const drop=function(t){
    if(t.googleEventId&&window.desktop&&window.desktop.gcalDeleteEvent)window.desktop.gcalDeleteEvent(t.googleEventId,t.calRef);
    state.tasks=state.tasks.filter(function(x){ return x.id!==t.id; }); state.expanded.delete(t.id);
    state.tombstones.push({id:t.id,deletedAt:Date.now()});
  };
  // 1. entries the feed no longer counts as assignments
  const gone={}; (r.dropped||[]).forEach(function(id){ gone[id]=1; });
  state.tasks.filter(function(t){ return gone[t.id]&&!t.done&&!(t.subs&&t.subs.length); }).forEach(function(t){ drop(t); out.removed++; });
  const school=function(){ return state.tasks.filter(function(t){ return taskWs(t)==='school'&&!t.done; }); };
  // 2. course names → codes, learned from the feeds ("PHYS-1010-…-Astronomy-…" → astronomy = PHYS 1010)
  const alias={};
  r.items.forEach(function(e){ if(e.course&&courseTag(e.course)&&e.courseName)alias[e.courseName.toLowerCase()]=courseTag(e.course); });
  const label=function(t,tag){ if(tag&&t.tag!==tag){ t.tag=tag; out.labeled++; } };
  // every task's tag, done ones and other lists too, or a stale "Astronomy" chip sits beside "PHYS 1010"
  state.tasks.forEach(function(t){
    const raw=String(t.tag||'').trim();
    if(raw)label(t,courseTag(raw)||alias[raw.toLowerCase()]||raw);
  });
  school().forEach(function(t){
    const m=String(t.title||'').match(COURSE_RX);
    const code=m&&courseTag(m[1]+' '+m[2]);
    if(code&&(!t.tag||t.tag===code)){
      label(t,code);
      const rest=t.title.slice(m[0].length).replace(/^\s*[-–:]\s*/,'').replace(/^Sec(?:tion)?\.?\s*\d+\s*[-–:]\s*/i,'').replace(/(.{3,})\s+[-–]\s+Assignment$/i,'$1').trim();
      if(rest.length>=3){ t.title=rest; out.labeled++; }
    }
    // "Exam Reflection Assignment" was once filed as an exam
    if(t.kind==='exam'&&/\b(reflection|review|wrapper|corrections?|prep|practice)\b/i.test(t.title)){ t.kind='regular'; out.labeled++; }
  });
  // 3. hand-made copies of calendar items: within a day; or, same course and exactly the same name, within
  // a week (a date typed in by hand that's off; the calendar's date wins). Run again once step 4 has
  // labeled more calendar items, for that second kind
  const same=function(a,b){ return Array.from(schoolWords(a)).sort().join(' ')===Array.from(schoolWords(b)).sort().join(' '); };
  const fold=function(){ const feedTasks=school().filter(function(t){ return /^ics-/.test(t.id); });
  school().filter(function(t){ return !/^ics-/.test(t.id)&&t.due; }).forEach(function(h){
    const hits=feedTasks.filter(function(f){
      if(!f.due)return false;
      const gap=daysApart(f.due,h.due);
      return (gap<=1&&(!f.tag||!h.tag||f.tag===h.tag)&&sameAssignment(f.title,h.title))||(gap<=7&&f.tag&&f.tag===h.tag&&same(f.title,h.title));
    });
    if(!hits.length)return;
    hits.forEach(function(f){
      if(!f.tag&&h.tag)f.tag=h.tag;
      if(schoolKind(f)==='regular'&&schoolKind(h)!=='regular')f.kind=h.kind;
      if(h.notes&&String(f.notes||'').indexOf(h.notes)<0)f.notes=h.notes+(f.notes?'\n\n'+f.notes:'');
      if(!f.plan&&h.plan){ f.plan=h.plan; f.planSet=h.planSet; }
      if(h.subs&&h.subs.length)f.subs=(f.subs||[]).concat(h.subs);
    });
    // one match: keep whichever name says more ("Homework: Gas Giants, Rings, and Moons" over "Homework: Gas Giants")
    if(hits.length===1&&schoolWords(h.title).size>schoolWords(hits[0].title).size)hits[0].title=h.title;
    drop(h); out.merged++;
  }); };
  // 4. Blackboard: untagged items take the course of their numbered neighbours (when they all agree)
  const bbNum=function(uid){ const m=String(uid||'').match(/GradableItem-_(\d+)_/); return m?+m[1]:null; };
  const num={}; r.items.forEach(function(e){ const n=bbNum(e.uid); if(n!=null)num[e.id]=n; });
  const spread=function(){ const known=school().filter(function(t){ return t.tag&&num[t.id]!=null&&courseTag(t.tag); });
  school().filter(function(t){ return !t.tag&&num[t.id]!=null; }).forEach(function(t){
    const near={}; known.forEach(function(k){ if(Math.abs(num[k.id]-num[t.id])<=25)near[k.tag]=1; });
    const tags=Object.keys(near); if(tags.length===1)label(t,tags[0]);
  }); };
  fold(); spread(); fold();
  return out;
}
// Settings: the how-tos kept from earlier Agent tasks (see agent/howtos.js)
function drawHowtos(){
  const box=$('howtosList'); if(!box||!window.desktop||!window.desktop.howtosList)return;
  window.desktop.howtosList().then(function(list){
    box.innerHTML='';
    if(!list.length){ box.appendChild(el('p','settings-hint','Nothing yet. Notes appear here as Agent tasks finish.')); return; }
    list.forEach(function(h){
      // one line each; tap to see the note
      const row=el('div','howto'), head=el('div','howto-head'), body=el('div','howto-body');
      const task=el('span','howto-task',h.task); task.title=h.task;
      head.appendChild(task);
      head.appendChild(el('span','howto-date',String(h.date||'').slice(5)));
      const del=el('button','ghost danger howto-del','\u00D7'); del.title='Delete';
      del.addEventListener('click',function(e){ e.stopPropagation(); window.desktop.howtosDelete(h.id).then(drawHowtos); });
      head.appendChild(del);
      body.appendChild(el('div','howto-text',h.text));
      body.appendChild(el('div','howto-meta',(h.merged?'merged from '+h.merged+' notes':(h.lane==='local'?'The local model':'Claude'))+((h.sites||[]).length?' \u00B7 '+h.sites.join(', '):'')));
      body.hidden=true;
      head.addEventListener('click',function(){ body.hidden=!body.hidden; });
      row.appendChild(head); row.appendChild(body);
      box.appendChild(row);
    });
  }).catch(function(){});
}
if(window.desktop&&window.desktop.howtosList){
  $('howtosSection').hidden=false; drawHowtos();
  $('howtosCompactBtn').addEventListener('click',async function(){
    const b=this, say=function(t){ $('howtosStatus').textContent=t; };
    b.disabled=true; say('merging overlapping notes on the local model…');
    let r; try{ r=await window.desktop.howtosCompact(); }catch(e){ r={ok:false,error:e.message}; }
    b.disabled=false;
    say(!r.ok?r.error:r.merged?'merged '+r.merged+' group'+(r.merged>1?'s':'')+' of notes':'nothing overlaps right now');
    drawHowtos();
  });
}
// Settings: what the Agent did — one searchable log across tasks. Three sources, newest first:
//  - actions its browser let through (agent/agent-browser.js keeps <userData>/agent-actions.log; browser-proxy.js writes it)
//  - every Agent task's conversation (its answers, your replies, the app's notes: runs, triggers, retries)
//  - the runner's own log (main/agent-log.js): which AI answered, what failed and why — the "Runner" filter
const LOG_MAX=300, LOG_KINDS={action:'action',answer:'answer',you:'you',system:'system',runner:'runner'};
let logKind='', logActions=[], logRunner=[], logTimer=null;
function logEntries(){
  const rows=[];
  logActions.forEach(function(a){
    let what=String(a.what||''); if(a.label)what+=' “'+a.label+'”'; if(Array.isArray(a.files))what+=' '+a.files.join(', ');
    const site=a.url?String(a.url).replace(/^https?:\/\/(www\.)?/,'').slice(0,60):'';
    rows.push({at:a.at||0,kind:'action',text:what+(site?' · '+site:''),task:a.task||'',title:(a.task?a.task+'\n':'')+(a.url||'')});
  });
  state.tasks.forEach(function(t){
    if(taskWs(t)!=='agent'||!Array.isArray(t.history))return;
    t.history.forEach(function(h){
      if(!h||!h.text)return;
      const kind=h.who==='you'?'you':h.who==='sys'?'system':'answer';
      rows.push({at:h.at||0,kind:kind,text:String(h.text).replace(/\s+/g,' ').slice(0,220),task:t.title,id:t.id});
    });
  });
  logRunner.forEach(function(l){ rows.push({at:l.at||0,kind:'runner',text:String(l.text).slice(0,300),task:''}); });
  return rows.sort(function(a,b){ return b.at-a.at; });
}
function drawActions(){
  const box=$('actionsList'); if(!box)return;
  const q=String($('logSearch').value||'').trim().toLowerCase();
  const rows=logEntries().filter(function(r){
    if(logKind?r.kind!==logKind:r.kind==='runner'&&!q)return false; // the runner's notes only when asked for, or searched
    return !q||(r.text+' '+r.task).toLowerCase().indexOf(q)!==-1;
  }).slice(0,LOG_MAX);
  box.innerHTML='';
  if(!rows.length){ box.appendChild(el('p','settings-hint',q?'Nothing in the log matches that.':'Nothing yet. Lines appear here as the Agent works: what it did, what it answered, what you told it.')); return; }
  rows.forEach(function(r){
    const row=el('div','howto log-row'), head=el('div','howto-head');
    head.appendChild(el('span','log-kind '+r.kind,LOG_KINDS[r.kind]));
    const t=el('span','howto-task',(r.task&&r.kind!=='runner'?r.task+' — ':'')+r.text); t.title=r.title||r.text;
    head.appendChild(t);
    head.appendChild(el('span','howto-date',r.at?new Date(r.at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):''));
    if(r.id){ head.addEventListener('click',function(){ setSettingsOpen(false); openTaskById(r.id); }); }
    else head.style.cursor='default';
    row.appendChild(head); box.appendChild(row);
  });
}
// the desktop's two files are fetched now and then; the tasks' conversations are already here
function loadLog(){
  if(!window.desktop||!window.desktop.agentActions)return drawActions();
  Promise.all([window.desktop.agentActions().catch(function(){ return []; }),
    window.desktop.agentLogTail?window.desktop.agentLogTail().catch(function(){ return []; }):[]]).then(function(r){
    logActions=Array.isArray(r[0])?r[0]:[]; logRunner=Array.isArray(r[1])?r[1]:[]; drawActions();
  });
}
if($('actionsSection')){
  if(window.desktop&&window.desktop.agentLogTail)$('logFilters').querySelector('[data-kind="runner"]').hidden=false;
  $('logFilters').addEventListener('click',function(e){
    const b=e.target.closest('button[data-kind]'); if(!b)return;
    logKind=b.dataset.kind; $('logFilters').querySelectorAll('button').forEach(function(x){ x.classList.toggle('on',x===b); }); drawActions();
  });
  $('logSearch').addEventListener('input',function(){ clearTimeout(logTimer); logTimer=setTimeout(drawActions,150); });
  loadLog(); setInterval(loadLog,60*1000);
}
if(window.desktop&&window.desktop.feedsFetch){
  $('feedsSection').hidden=false;
  window.desktop.feedsGet().then(function(urls){ $('feedsText').value=(urls||[]).join('\n'); }).catch(function(){});
  const feedsSay=function(r){
    if(!r)return '';
    const d=r.tidy||{};
    const parts=[r.count+' upcoming'+(r.added?', '+r.added+' added':'')+(r.moved?', '+r.moved+' moved':'')+
      (d.merged?', '+d.merged+' duplicates merged':'')+(d.removed?', '+d.removed+' extras removed':'')+(d.labeled?', labels fixed':'')];
    return parts.concat(r.errors).join(' · ');
  };
  $('feedsSaveBtn').addEventListener('click',async function(){
    const urls=$('feedsText').value.split(/\s*\n\s*/).map(function(x){ return x.trim(); }).filter(Boolean);
    $('feedsStatus').textContent='saving…';
    try{
      const s=await window.desktop.feedsSave(urls);
      if(!s.ok){ $('feedsStatus').textContent=s.error; return; }
      if(!urls.length){ $('feedsStatus').textContent='saved'; return; }
      $('feedsStatus').textContent='importing…';
      $('feedsStatus').textContent=feedsSay(await importCourseFeeds());
    }catch(e){ $('feedsStatus').textContent='couldn’t import: '+e.message; }
  });
  // a little after start (sync has loaded the lists by then), then every 3 hours
  const feedsTick=function(){ importCourseFeeds().then(function(r){ if(r&&(r.added||r.moved||r.errors.length||(r.tidy&&(r.tidy.merged||r.tidy.removed||r.tidy.labeled))))$('feedsStatus').textContent=feedsSay(r); }).catch(function(){}); };
  setTimeout(feedsTick,20000); setInterval(feedsTick,3*60*60*1000);
}
/* "Hey Romulus" (phone app only): WakeWordPlugin.java / WakeWordService.java */
(function(){
  const cap=window.Capacitor;
  if(!(cap&&typeof cap.nativePromise==='function'&&cap.isPluginAvailable&&cap.isPluginAvailable('WakeWord')))return;
  const call=function(m){ return cap.nativePromise('WakeWord',m,{}); };
  $('wakeSection').hidden=false;
  function show(s){
    $('wakeOn').checked=!!s.on;
    // without "Display over other apps", Android makes you tap a notification after the chime
    // (the Google Play build can't ask for it at all: android/app/src/play/AndroidManifest.xml)
    const canAsk=window.ROMULUS_STORE!=='play';
    $('wakeOverlayBtn').hidden=!s.on||s.overlay||!canAsk;
    $('wakeStatus').textContent=s.downloading?'downloading…':s.on?(s.overlay?'listening while the screen is on':canAsk?'on · you’ll tap a notification to talk unless you allow this':'on · in another app, tap the notification to talk'):'';
  }
  function refresh(){ call('status').then(show).catch(function(){}); }
  cap.addListener('WakeWord','progress',function(d){ if(d&&d.pct!=null)$('wakeStatus').textContent='downloading speech model… '+d.pct+'%'; });
  $('wakeOn').addEventListener('change',async function(){
    const on=this.checked; this.disabled=true;
    if(on)$('wakeStatus').textContent='starting…';
    try{ show(await call(on?'enable':'disable')); }
    catch(e){ $('wakeStatus').textContent=(e&&e.message)||'didn’t work'; this.checked=false; }
    finally{ this.disabled=false; }
  });
  $('wakeOverlayBtn').addEventListener('click',function(){ call('openOverlaySettings'); });
  // coming back from Android's settings (or "Turn off" in the notification) changes things under us
  document.addEventListener('visibilitychange',function(){ if(!document.hidden)refresh(); });
  refresh();
})();
$('newAttBtn').addEventListener('click',function(){ $('newAttFile').click(); });
$('legionBtn').addEventListener('click',function(){ setLegion(!legionOn); $('newTitle').focus(); });
$('micBtn').innerHTML=MIC_LABEL;
$('micBtn').addEventListener('click',voiceAdd);
if(voiceEngine())$('micBtn').hidden=false;
$('newAttFile').addEventListener('change',function(){ const f=Array.from(this.files||[]); this.value=''; addComposerFiles(f); });
['newTitle','newDue','newTime','newTag'].forEach(function(id){ $(id).addEventListener('keydown',function(e){ if(e.key==='Enter')addTask(); }); });
(function(){
  const newDueEl=$('newDue'), newTimeEl=$('newTime');
  function syncNewTimeState(){ newTimeEl.disabled=!newDueEl.value; if(!newDueEl.value)newTimeEl.value=''; }
  newDueEl.addEventListener('change',syncNewTimeState);
  syncNewTimeState();
})();
$('tabList').addEventListener('click',function(){ switchTab('list'); });
$('tabAgent').addEventListener('click',function(){ switchTab('agent'); });
$('connectBtn').addEventListener('click',function(){
  const ws=this.getAttribute('data-ws');
  // every list syncs once the project is set up, so the personal fields are what to fill in
  const field='syncUrl', label=null;
  setSettingsOpen(true);
  $('syncSection').open=true;
  requestAnimationFrame(function(){
    const f=$(field); (label?$(label):f).scrollIntoView({block:'center'}); f.focus();
    [f,label&&$(label)].filter(Boolean).forEach(function(n){ n.classList.add('flash'); setTimeout(function(){ n.classList.remove('flash'); },1800); });
  });
});
$('tabCal').addEventListener('click',function(){ switchTab('calendar'); });
$('tabSchool').addEventListener('click',function(){ switchTab('school'); });
$('tabWork').addEventListener('click',function(){ switchTab('work'); });
$('tabIdeas').addEventListener('click',function(){ switchTab('ideas'); });
$('tabHours').addEventListener('click',function(){ switchTab('hours'); });
$('tabFinance').addEventListener('click',function(){ switchTab('finance'); });
$('calPrev').addEventListener('click',function(){ state.calMonth--; if(state.calMonth<0){state.calMonth=11;state.calYear--;} renderCal(); });
$('calNext').addEventListener('click',function(){ state.calMonth++; if(state.calMonth>11){state.calMonth=0;state.calYear++;} renderCal(); });
$('calToday').addEventListener('click',function(){ const n=new Date(); state.calYear=n.getFullYear(); state.calMonth=n.getMonth(); renderCal(); });
$('doneToggle').addEventListener('click',function(){ state.showDone=!state.showDone; render(); });
let clearTimer=null;
$('clearDone').addEventListener('click',function(){
  if(!state.confirmClear){ state.confirmClear=true; render(); clearTimer=setTimeout(function(){ state.confirmClear=false; render(); },2500); }
  else {
    clearTimeout(clearTimer); state.confirmClear=false;
    const now=Date.now();
    const curTab=state.activeTab==='agent'?'agent':state.activeTab==='school'?'school':state.activeTab==='work'?'work':'list'; // only clear the tab you're looking at
    const gone=function(t){ return t.done&&inTab(t,curTab); };
    state.tasks.forEach(function(t){ if(gone(t))state.tombstones.push({id:t.id,deletedAt:now}); });
    state.tasks=state.tasks.filter(function(t){ return !gone(t); });
    touch();
  }
});
document.addEventListener('keydown',function(e){
  if(e.key!=='/'||state.activeTab==='ideas'||state.activeTab==='hours'||state.activeTab==='finance')return; const a=document.activeElement; if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'))return; e.preventDefault(); $('newTitle').focus();
});

/* ── search ── */
$('searchBox').addEventListener('input',function(){ state.search=this.value.trim().toLowerCase(); render(); });
$('searchBox').addEventListener('keydown',function(e){
  if(e.key==='Escape'){ this.value=''; state.search=''; render(); this.blur(); }
  if(e.key==='Enter')this.blur();
});
document.addEventListener('keydown',function(e){
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'){
    e.preventDefault();
    if(state.activeTab==='calendar'||state.activeTab==='ideas'||state.activeTab==='hours'||state.activeTab==='finance')switchTab('list');
    $('searchBox').focus(); $('searchBox').select();
  }
});

/* ── keyboard navigation: arrows select, Space completes, Enter expands, Delete removes ── */
function selectNeighbor(){
  const i=navOrder.indexOf(state.selectedId);
  state.selectedId=navOrder[i+1]!==undefined?navOrder[i+1]:(i>0?navOrder[i-1]:null);
}
document.addEventListener('keydown',function(e){
  if(state.activeTab==='calendar'||state.activeTab==='ideas'||state.activeTab==='hours'||state.activeTab==='finance')return;
  const a=document.activeElement;
  if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'||a.tagName==='SELECT'||a.tagName==='BUTTON'))return;
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){
    e.preventDefault();
    if(!navOrder.length)return;
    const i=navOrder.indexOf(state.selectedId);
    if(e.key==='ArrowDown')state.selectedId=navOrder[i<0?0:Math.min(i+1,navOrder.length-1)];
    else state.selectedId=navOrder[i<0?navOrder.length-1:Math.max(i-1,0)];
    render();
    const sel=document.querySelector('.task.selected'); if(sel)sel.scrollIntoView({block:'nearest'});
    return;
  }
  if(!state.selectedId)return;
  const t=state.tasks.find(function(x){ return x.id===state.selectedId; });
  if(!t)return;
  if(e.key===' '){ e.preventDefault(); selectNeighbor(); setDone(t,!t.done); touch(); }
  // only the Delete key — Backspace is too easy to hit while typing (it once deleted a task
  // when a re-render stole focus from the answer box)
  else if(e.key==='Delete'){ e.preventDefault(); selectNeighbor(); deleteTask(t); }
  else if(e.key==='Enter'){ e.preventDefault(); toggleExpand(t); }
  else if(e.key==='Escape'){ state.selectedId=null; render(); }
});
