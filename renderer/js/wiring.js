/* Wiring the page up: buttons and inputs, search, keyboard navigation.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── wiring ── */
$('addBtn').addEventListener('click',addTask);
if(window.desktop&&window.desktop.openAgentBrowser){
  $('agentBrowserSection').hidden=false;
  $('agentBrowserBtn').addEventListener('click',async function(){
    $('agentBrowserStatus').textContent='opening…';
    try{ const r=await window.desktop.openAgentBrowser(); $('agentBrowserStatus').textContent=r&&r.ok?'':(r&&r.error)||'couldn’t open it'; }
    catch(e){ $('agentBrowserStatus').textContent='couldn’t open it'; }
  });
}
/* AI connections (desktop only): Claude / Gemini / ChatGPT / OpenRouter for the cloud Agent lane, in his order */
if(window.desktop&&window.desktop.aiStatus){
  $('aiSection').hidden=false;
  let ai=null;
  const say=function(t){ $('aiStatusLine').textContent=t||''; if(t)setTimeout(function(){ if($('aiStatusLine').textContent===t)$('aiStatusLine').textContent=''; },4000); };
  const save=async function(change,msg){ try{ ai=await window.desktop.aiSave(change); aiDraw(); say(msg||'saved'); }catch(e){ say('save failed'); } };
  const keyRow=function(ph,saveAs,label){
    const r=el('div','settings-row'); r.style.marginTop='8px';
    const k=el('input','settings-inp'); k.type='password'; k.placeholder=ph; k.style.flex='1'; k.style.margin='0'; k.autocomplete='off';
    const b=el('button','ghost mono',label||'Save key');
    b.addEventListener('click',function(){ const v=k.value.trim(); if(!v)return; const c={}; c[saveAs]=v; save(c,'key saved'); });
    r.appendChild(k); r.appendChild(b); return r;
  };
  const statusText=function(id){
    if(id==='claude')return ai.claudeBlockedUntil?'out of usage until '+fmtWhen(ai.claudeBlockedUntil):'Claude Code on this computer';
    if(id==='gemini'){ const g=ai.gemini;
      if(!g.hasKey)return 'needs an API key';
      return 'API key '+g.key+(g.installed?' · CLI (browser)':' · API (search only)'); }
    if(id==='openai'){ const g=ai.openai; return g.hasKey?'key '+g.key+' · '+g.model:'no key yet'; }
    const o=ai.openrouter; return o.hasKey?'key '+o.key+' · '+o.model:'no key yet';
  };
  function aiDraw(){
    const list=$('aiList'); list.innerHTML='';
    ai.order.forEach(function(p,i){
      const box=el('div',''); box.style.cssText='border:1px solid var(--hairline);border-radius:10px;padding:10px 12px;margin-bottom:8px';
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
      if(p.id==='gemini'){
        const g=ai.gemini;
        box.appendChild(keyRow(g.hasKey?'replace Gemini API key':'Gemini API key (aistudio.google.com/apikey)','geminiKey'));
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
        const g=ai.openai;
        box.appendChild(keyRow(g.hasKey?'replace OpenAI API key':'OpenAI API key (platform.openai.com/api-keys)','openaiKey'));
        const r=el('div','settings-row'); r.style.marginTop='4px';
        const m=el('input','settings-inp'); m.value=g.model; m.placeholder='model, e.g. gpt-5-mini'; m.style.cssText='flex:1;margin:0';
        const mb=el('button','ghost mono','Save model'); mb.addEventListener('click',function(){ save({openaiModel:m.value.trim()},'model saved'); });
        r.appendChild(m); r.appendChild(mb); box.appendChild(r);
        box.appendChild(el('p','settings-hint','ChatGPT answers with web search but no browser, files or Gmail. The API key is billed separately from a ChatGPT Plus subscription. OpenAI doesn’t train on API data.'));
        box.lastChild.style.margin='8px 0 0';
      }
      if(p.id==='openrouter'){
        const o=ai.openrouter;
        box.appendChild(keyRow(o.hasKey?'replace OpenRouter key':'OpenRouter API key (openrouter.ai/keys)','openrouterKey'));
        const r=el('div','settings-row'); r.style.marginTop='4px';
        const m=el('input','settings-inp'); m.value=o.model; m.placeholder='model, e.g. openrouter/auto'; m.style.cssText='flex:1;margin:0';
        const mb=el('button','ghost mono','Save model'); mb.addEventListener('click',function(){ save({openrouterModel:m.value.trim()},'model saved'); });
        r.appendChild(m); r.appendChild(mb);
        if(o.hasKey){ const t=el('button','ghost mono','Test key'); t.addEventListener('click',async function(){ say('checking…');
          const res=await window.desktop.aiOpenRouterCheck();
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
        box.appendChild(el('p','settings-hint','OpenRouter answers without a browser, files or Gmail, so it’s best as a backup for questions and research. It only uses providers that don’t collect or train on what’s sent.'));
        box.lastChild.style.margin='8px 0 0';
      }
      list.appendChild(box);
    });
    // the mini PC may hand research to these AIs as helpers (never private tasks or his details)
    const hs=el('label','switch'); hs.style.marginTop='6px'; const hc=document.createElement('input'); hc.type='checkbox'; hc.checked=ai.helpers;
    hs.appendChild(hc); const ht=el('span','track'); ht.setAttribute('aria-hidden','true'); hs.appendChild(ht);
    hs.appendChild(el('span','','Mini PC can send research to these as helpers'));
    hc.addEventListener('change',function(){ save({helpers:hc.checked}); });
    list.appendChild(hs);
    list.appendChild(el('p','settings-hint','Up to 4 questions at once, spread across the AIs above. Private tasks and your details never go out.'));
    list.lastChild.style.margin='6px 0 0';
  }
  window.desktop.aiStatus().then(function(s){ ai=s; aiDraw(); }).catch(function(){ $('aiSection').hidden=true; });
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
  school().forEach(function(t){
    const raw=String(t.tag||'').trim();
    if(raw)label(t,courseTag(raw)||alias[raw.toLowerCase()]||raw);
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
      body.appendChild(el('div','howto-meta',(h.merged?'merged from '+h.merged+' notes':(h.lane==='local'?'mini PC':'Claude'))+((h.sites||[]).length?' \u00B7 '+h.sites.join(', '):'')));
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
    b.disabled=true; say('merging overlapping notes on the mini PC…');
    let r; try{ r=await window.desktop.howtosCompact(); }catch(e){ r={ok:false,error:e.message}; }
    b.disabled=false;
    say(!r.ok?r.error:r.merged?'merged '+r.merged+' group'+(r.merged>1?'s':'')+' of notes':'nothing overlaps right now');
    drawHowtos();
  });
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
/* RSI: change the app itself from a chat (desktop, run from its source folder) */
if(window.desktop&&window.desktop.rsiStatus)(function(){
  let busy=false, pending=null; // pending: the last change, waiting to be seen (reload or restart)
  function line(m){
    const log=$('rsiLog'); log.hidden=false;
    const who=m.who==='change'?'sys':m.who;
    const b=el('div','conv-msg '+who);
    if(m.who==='claude'){ b.appendChild(el('div','conv-who','RSI')); b.appendChild(document.createTextNode(m.text)); }
    else b.textContent=m.text;
    log.appendChild(b); log.scrollTop=log.scrollHeight;
  }
  function show(){
    $('rsiSend').disabled=busy; $('rsiStop').hidden=!busy;
    $('rsiStatus').textContent=busy?'working…':'';
    $('rsiApply').hidden=busy||!pending;
    if(pending)$('rsiApply').textContent=pending.restart?'Restart to apply':'Reload to see it';
  }
  async function refresh(){
    const s=await window.desktop.rsiStatus();
    if(!s.available){ $('rsiSection').hidden=true; return; }
    $('rsiSection').hidden=false; busy=s.busy;
    $('rsiOn').checked=s.enabled; $('rsiBody').hidden=!s.enabled;
    $('rsiLog').textContent=''; s.chat.forEach(line);
    $('rsiUndo').hidden=!s.canUndo;
    show();
  }
  window.desktop.onRsiEvent(function(m){
    if(m.who==='busy'){ busy=m.busy; if(!busy)refresh(); show(); return; }
    line(m);
    if(m.who==='change')pending=m;
  });
  $('rsiSend').addEventListener('click',async function(){
    const text=$('rsiText').value.trim(); if(!text||busy)return;
    const r=await window.desktop.rsiAsk(text);
    if(r.ok){ $('rsiText').value=''; pending=null; } else $('rsiStatus').textContent=r.error;
  });
  $('rsiText').addEventListener('keydown',function(e){ if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){ e.preventDefault(); $('rsiSend').click(); } });
  $('rsiStop').addEventListener('click',function(){ window.desktop.rsiStop(); });
  $('rsiApply').addEventListener('click',function(){ if(pending)window.desktop.rsiApply(pending.restart); });
  $('rsiUndo').addEventListener('click',async function(){
    if(!confirm('Undo the last RSI change?'))return;
    const r=await window.desktop.rsiUndo();
    if(!r.ok)$('rsiStatus').textContent=r.error; else refresh();
  });
  $('rsiNew').addEventListener('click',async function(){ await window.desktop.rsiNewChat(); pending=null; refresh(); });
  $('rsiOn').addEventListener('change',async function(){ await window.desktop.rsiSetEnabled(this.checked); refresh(); });
  refresh();
})();
/* "Hey Romulus" (phone app only): WakeWordPlugin.java / WakeWordService.java */
(function(){
  const cap=window.Capacitor;
  if(!(cap&&typeof cap.nativePromise==='function'&&cap.isPluginAvailable&&cap.isPluginAvailable('WakeWord')))return;
  const call=function(m){ return cap.nativePromise('WakeWord',m,{}); };
  $('wakeSection').hidden=false;
  function show(s){
    $('wakeOn').checked=!!s.on;
    // without "Display over other apps", Android makes you tap a notification after the chime
    $('wakeOverlayBtn').hidden=!s.on||s.overlay;
    $('wakeStatus').textContent=s.downloading?'downloading…':s.on?(s.overlay?'listening while the screen is on':'on · you’ll tap a notification to talk unless you allow this'):'';
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
  const field=ws==='agent'?'syncKeyA':ws==='school'?'syncKeyS':'syncUrlW';
  const label=ws==='agent'?'syncAgentLabel':ws==='school'?'syncSchoolLabel':null;
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
  if(e.key!=='/'||state.activeTab==='ideas')return; const a=document.activeElement; if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'))return; e.preventDefault(); $('newTitle').focus();
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
    if(state.activeTab==='calendar'||state.activeTab==='ideas')switchTab('list');
    $('searchBox').focus(); $('searchBox').select();
  }
});

/* ── keyboard navigation: arrows select, Space completes, Enter expands, Delete removes ── */
function selectNeighbor(){
  const i=navOrder.indexOf(state.selectedId);
  state.selectedId=navOrder[i+1]!==undefined?navOrder[i+1]:(i>0?navOrder[i-1]:null);
}
document.addEventListener('keydown',function(e){
  if(state.activeTab==='calendar'||state.activeTab==='ideas')return;
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
