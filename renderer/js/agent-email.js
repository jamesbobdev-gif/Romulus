/* ── an email the Agent wrote, sent only by his Send ──
   The Agent ends its run "needs-you" with t.email ({to, cc, subject, body}) and never sends anything itself.
   This card shows the whole email, editable, and Send goes out from his own Gmail or Outlook through the
   computer that holds the account (window.desktop.mailSend → agent/mail-send.js).
   His edits are kept per task while the app is open (emailEdits), not synced. */
'use strict';
const emailEdits={}; // task id → {to, cc, subject, body} while he's changing it

function hasEmail(t){
  return taskWs(t)==='agent'&&!t.done&&t.status==='needs-you'&&!!(t.email&&Array.isArray(t.email.to)&&t.email.to.length&&t.email.body);
}
function emailList(s){ return String(s||'').split(/[,;\s]+/).map(function(x){ return x.trim(); }).filter(Boolean); }

function emailBox(t){
  const box=el('div','draft-box email-box');
  box.addEventListener('click',function(e){ e.stopPropagation(); });
  const cur=emailEdits[t.id]||{to:t.email.to.join(', '),cc:(t.email.cc||[]).join(', '),subject:t.email.subject||'',body:t.email.body};
  box.appendChild(el('div','draft-head','The email it wrote · nothing is sent until you press Send'));
  const field=function(label,key){
    const row=el('label','email-row'); row.appendChild(el('span','email-label',label));
    const inp=document.createElement('input'); inp.className='settings-inp email-inp'; inp.value=cur[key]; inp.spellcheck=key==='subject';
    inp.addEventListener('input',function(){ cur[key]=inp.value; emailEdits[t.id]=cur; update(); });
    row.appendChild(inp); box.appendChild(row); return inp;
  };
  field('To','to'); field('Cc','cc'); field('Subject','subject');
  const ta=document.createElement('textarea'); ta.className='draft-text'; ta.value=cur.body; ta.spellcheck=true;
  ta.addEventListener('input',function(){ cur.body=ta.value; emailEdits[t.id]=cur; update(); fit(); });
  box.appendChild(ta);
  const foot=el('div','draft-foot');
  const from=document.createElement('select'); from.className='settings-inp email-from'; from.hidden=true;
  const status=el('span','draft-count');
  foot.appendChild(from); foot.appendChild(status); box.appendChild(foot);
  const go=el('button','btn-accent agent-yes','Send');
  box.appendChild(go);
  const canSendHere=!!(window.desktop&&window.desktop.mailSend);
  const fit=function(){ ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight+2,window.innerHeight*0.6)+'px'; };
  const update=function(){
    const n=emailList(cur.to).length+emailList(cur.cc).length;
    go.disabled=!canSendHere||!emailList(cur.to).length||!cur.body.trim()||n>10||!from.options.length;
    go.textContent=emailList(cur.to).length?'Send to '+emailList(cur.to).join(', '):'Send';
  };
  if(!canSendHere){ status.textContent='Open the app on your computer to send it'; }
  else window.desktop.mailSendAccounts().then(function(r){
    (r&&r.accounts||[]).forEach(function(a){ const o=document.createElement('option'); o.value=a.id; o.textContent='From '+(a.email||a.provider); from.appendChild(o); });
    from.hidden=from.options.length<2; from.style.display=from.hidden?'none':''; // .settings-inp's display would show it anyway
    if(!from.options.length){
      // a link straight to Settings → Calendars, where Connect asks Google or Microsoft for sending too
      const a=el('a','email-connect',r&&r.needReconnect&&r.needReconnect.length
        ?'Connect '+r.needReconnect[0]+' again and allow sending'
        :'Connect Gmail or Outlook to send email');
      a.href='#'; a.title='Opens Settings → Calendars & email';
      a.addEventListener('click',function(e){ e.preventDefault(); e.stopPropagation(); if(window.openConnect)window.openConnect(r&&r.needReconnect&&r.needReconnect.length?null:'google'); else openSettingsAt('calGroup','gcalSection'); });
      status.textContent=''; status.appendChild(a);
    }
    else if(from.options.length===1)status.textContent=from.options[0].textContent;
    update();
  }).catch(function(){ status.textContent='Couldn’t check which accounts can send'; });
  go.addEventListener('click',async function(){
    go.disabled=true; status.textContent='sending…';
    const email={to:emailList(cur.to),cc:emailList(cur.cc),subject:cur.subject,body:cur.body};
    let r; try{ r=await window.desktop.mailSend({task:t.title,from:from.value,email:email}); }catch(e){ r={error:e.message}; }
    if(!r||!r.ok){ status.textContent='Not sent: '+((r&&r.error)||'unknown error'); update(); return; }
    const lt=liveTask(t), who=r.to.concat(r.cc||[]).join(', ');
    agentSay(lt,'you','Sent the email “'+(email.subject||'(no subject)')+'” to '+who+(r.from?' from '+r.from:''));
    lt.note='Sent to '+who+'.'; lt.status='done'; lt.email=null; lt.updatedAt=Date.now();
    delete emailEdits[t.id];
    buzz('send'); touch();
  });
  update();
  requestAnimationFrame(fit);
  return box;
}
