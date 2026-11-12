/* A backup file: everything Romulus keeps in its lists, saved as one file you hold, and put back from it.
   Settings → Backup file. In the file: to-dos, Agent, School and Work tasks, notes, hours, the health totals and
   the Kitchen tab. Not in it: Finance, keys and connected accounts (they never leave main/store.js), the Group
   list (it belongs to the group) and Settings. The file is not encrypted: it is his to keep somewhere private.
   Restoring merges, the way sync does: anything missing comes back, whichever copy of a task is newer stays, and
   what was deleted here after the backup was made stays deleted. So restoring can't lose newer work, and a file
   restored twice adds nothing the second time.
   An Agent task that was waiting to run when the backup was made, and isn't here any more, comes back asking
   first instead of running again by itself.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists
   them. The parts without page globals are also loaded by test/backup.test.js. */
'use strict';

const BACKUP_KIND='romulus-backup';
const BACKUP_WS=['personal','work','agent','school'];
function backupWs(t){ return BACKUP_WS.indexOf(t&&t.ws)!==-1?t.ws:(t&&t.ws==='family'?'family':'personal'); }
// the Kitchen tab without its photo asks: one still waiting would be read by an AI again after a restore
function backupKitchen(k){ return k&&typeof k==='object'?Object.assign({},k,{asks:[]}):null; }
// → the object written to the file
function backupMake(doc,now,appVersion){
  doc=doc||{};
  return {kind:BACKUP_KIND,v:1,at:now||Date.now(),app:appVersion||null,doc:{v:1,
    tasks:(Array.isArray(doc.tasks)?doc.tasks:[]).filter(function(t){ return t&&t.id&&backupWs(t)!=='family'; }),
    tombstones:Array.isArray(doc.tombstones)?doc.tombstones:[],
    ideas:doc.ideas||null,hours:doc.hours||null,health:doc.health||null,kitchen:backupKitchen(doc.kitchen)}};
}
function backupFileName(now){
  const d=new Date(now||Date.now());
  return 'Romulus backup '+d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+'.json';
}
// the text of a chosen file → {ok:true, at, doc} or {ok:false, error}
function backupRead(text){
  let b=null;
  try{ b=JSON.parse(String(text||'').replace(/^﻿/,'')); }catch(e){}
  if(!b||typeof b!=='object')return {ok:false,error:'That file couldn’t be read. Choose a file saved with Save a backup file.'};
  if(b.kind!==BACKUP_KIND||!b.doc||!Array.isArray(b.doc.tasks))return {ok:false,error:'That isn’t a Romulus backup file. To bring tasks from another app, use Import tasks.'};
  if(Number(b.v)>1)return {ok:false,error:'That backup was made by a newer Romulus. Update this one first.'};
  const d=b.doc;
  return {ok:true,at:Number(b.at)||null,doc:{
    tasks:d.tasks.filter(function(t){ return t&&typeof t==='object'&&typeof t.id==='string'&&t.id&&backupWs(t)!=='family'; }),
    tombstones:(Array.isArray(d.tombstones)?d.tombstones:[]).filter(function(x){ return x&&x.id&&x.deletedAt; }),
    ideas:d.ideas||null,hours:d.hours||null,health:d.health||null,kitchen:backupKitchen(d.kitchen)}};
}
// what is in a backup, in words: "214 tasks, 12 notes, 30 hours entries"
function backupSay(doc){
  const n=function(k,one,many){ return k?k.toLocaleString('en-US')+' '+(k===1?one:many):''; };
  const len=function(a){ return Array.isArray(a)?a.length:0; };
  const i=doc.ideas||{}, k=doc.kitchen||{};
  const parts=[n(len(doc.tasks),'task','tasks'),n(len(i.cards),'note','notes'),n(len((doc.hours||{}).entries),'hours entry','hours entries'),
    n(len(k.items),'pantry food','pantry foods'),n(len(k.recipes),'recipe','recipes'),
    n(Object.keys((doc.health||{}).days||{}).length,'day of health totals','days of health totals')].filter(Boolean);
  return parts.length?parts.join(', '):'nothing';
}
/* The backup's tasks as they go into the merge. haveIds: the ids on this device now. An Agent task that isn't
   here and was queued or running in the backup would start by itself once restored: it comes back asking first. */
