/* Overdue assignments: a School task still open two days after its deadline comes off the list. By then the
   quiz has closed or the drop box has shut, so there's nothing left to do, and it would only sit there red.
   The deadline is the one the course calendar gave it (what the feed last said, which importCourseFeeds in
   wiring.js remembers), so snoozing an assignment to today doesn't keep it around; one added by hand counts
   from its own date. Done ones stay: they're the record. A repeating school to-do is a series, not one
   assignment, and stays too. The feed itself forgets an item at the same point (agent/calendar-feeds.js).
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them.
   Also loaded by test/school-overdue.test.js, so the date maths here uses no page globals. */
'use strict';

// what the course calendar last said per feed item ('YYYY-MM-DD HH:MM', or 'YYYY-MM-DD ' with no time), by task id
const FEED_SEEN_KEY='tasks.feedSeen';
const SCHOOL_GRACE_MS=2*864e5; // two days past the deadline, then it's past saving

// the moment an assignment is due: its time, or the end of its day. said: the feed's word, which wins over the task's own date
function schoolDeadline(t,said){
  let due=t&&t.due, time=(t&&t.dueTime)||null;
  const m=String(said||'').match(/^(\d{4}-\d{2}-\d{2}) ?(\d{2}:\d{2})?$/);
  if(m){ due=m[1]; time=m[2]||null; }
  if(!due)return null;
  const p=due.split('-').map(Number), h=time?time.split(':').map(Number):[23,59];
  return new Date(p[0],p[1]-1,p[2],h[0],h[1]);
}
// more than two days gone by since a deadline
function pastSaving(at,now){ return !!at&&at.getTime()<now.getTime()-SCHOOL_GRACE_MS; }
// does this task come off? a school task, open, dated, not repeating, and two days past its deadline
function schoolExpired(t,now,said){
  if(!t||t.done||t.ws!=='school'||t.recur)return false;
  return pastSaving(schoolDeadline(t,said),now);
}
// the ids to take off, given every task and what the feed last said per id
function schoolExpiredIds(tasks,now,seen){
  return (tasks||[]).filter(function(t){ return schoolExpired(t,now,seen?seen[t.id]:null); }).map(function(t){ return t.id; });
}

if(typeof module!=='undefined'&&module.exports){ module.exports={schoolDeadline:schoolDeadline,pastSaving:pastSaving,schoolExpired:schoolExpired,schoolExpiredIds:schoolExpiredIds}; }
else {
  // what the feed last said per item (wiring.js importCourseFeeds keeps it; empty on the phone, which imports nothing)
  window.feedSeenRead=function(){ try{ return JSON.parse(localStorage.getItem(FEED_SEEN_KEY)||'{}')||{}; }catch(e){ return {}; } };
  // take the assignments past saving off the list, tombstoned so sync and the next import don't bring them back → how many
  window.sweepSchool=function(){
    const ids=schoolExpiredIds(state.tasks,new Date(),feedSeenRead());
    if(!ids.length)return 0;
    const now=Date.now();
    state.tasks.filter(function(t){ return ids.indexOf(t.id)>=0; }).forEach(function(t){
      if(t.googleEventId&&window.desktop&&window.desktop.gcalDeleteEvent)window.desktop.gcalDeleteEvent(t.googleEventId,t.calRef); // a test or project on the calendar
      state.expanded.delete(t.id);
      state.tombstones.push({id:t.id,deletedAt:now});
    });
    state.tasks=state.tasks.filter(function(t){ return ids.indexOf(t.id)<0; });
    return ids.length;
  };
  // the app stays open for days: look again every hour, so a deadline that passed while it was open is caught
  setInterval(function(){ if(sweepSchool())touch(); },60*60*1000);
}
