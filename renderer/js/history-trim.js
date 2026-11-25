/* Old Agent conversations stay off the sync server.
   An Agent task carries its whole conversation (history), and the Agent list is uploaded whole on every
   change, so finished tasks' conversations were most of what each sync sent. Once a finished task has sat
   untouched for HIST_KEEP_DAYS, it gets histFrom (a time): what was said before then stays on the devices
   that already have it (this one's tasks file keeps it all, so the conversation, the log and the year in
   review read as before) and no longer goes up. Anything said from then on syncs as usual, so replying to
   an old task still works everywhere. A device added later shows such a task without its old conversation.
   Used by sync.js (wsDoc, mergeRemoteWs, syncOnce).
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

const HIST_KEEP_DAYS=7;
function histAt(e){ return (e&&e.at)||0; }
// the part of a task's conversation its online copy carries
function histSynced(t){
  const h=Array.isArray(t.history)?t.history:[];
  return t.histFrom?h.filter(function(e){ return histAt(e)>=t.histFrom; }):h;
}
// the task as it goes up: without what was said before histFrom (the task itself is left alone)
function histUpForm(t){
  if(!t.histFrom||!Array.isArray(t.history))return t;
  const kept=histSynced(t);
  return kept.length===t.history.length?t:Object.assign({},t,{history:kept});
}
// a newer copy from online replaces this device's: the old conversation this device holds stays in front of it
function histCarry(winner,mine){
  if(!winner.histFrom||!mine||!Array.isArray(mine.history))return winner;
  const old=mine.history.filter(function(e){ return histAt(e)<winner.histFrom; });
  if(!old.length)return winner;
  return Object.assign({},winner,{history:old.concat(histSynced(winner))});
}
/* Marks the finished Agent tasks nobody has touched for HIST_KEEP_DAYS → how many. One that repeats or waits
   on a trigger runs again by itself and wants its conversation wherever it runs, so those are left whole. */
function histArchive(tasks,now){
  const cut=now-HIST_KEEP_DAYS*86400000; let n=0;
  tasks.forEach(function(t){
    if(t.ws!=='agent'||!(t.done||t.status==='done')||t.repeat||t.trigger)return;
    if((t.updatedAt||0)>cut||!histSynced(t).length)return;
    t.histFrom=now; t.updatedAt=now; n++; // newer than every other copy, so each device takes it
  });
  return n;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { HIST_KEEP_DAYS, histSynced, histUpForm, histCarry, histArchive };
