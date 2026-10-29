/* Standing permissions (agent/standing.js): steps the Agent may do without asking again, kept in the
   ':standing' row next to the agent list (synced like the preferences). A run proposes one (`allow`) when
   his reply says "always" / "don't ask again"; it shows in the conversation with an Allow button (allowBox,
   from lists.js) and is saved only then. Settings → The Agent → Doesn't ask again lists them, with × and
   a box to add one by hand. The hard floor lives in the prompt and the browser lock: buying, sending,
   submitting and booking always wait for a yes, and such a line is refused here too.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

const STANDING_FINAL=/\b(submit|send|sends|sending|reply|forward|post|publish|message|buy|buys|buying|purchase|order|orders|ordering|pay|pays|paying|payment|check ?out|checkout|confirm|book|books|booking|reserve|apply|sign ?up|register|enroll|delete|remove|unsubscribe|cancel|transfer|donate|tip|subscribe|password|pin|card number|security code)\b/i;
const STANDING_MAX=40;
function standingProfile(){ const p=(typeof prefsProfile==='function')?prefsProfile():null; return p?Object.assign({},p,{syncKey:p.syncKey.replace(/:prefs$/,':standing')}):null; }
const standingNorm=function(l){ return String(l).toLowerCase().replace(/[^a-z0-9$.]+/g,' ').trim(); };
const standingParse=function(text){ return String(text||'').split('\n').map(function(l){ return l.replace(/^\s*-\s*/,'').trim(); }).filter(Boolean); };
const standingJoin=function(lines){ return lines.map(function(l){ return '- '+l; }).join('\n'); };
// change the row with compare-and-swap, so a line added elsewhere meanwhile isn't lost. fn(lines) → lines
async function standingEdit(fn){
  const p=standingProfile(); if(!p)throw new Error('sync isn’t set up');
  for(let attempt=0;attempt<4;attempt++){
    const row=await syncPullRow(p);
    const lines=standingParse(row.doc&&row.doc.text);
    const next=fn(lines.slice());
    if(standingJoin(next)===standingJoin(lines))return lines;
    if(await syncPushCas(p,{v:1,text:standingJoin(next)},row.updatedAt))return next;
  }
  throw new Error('changed elsewhere, try again');
}
function standingAdd(line){
  const l=String(line||'').replace(/\s+/g,' ').replace(/^\s*-\s*/,'').replace(/[.\s]+$/,'').trim().slice(0,160);
  if(!l||STANDING_FINAL.test(l))return Promise.reject(new Error(!l?'write what it may do without asking':'that is a final step: buying, sending, submitting, booking and the like always wait for your yes'));
  return standingEdit(function(lines){ if(lines.some(function(x){ return standingNorm(x)===standingNorm(l); }))return lines; return lines.concat([l]).slice(-STANDING_MAX); });
}
function standingRemove(line){ return standingEdit(function(lines){ return lines.filter(function(x){ return standingNorm(x)!==standingNorm(line); }); }); }

// in the conversation: what a run would like to stop asking about (agent-results.js puts h.allow on a sys line)
function allowBox(t,h){
  const box=el('div','conv-opts');
  box.appendChild(el('div',null,'• '+h.allow));
  if(h.allowKept)box.appendChild(el('div',null,'Allowed from now on. (Undo it in ⚙ Settings → The Agent → Doesn’t ask again.)'));
  else if(h.allowDropped)box.appendChild(el('div',null,'Not allowed: it keeps asking.'));
  else{
    const row=el('div','conv-pref-btns');
    const keep=el('button','ghost mono','Allow'), drop=el('button','ghost mono','Keep asking');
    keep.addEventListener('click',function(e){ e.stopPropagation(); keep.disabled=true;
      standingAdd(h.allow).then(function(){ h.allowKept=true; touch(); render(); if(typeof standingLoad==='function')standingLoad(); })
        .catch(function(err){ keep.disabled=false; voiceToast('Couldn’t save it: '+err.message,true); }); });
    drop.addEventListener('click',function(e){ e.stopPropagation(); h.allowDropped=true; touch(); render(); });
    row.appendChild(keep); row.appendChild(drop); box.appendChild(row);
  }
  return box;
}

// Settings → The Agent → Doesn't ask again
async function standingLoad(){
  const sec=$('standingSection'); if(!sec)return;
  const p=standingProfile(); sec.hidden=!p; if(!p)return;
  const box=$('standingList'), say=function(m){ $('standingStatus').textContent=m||''; };
  try{
    const r=await syncPullRow(p); const lines=standingParse(r.doc&&r.doc.text);
    box.innerHTML='';
    if(!lines.length){ box.appendChild(el('p','settings-hint','Nothing yet. When you tell the Agent “always” or “don’t ask next time” about a step, it offers to put it here.')); return; }
    lines.forEach(function(l){
      const row=el('div','howto'), head=el('div','howto-head'); head.style.cursor='default';
      head.appendChild(el('span','howto-task',l));
      const x=el('button','ghost howto-del','×'); x.title='Ask again from now on'; x.setAttribute('aria-label','Remove');
      x.addEventListener('click',function(){ x.disabled=true; standingRemove(l).then(standingLoad).catch(function(e){ x.disabled=false; say('couldn’t remove it ('+e.message+')'); }); });
      head.appendChild(x); row.appendChild(head); box.appendChild(row);
    });
  }catch(e){ say('could not load ('+e.message+')'); }
}
if($('standingAddBtn')){
  const add=async function(){
    const inp=$('standingAdd'), say=function(m){ $('standingStatus').textContent=m||''; };
    try{ await standingAdd(inp.value); inp.value=''; say('saved'); standingLoad(); setTimeout(function(){ say(''); },2500); }
    catch(e){ say(e.message); }
  };
  $('standingAddBtn').addEventListener('click',add);
  $('standingAdd').addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); add(); } });
}
