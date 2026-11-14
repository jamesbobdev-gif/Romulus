/* What the add box reads out of a typed task besides its date (parseSpokenTask in task-actions.js does dates):
     "Call mom every sunday"      → repeats weekly, first due the coming Sunday (today if it's Sunday)
     "Take vitamins daily"        → repeats every day, first due today
     "Water plants #home"         → tag "home", taken out of the title
   One of the page scripts in renderer/js (they share one global scope); also loaded by test/quick-add.test.js,
   so it uses no page globals. */
'use strict';

const QA_DOW=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
function qaYmd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function qaTidy(s){ return String(s).slice(0,2000).replace(/\s+/g,' ').replace(/ ([,.;:!?])/g,'$1').replace(/^[ ,.;:-]+|[ ,;:-]+$/g,'').trim(); } // a title's worth, spaces collapsed first: the patterns then can't backtrack over a long run

// → {title, every, due} or null. every is a recur.js rule (day, weekday, week, 2week, month, year);
// due is the first date: the named weekday (onDay: true), or today (the next weekday for "weekdays").
function recurFromWords(text,now){
  const s=' '+String(text||'')+' ';
  const base=new Date(now||Date.now()); base.setHours(0,0,0,0);
  const rules=[
    [/\b(?:every|each)\s+(sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?\b/i,'dow'],
    [/\b(?:every|each)\s+(?:week\s*day|work\s*day)\b|\b(?:on\s+)?week\s*days\b/i,'weekday'],
    [/\b(?:every|each)\s+day\b|\b(?:every|each)\s+morning\b|\b(?:every|each)\s+night\b|\bdaily\s*$/i,'day'],
    [/\bevery\s+(?:other|2|two)\s+weeks?\b|\bbi-?weekly\s*$/i,'2week'],
    [/\b(?:every|each)\s+week\b|\bweekly\s*$/i,'week'],
    [/\b(?:every|each)\s+month\b|\bmonthly\s*$/i,'month'],
    [/\b(?:every|each)\s+year\b|\b(?:yearly|annually)\s*$/i,'year']
  ];
  for(const r of rules){
    const m=r[0].exec(s); if(!m)continue;
    const title=qaTidy(s.slice(0,m.index)+' '+s.slice(m.index+m[0].length));
    if(!title)return null; // "Every day" alone is a title, not a rule
    let due=new Date(base), every=r[1], onDay=false;
    if(every==='dow'){
      const want=QA_DOW.findIndex(function(d){ return d.indexOf(m[1].toLowerCase().slice(0,3))===0; });
      due.setDate(due.getDate()+((want-base.getDay()+7)%7));
      every='week'; onDay=true;
    } else if(every==='weekday'){ while(due.getDay()===0||due.getDay()===6)due.setDate(due.getDate()+1); }
    return {title:title,every:every,due:qaYmd(due),onDay:onDay};
  }
  return null;
}

// "Water plants #home" → {title:'Water plants', tag:'home'}; the first #word only, and never a title that's only tags.
// A health goal ("Walk #steps 8000", health.js) stays in the title: it's what ticks the task off.
const QA_HEALTH=/^(steps|exercise|workout|sleep)$/i;
function tagFromWords(text){
  const s=String(text||'');
  const re=/(^|\s)#([A-Za-z0-9][\w-]{0,30})(?=\s|$|[,.;:!?])/g;
  let m;
  while((m=re.exec(s))&&QA_HEALTH.test(m[2])&&/^\s+\d/.test(s.slice(m.index+m[0].length))){}
  if(!m)return {title:s,tag:null};
  const title=qaTidy(s.slice(0,m.index)+' '+s.slice(m.index+m[0].length));
  return title?{title:title,tag:m[2]}:{title:s,tag:null};
}

if(typeof module!=='undefined'&&module.exports)module.exports={recurFromWords:recurFromWords,tagFromWords:tagFromWords};
