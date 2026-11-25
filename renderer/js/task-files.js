/* Photos and files on any task (the receipt, the shelf you need, the part number, a PDF), for everyone who syncs.
   Each file is encrypted on the device with a key of its own (AES-GCM) before it goes up; that key is kept only in
   the task (t.files), and the task travels sealed like every list, so the server and anyone who finds a file's
   address see only ciphertext under a random name. Photos are shrunk first (shrinkImage, agent-chat.js).
   Files go to the task-files bucket of the project the lists sync with, in a folder named after the account
   ('acct_' + a hash of the key's id part, as sync_account_of in supabase/setup.sql), which is how the Romulus
   server counts them toward the account's space (supabase/migrations/20261109_task_files.sql). They stay as long
   as the task has them. Older photos (t.images, the agent-attachments bucket) still show as before.
   A t.files entry: {id, name, type, size, path, k, iv, at}. Loads after agent-chat.js and sync-crypto.js. */
'use strict';

const TASK_FILES_MAX=12;                 // files on one task
const TASK_FILE_MAX_BYTES=10*1024*1024;  // one file, as the bucket allows
function taskFileProfile(){ const p=syncState.cfg&&syncState.cfg.personal; return validProfile(p)?p:null; }
function taskFilesOn(){ return !!(taskFileProfile()&&window.crypto&&crypto.subtle); }
function taskFileBase(p){ return String(p.url).replace(/\/+$/,''); }
function tfB64u(bytes){ return syncB64Url(bytes); }
function tfUnB64u(s){ s=String(s).replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4)s+='='; return syncUnB64(s); }
// the account folder for a row key (pure, for tests): the same hash the database counts space by
async function taskFilesFolder(rowKey){
  const id=String(rowKey).replace(/^tk_(work_|agent_|school_)?/,'').replace(/:.*$/,'');
  const h=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id));
  return 'acct_'+Array.from(new Uint8Array(h),function(b){ return b.toString(16).padStart(2,'0'); }).join('');
}
function taskFileName(){ return tfB64u(crypto.getRandomValues(new Uint8Array(18))); } // random, url-safe
// encrypt / decrypt one file's bytes (pure, for tests)
async function taskFileSeal(bytes){
  const raw=crypto.getRandomValues(new Uint8Array(32)), iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']);
  const ct=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:iv},key,bytes));
  return {ct:ct,k:tfB64u(raw),iv:tfB64u(iv)};
}
async function taskFileOpenBytes(ct,k,iv){
  const key=await crypto.subtle.importKey('raw',tfUnB64u(k),'AES-GCM',false,['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:tfUnB64u(iv)},key,ct));
}
// what a refused upload means, in words (pure, for tests). Storage says "row-level security" when the upload
// rule said no, which on the Romulus server means the account is full; "Bucket not found" on a project whose
// setup.sql is older than photos on any task.
function taskFileError(status,text){
  text=String(text||'');
  if(/bucket not found/i.test(text))return 'this sync project has no place for files yet: run the latest setup.sql in it';
  if(status===413||/too large|maximum allowed size/i.test(text))return 'that file is over 10 MB';
  if(status===401||status===403||/row-level security|unauthorized/i.test(text))return 'your online space is full (Settings > Device sync shows it)';
  return 'upload failed ('+status+')';
}
// one picked/pasted/dropped file → a t.files entry, uploaded
async function taskFileUpload(file){
  const p=taskFileProfile(); if(!p)throw new Error('sync isn’t set up');
  let blob=file, type=file.type||'application/octet-stream', name=file.name||'file';
  if(/^image\//.test(type)&&!/^image\/(gif|svg)/.test(type)){ blob=await shrinkImage(file); type='image/jpeg'; name=name.replace(/\.[^.]+$/,'')+'.jpg'; }
  if(blob.size>TASK_FILE_MAX_BYTES)throw new Error('that file is over 10 MB');
  const sealed=await taskFileSeal(new Uint8Array(await blob.arrayBuffer()));
  const path=(await taskFilesFolder(await syncRowKey(p)))+'/'+taskFileName();
  const r=await fetch(taskFileBase(p)+'/storage/v1/object/task-files/'+path,{method:'POST',headers:{apikey:p.key,Authorization:'Bearer '+p.key,'Content-Type':'application/octet-stream'},body:sealed.ct});
  if(!r.ok){ let txt=''; try{ txt=await r.text(); }catch(e){} throw new Error(taskFileError(r.status,txt)); }
  return {id:uid(),name:String(name).slice(0,120),type:type,size:blob.size,path:path,k:sealed.k,iv:sealed.iv,at:Date.now()};
}
// a file's bytes back, decrypted, as an object URL (kept while the app runs)
const taskFileUrls={};
async function taskFileUrl(f){
  if(taskFileUrls[f.id])return taskFileUrls[f.id];
  const p=taskFileProfile(); if(!p)throw new Error('sync isn’t set up');
  const r=await fetch(taskFileBase(p)+'/storage/v1/object/public/task-files/'+f.path);
  if(!r.ok)throw new Error(r.status===404||r.status===400?'that file is gone from the server':'couldn’t load it ('+r.status+')');
  const bytes=await taskFileOpenBytes(new Uint8Array(await r.arrayBuffer()),f.k,f.iv);
  return (taskFileUrls[f.id]=URL.createObjectURL(new Blob([bytes],{type:f.type||'application/octet-stream'})));
}
// remove files from the server: on the Romulus server through task-files-remove (the app's key can't delete
// there), on a project of one's own straight from storage. Best effort: a file left behind only takes space.
async function taskFilesRemove(files){
  const p=taskFileProfile(); const paths=(files||[]).map(function(f){ return f&&f.path; }).filter(Boolean);
  if(!p||!paths.length)return;
  const base=taskFileBase(p), h={apikey:p.key,Authorization:'Bearer '+p.key,'Content-Type':'application/json'};
  try{
    const r=await fetch(base+'/functions/v1/task-files-remove',{method:'POST',headers:h,body:JSON.stringify({key:await syncRowKey(p),paths:paths})});
    if(r.ok)return;
  }catch(e){}
  try{ await fetch(base+'/storage/v1/object/task-files',{method:'DELETE',headers:h,body:JSON.stringify({prefixes:paths})}); }catch(e){}
}
// a task going away takes its files with it
function taskFilesForget(t){ if(t&&Array.isArray(t.files)&&t.files.length)taskFilesRemove(t.files); }
function taskFileSize(n){ n=Number(n)||0; return n>=1048576?(n/1048576).toFixed(1).replace(/\.0$/,'')+' MB':Math.max(1,Math.round(n/1024))+' KB'; }
function taskFileIsImage(f){ return /^image\//.test(f&&f.type||''); }
// open a file: photos in the lightbox, anything else saved/opened by the system
async function taskFileShow(t,f){
  try{
    const url=await taskFileUrl(f);
    if(taskFileIsImage(f)){
      const pics=(t.files||[]).filter(taskFileIsImage);
      const urls=await Promise.all(pics.map(function(x){ return taskFileUrl(x).catch(function(){ return null; }); }));
      openLightbox(pics.map(function(x,i){ return {image:urls[i],label:x.name}; }),pics.indexOf(f));
      return;
    }
    const a=document.createElement('a'); a.href=url; a.download=f.name||'file'; document.body.appendChild(a); a.click(); a.remove();
  }catch(e){ pasteToast('Couldn’t open it: '+e.message); }
}
/* Photos from a task handed to the Agent: Claude can't open encrypted files, so a plain copy of each photo goes
   to the Agent's own photo folder (agent-attachments, removed after 30 days) and into the task's conversation. */
async function taskFilesToAgent(c){
  const pics=(c.files||[]).filter(taskFileIsImage).slice(0,6);
  if(!pics.length||!attachProfile())return;
  const urls=[];
  for(const f of pics){
    try{ const blob=await (await fetch(await taskFileUrl(f))).blob(); urls.push(await uploadAttachment(blob)); }catch(e){}
  }
  if(!urls.length)return;
  const lt=liveTask(c);
  lt.replyImages=(lt.replyImages||[]).concat(urls).slice(0,6);
  lt.history=(lt.history||[]).concat([{who:'you',text:'Photos from the task',at:Date.now(),images:urls}]);
  touch();
}

if(typeof module!=='undefined')module.exports={taskFilesFolder,taskFileSeal,taskFileOpenBytes,taskFileError,taskFileSize};