function backupForRestore(doc,haveIds,now){
  const have=haveIds||{};
  return doc.tasks.map(function(t){
    if(backupWs(t)!=='agent'||have[t.id]||t.done||(t.status!=='queued'&&t.status!=='working'))return t;
    const c=Object.assign({},t,{status:'needs-you',note:'Brought back from a backup file. It has not run again: reply to start it, or tick it off.',updatedAt:t.updatedAt||now||Date.now()});
    delete c.claimedBy; delete c.claimedAt; delete c.runFrom;
    return c;
  });
}

if(typeof module!=='undefined'&&module.exports){
  module.exports={backupMake:backupMake,backupFileName:backupFileName,backupRead:backupRead,backupSay:backupSay,backupForRestore:backupForRestore};
}

/* ── the page: Settings → Backup file ── */
if(typeof document!=='undefined')(function(){
  const saveBtn=$('backupSaveBtn'); if(!saveBtn)return;
  const pick=$('backupPickBtn'), input=$('backupFile'), go=$('backupRestoreBtn'), status=$('backupStatus');
  const say=function(s,bad){ status.textContent=s||''; status.style.color=bad?'var(--late)':''; };
  let pending=null;
  const offer=function(p){ pending=p; go.hidden=!p; };
  const day=function(at){ return at?new Date(at).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}):'an unknown day'; };

  saveBtn.addEventListener('click',function(){
    if(state.loadFailed){ say('Your tasks couldn’t be read at start-up, so there is nothing safe to save. Restart Romulus first.',true); return; }
    offer(null);
    const b=backupMake(currentDoc(),Date.now());
    const file=new File([JSON.stringify(b)],backupFileName(b.at),{type:'application/json'});
    say('Saved '+backupSay(b.doc)+'. The file isn’t encrypted: keep it somewhere private.');
    // the phone: hand it to the Share menu (Files, Drive…), else a plain download
    if(window.Capacitor&&navigator.canShare&&navigator.canShare({files:[file]})){ navigator.share({files:[file],title:file.name}).catch(function(){ say(''); }); return; }
    const a=document.createElement('a'); a.href=URL.createObjectURL(file); a.download=file.name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){ URL.revokeObjectURL(a.href); },5000);
  });
  pick.addEventListener('click',function(){ input.value=''; input.click(); });
  input.addEventListener('change',async function(){
    const f=input.files&&input.files[0]; if(!f)return;
    offer(null);
    let text='';
    try{ text=await f.text(); }catch(e){ say('That file couldn’t be opened.',true); return; }
    const r=backupRead(text);
    if(!r.ok){ say(r.error,true); return; }
    offer(r);
    say('This backup is from '+day(r.at)+': '+backupSay(r.doc)+'. Restoring adds back what is missing and keeps anything newer here.');
  });
  go.addEventListener('click',function(){
    const r=pending; if(!r)return;
    offer(null);
    if(state.loadFailed){ say('Your tasks couldn’t be read at start-up. Restart Romulus, then restore.',true); return; }
    const d=r.doc, have={}, before=state.tasks.length;
    state.tasks.forEach(function(t){ have[t.id]=1; });
    const tasks=backupForRestore(d,have,Date.now());
    let changed=false, rest=false;
    BACKUP_WS.forEach(function(ws){
      const mine=tasks.filter(function(t){ return backupWs(t)===ws; }).map(stripWs);
      if(mergeRemoteWs({v:1,tasks:mine,tombstones:d.tombstones},ws).changedLocal)changed=true;
    });
    if(d.ideas&&mergeIdeas(d.ideas).changedLocal)rest=true;
    if(d.hours&&mergeHours(d.hours).changedLocal)rest=true;
    if(d.health&&mergeHealth(d.health).changedLocal)rest=true;
    if(d.kitchen){ const k=mergeKitchenDocs(state.kitchen,d.kitchen); if(k.changedLocal){ state.kitchen=k.merged; rest=true; } }
    if(!changed&&!rest){ say('Everything in that backup is already here. Nothing changed.'); return; }
    rebuildSnap(); persist(); renderActive();
    const back=state.tasks.length-before;
    say('Restored. '+(back>0?back.toLocaleString('en-US')+(back===1?' task came back.':' tasks came back.'):changed?'Older copies of some tasks were brought up to date.':'No tasks were missing.')+(rest?' Notes, hours, health totals or the Kitchen tab were filled in too.':''));
  });
})();
