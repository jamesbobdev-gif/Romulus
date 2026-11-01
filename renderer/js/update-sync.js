/* The answer to "Romulus 1.0.9 is out", shared by every device through sync: a yes on one updates them all,
   and a Not now isn't asked again on the others. It lives in its own row next to the personal list
   (<personal key>:updates, supabase/migrations/20261031_sync_updates_key.sql) as {v:1, yes, no}:
   yes = the newest version he said Update to (it covers every version up to it), no = the last one he said
   Not now to. The computers follow it in update-desktop.js; the phone in mobile/update-phone.js.
   Until the database takes the row (that migration), reads come back empty and writes are refused: each
   device then just asks on its own.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

// 1.0.10 is newer than 1.0.9; a 'v' in front is ignored
function versionNewer(candidate,current){
  const a=String(candidate||'').replace(/^v/i,'').split('.').map(Number), b=String(current||'').replace(/^v/i,'').split('.').map(Number);
  for(let i=0;i<Math.max(a.length,b.length);i++){
    const x=a[i]||0, y=b[i]||0;
    if(isNaN(x)||isNaN(y))return false;
    if(x!==y)return x>y;
  }
  return false;
}
// what the shared answer says about this version: 'yes' | 'no' | null (not answered anywhere yet)
function updateAnswer(doc,version){
  if(!doc||!version)return null;
  if(doc.yes&&!versionNewer(version,doc.yes))return 'yes';
  if(doc.no===version)return 'no';
  return null;
}
function updatesProfile(){
  const p=syncState.cfg&&syncState.cfg.personal;
  return validProfile(p)?{url:p.url,key:p.key,syncKey:p.syncKey+':updates'}:null;
}
// the shared answer, or null (no sync, offline, or the database doesn't take the row yet)
async function updateChoiceRead(){
  if(syncState.ready)await syncState.ready;
  const p=updatesProfile(); if(!p)return null;
  try{ return (await syncPullRow(p)).doc||null; }catch(e){ return null; }
}
// tell the other devices: answer 'yes' or 'no' to this version
async function updateChoiceWrite(answer,version){
  if(syncState.ready)await syncState.ready;
  const p=updatesProfile(); if(!p||!version)return false;
  try{
    for(let attempt=0;attempt<4;attempt++){ // compare-and-swap, so a yes from another device meanwhile isn't lost
      const row=await syncPullRow(p);
      const doc=Object.assign({v:1,yes:null,no:null},row.doc||{});
      if(answer==='yes'){ if(updateAnswer(doc,version)==='yes')return true; doc.yes=version; }
      else{ if(updateAnswer(doc,version))return true; doc.no=version; } // a yes from elsewhere beats a later Not now
      if(await syncPushCas(p,doc,row.updatedAt))return true;
    }
  }catch(e){}
  return false;
}
