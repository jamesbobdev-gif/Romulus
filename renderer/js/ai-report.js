/* Report an AI reply: the app stores policies (Google Play's AI-generated content rule) want a way, inside the app, to
   flag a reply that is offensive or harmful. A "Report" link sits under every AI reply in a task's conversation;
   tapping it opens a small box in the panel (not window.confirm: on Windows a native dialog leaves the page deaf to
   the keyboard afterwards) that says what is sent, then Send report posts it to the Romulus server
   (window.ROMULUS_PAIR, the project official builds sync through) as ai_report
   (supabase/migrations/20261114_ai_reports.sql). Only that one reply's text, which AI wrote it and the reason
   go: not the task, the rest of the conversation or any sync key. A build with no Romulus server (one built
   from source without it) points at the repository's issues page instead. */

const AI_REPORT_REASONS=[['offensive','Offensive or hateful'],['harmful','Harmful or dangerous'],['sexual','Sexual content'],['wrong','Wrong or misleading'],['other','Something else']];
const AI_REPORT_ISSUES='https://github.com/jamesbobdev-gif/Romulus/issues';
const aiReportOpen=new Set(); // "taskId:at" of the boxes open now, so a redraw keeps them open

function aiReportId(t,h){ return String(t&&t.id)+':'+String(h&&h.at); }
// what is sent: just this reply, trimmed to the 6000 characters an answer keeps
function aiReportBody(h,reason){
  const r=AI_REPORT_REASONS.some(function(x){ return x[0]===reason; })?reason:'other';
  return {p_via:String((h&&h.via)||(h&&h.lane==='local'?'local':'claude')).slice(0,40),
    p_model:String((h&&h.model)||'').replace(/^models\//,'').slice(0,120),
    p_reply:String((h&&h.text)||'').slice(0,6000),
    p_reason:r};
}
function aiReportServer(){ const p=typeof window!=='undefined'&&window.ROMULUS_PAIR; return p&&p.url&&p.key?{url:p.url,key:p.key}:null; }
async function aiReportSend(body){
  const s=aiReportServer();
  if(!s)return {ok:false,noServer:true};
  try{
    const res=await fetch(s.url.replace(/\/+$/,'')+'/rest/v1/rpc/ai_report',{method:'POST',
      headers:{'apikey':s.key,'Authorization':'Bearer '+s.key,'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(res.ok)return {ok:true};
    const txt=await res.text().catch(function(){ return ''; });
    return {ok:false,error:/report_limit/.test(txt)?'too many reports from this network today; try again tomorrow':'the server said '+res.status};
  }catch(e){ return {ok:false,error:'no connection'}; }
}

// the "Report" link plus, once tapped, the box; h.reported (saved in the task's history) shows "Reported" instead
function aiReportControl(t,h){
  const wrap=el('div','ai-report');
  if(h.reported){ wrap.appendChild(el('span','ai-report-done','Reported. Thank you.')); return wrap; }
  const id=aiReportId(t,h);
  if(!aiReportOpen.has(id)){
    const a=el('button','ai-report-link','Report');
    a.title='Report this reply as offensive, harmful or wrong';
    a.addEventListener('click',function(e){ e.stopPropagation(); aiReportOpen.add(id); render(); });
    wrap.appendChild(a);
    return wrap;
  }
  const box=el('div','ai-report-box');
  const server=aiReportServer();
  box.appendChild(el('div',null,server
    ?'Send this reply to the Romulus developer? Only this reply, which AI wrote it and the reason you pick are sent. Your task and the rest of the conversation stay here.'
    :'This build has no Romulus server to send reports to. You can report it on the Romulus issues page instead (copy only what you are comfortable sharing).'));
  const close=function(){ aiReportOpen.delete(id); render(); };
  const row=el('div','ai-report-row');
  if(server){
    const sel=el('select','ai-report-reason');
    sel.setAttribute('aria-label','Why');
    AI_REPORT_REASONS.forEach(function(r){ const o=el('option',null,r[1]); o.value=r[0]; sel.appendChild(o); });
    sel.addEventListener('click',function(e){ e.stopPropagation(); });
    const send=el('button','doc-dl','Send report');
    send.addEventListener('click',async function(e){
      e.stopPropagation(); send.disabled=true; send.textContent='Sending…';
      const r=await aiReportSend(aiReportBody(h,sel.value));
      if(r.ok){ h.reported=Date.now(); aiReportOpen.delete(id); if(typeof touch==='function')touch(); else render(); pasteToast('Reported. Thank you.'); }
      else { send.disabled=false; send.textContent='Send report'; pasteToast('Couldn’t send the report: '+(r.error||'something went wrong')); }
    });
    row.appendChild(sel); row.appendChild(send);
  } else {
    const go=el('button','doc-dl','Open the issues page');
    go.addEventListener('click',function(e){ e.stopPropagation(); if(typeof openExternal==='function')openExternal(AI_REPORT_ISSUES); else window.open(AI_REPORT_ISSUES,'_blank'); close(); });
    row.appendChild(go);
  }
  const cancel=el('button','btn-ghost ai-report-link','Cancel');
  cancel.addEventListener('click',function(e){ e.stopPropagation(); close(); });
  row.appendChild(cancel);
  box.appendChild(row);
  wrap.appendChild(box);
  return wrap;
}

if(typeof module!=='undefined')module.exports={aiReportBody,aiReportId,AI_REPORT_REASONS};
