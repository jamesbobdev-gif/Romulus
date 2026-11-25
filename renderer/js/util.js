/* Small helpers that page scripts each used to write for themselves: the local date as "2026-11-16",
   escaping text for HTML, bytes to and from base64, and shrinking a picture before it is sent or saved.
   Loaded first, so every other page script can use them. agent/util.js has the same date and escape
   helpers for agent/ and main/ (test/util.test.js checks the two agree).
   A file a test loads on its own reaches these with
   (typeof dayKey==='function'?dayKey:require('./util').dayKey), as finance-bills.js does for its costs. */

function utilPad2(n){ return String(n).padStart(2,'0'); }
// a Date or a time in ms → "YYYY-MM-DD" on this device's clock (not UTC)
function dayKey(d){ const t=d instanceof Date?d:new Date(d); return t.getFullYear()+'-'+utilPad2(t.getMonth()+1)+'-'+utilPad2(t.getDate()); }
// a Date or a time in ms → "YYYY-MM"
function monthKey(d){ const t=d instanceof Date?d:new Date(d); return t.getFullYear()+'-'+utilPad2(t.getMonth()+1); }
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
// bytes (Uint8Array or ArrayBuffer) → base64, in chunks so a big picture doesn't overflow the call stack
function bytesToB64(bytes){
  const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes); let s='';
  for(let i=0;i<b.length;i+=0x8000)s+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000));
  return btoa(s);
}
// base64 (or base64url, padding optional) → Uint8Array
function b64ToBytes(s){
  const t=String(s).replace(/-/g,'+').replace(/_/g,'/'), bin=atob(t+'==='.slice((t.length+3)%4)), out=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);
  return out;
}

/* a picture file → a canvas at most maxSide px on its long side. Rejects with Error(badText) when the
   file isn't a picture the browser can read. */
function pictureCanvas(file,maxSide,badText){
  return new Promise(function(ok,fail){
    const url=URL.createObjectURL(file), im=new Image();
    im.onload=function(){
      const k=Math.min(1,maxSide/Math.max(im.naturalWidth,im.naturalHeight));
      const c=document.createElement('canvas'); c.width=Math.max(1,Math.round(im.naturalWidth*k)); c.height=Math.max(1,Math.round(im.naturalHeight*k));
      c.getContext('2d').drawImage(im,0,0,c.width,c.height); URL.revokeObjectURL(url);
      ok(c);
    };
    im.onerror=function(){ URL.revokeObjectURL(url); fail(new Error(badText||'not a picture')); };
    im.src=url;
  });
}
// → {mime:'image/jpeg', b64}, for sending to an AI
function pictureB64(file,maxSide,badText){
  return pictureCanvas(file,maxSide,badText).then(function(c){ return {mime:'image/jpeg',b64:c.toDataURL('image/jpeg',0.85).split(',')[1]}; });
}
// → a JPEG Blob, for uploading or saving
function pictureBlob(file,maxSide,badText){
  return pictureCanvas(file,maxSide,badText).then(function(c){
    return new Promise(function(ok,fail){ c.toBlob(function(b){ if(b)ok(b); else fail(new Error(badText||'not a picture')); },'image/jpeg',0.85); });
  });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { dayKey, monthKey, escapeHtml, bytesToB64, b64ToBytes, pictureCanvas, pictureB64, pictureBlob };
