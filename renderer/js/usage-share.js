/* The Usage card's readings, shared between his devices. Sign-ins and keys stay on each computer, so one
   with no AI signed in (the mini PC, say) had nothing to show, though it is the same accounts. A computer
   that can read an AI's usage posts the rows it draws in its entry of the ':devices' row (devices.js),
   encrypted like the rest of it; a device with no reading of its own for that AI shows the newest one
   another device posted, and says where it came from. Only what the card shows travels: percentages,
   counts and reset times. No key or sign-in does.
   All of it is plain logic, module-loadable for test/usage-share.test.js. */
'use strict';

const USAGE_SHARE_EVERY=15*60*1000; // changed numbers go up at most this often: every write wakes the other devices
const USAGE_SHARE_KEEP=24*60*60*1000; // a reading older than this isn't shown

/* the card's rows ({id, name, pct, text, out, share}) → what this device posts: {at, rows:{id:[{name,pct,text,out,until}]}}.
   share marks a row that is a real reading: true, or the time (ms) it resets. null when there's none to post */
function usageShareMine(rows,now){
  const by={};
  (rows||[]).forEach(function(r){
    if(!r||!r.share||!r.id)return;
    const o={name:String(r.name||''),pct:r.pct==null?null:Math.round(r.pct*1000)/1000,text:String(r.text||''),out:!!r.out};
    if(typeof r.share==='number')o.until=r.share;
    (by[r.id]=by[r.id]||[]).push(o);
  });
  return Object.keys(by).length?{at:now,rows:by}:null;
}
// the rows alone, in a fixed order: the database hands a document's keys back in its own order
function usageShareSig(u){
  const rows=(u&&u.rows)||{};
  return JSON.stringify(Object.keys(rows).sort().map(function(id){
    return [id,(rows[id]||[]).map(function(r){ return [r.name,r.pct==null?null:r.pct,r.text,r.out?1:0,r.until||0]; })];
  }));
}
// should this device's entry be written again for its usage: a first reading at once, changed ones every 15 minutes
function usageShareChanged(old,mine,now){
  if(!mine)return false; // nothing to post; what was posted before ages out by itself
  if(!old||!old.rows)return true;
  if(usageShareSig(old)===usageShareSig(mine))return false;
  return now-(old.at||0)>=USAGE_SHARE_EVERY;
}
// the newest reading of each AI that another device posted: {id: {rows, from, at}}
function usageShareOthers(doc,myId,now){
  const out={}, d=(doc&&doc.devices)||{};
  Object.keys(d).forEach(function(dev){
    const u=d[dev]&&d[dev].usage;
    if(dev===myId||!u||!u.rows||!(now-(u.at||0)<USAGE_SHARE_KEEP))return;
    Object.keys(u.rows).forEach(function(id){
      if(!Array.isArray(u.rows[id])||!u.rows[id].length)return;
      if(!out[id]||out[id].at<u.at)out[id]={rows:u.rows[id],from:d[dev].name||'another device',at:u.at};
    });
  });
  return out;
}
// another device's row, as it reads now: a window that has reset since reads as empty, not as the old number
function usageShareRow(r,from,now){
  const past=r.until&&r.until<=now;
  return {name:r.name,pct:past?(r.pct!=null||r.out?0:null):r.pct,text:(past?'has reset since it was read':r.text)+' · from '+from,out:past?false:!!r.out};
}
/* the rows to draw: this device's own; for an AI it has no reading of, another device's; then the AIs only
   another device uses. order = the AIs switched on here, in his order */
function usageShareMerge(local,others,order,now){
  const out=[], seen={};
  const theirs=function(id){ return others[id].rows.map(function(r){ return usageShareRow(r,others[id].from,now); }); };
  (order||[]).forEach(function(id){
    const mine=(local||[]).filter(function(r){ return r.id===id; });
    seen[id]=true;
    if(others&&others[id]&&!mine.some(function(r){ return r.share; }))theirs(id).forEach(function(r){ out.push(r); });
    else mine.forEach(function(r){ out.push(r); });
  });
  (local||[]).forEach(function(r){ if(!seen[r.id])out.push(r); });
  Object.keys(others||{}).sort().forEach(function(id){ if(!seen[id]&&id.indexOf('~')<0)theirs(id).forEach(function(r){ out.push(r); }); });
  return out;
}

if(typeof module!=='undefined'&&module.exports){
  module.exports={usageShareMine,usageShareSig,usageShareChanged,usageShareOthers,usageShareRow,usageShareMerge,USAGE_SHARE_EVERY,USAGE_SHARE_KEEP};
}
