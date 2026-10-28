/* ── what it will post, before he says yes ──
   When the Agent typed something for him to post or send (a discussion post, a message) and waits on
   his yes, it sends the exact words as t.draft: {text, where}. They show in full in a box he can edit.
   Yes as it is answers "yes"; with his edits it answers yes with his text, which the Agent types in
   place of its own before the final click (agent/local-lane.js, instant-prompt.md). His edits are kept
   per task while the app is open (draftEdits), not synced; a new answer starts them over. */
'use strict';
const draftEdits={}; // task id → his version of the text, while it differs from the Agent's

function hasDraft(t){ return !!(t.draft&&typeof t.draft.text==='string'&&t.draft.text.trim()); }
function draftWords(s){ return String(s||'').trim().split(/\s+/).filter(Boolean).length; }
// the reply his edited version goes back as: a yes first (that's what unlocks the final click), then the text
function draftReply(text){ return 'yes, but first replace what you typed with exactly this text, then post it:\n\n'+text.trim(); }

function draftBox(t){
  const box=el('div','draft-box');
  box.addEventListener('click',function(e){ e.stopPropagation(); });
  box.appendChild(el('div','draft-head','What it will post'+(t.draft.where?' · '+t.draft.where:'')));
  const ta=document.createElement('textarea');
  ta.className='draft-text'; ta.dataset.draftFor=t.id; ta.spellcheck=true;
  ta.value=draftEdits[t.id]!=null?draftEdits[t.id]:t.draft.text;
  box.appendChild(ta);
  const foot=el('div','draft-foot');
  const count=el('span','draft-count');
  const undo=el('button','draft-undo','Undo my edits');
  undo.title='Back to what the Agent wrote';
  foot.appendChild(count); foot.appendChild(undo);
  box.appendChild(foot);
  const go=el('button','btn-accent agent-yes');
  box.appendChild(go);
  // grows with the text, so the whole post reads without a scrollbar of its own (up to most of the screen)
  const fit=function(){ ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight+2,window.innerHeight*0.7)+'px'; };
  const update=function(){
    const edited=draftEdits[t.id]!=null;
    count.textContent=draftWords(ta.value)+' words'+(edited?' · edited':'');
    undo.hidden=!edited;
    go.textContent=!ta.value.trim()?'Nothing to post':edited?'Yes, post my version':'Yes, post it';
    go.disabled=!ta.value.trim();
    go.title=edited?'The Agent swaps in your text, then posts it':'Answer yes: the Agent posts exactly this';
  };
  ta.addEventListener('input',function(){
    if(ta.value.trim()===t.draft.text.trim())delete draftEdits[t.id]; else draftEdits[t.id]=ta.value;
    update(); fit();
  });
  undo.addEventListener('click',function(){ delete draftEdits[t.id]; ta.value=t.draft.text; update(); fit(); ta.focus(); });
  go.addEventListener('click',function(){
    const lt=liveTask(t), edited=draftEdits[t.id]!=null, msg=edited?draftReply(ta.value):'yes';
    lt.reply=msg; agentSay(lt,'you',msg); lt.status='queued'; delete draftEdits[t.id];
    buzz('send'); touch();
  });
  update();
  requestAnimationFrame(fit); // its height needs it on the page
  return box;
}
