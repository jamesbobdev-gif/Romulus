/* ── a schedule from a sentence ──
   "Do this every weekday at 9", "check it every morning", "each Monday at 8am" on an Agent task (typed as the
   task, or in a reply) proposes a repeat: a line in the conversation with Repeat / Just this once, the way
   standing.js offers a permission when he says "always". Nothing is set until he taps Repeat; then the task
   gets t.repeat (agent-chat.js: every day, weekdays or one weekday, at a time) and its next run. Only what the
   Agent's repeats can do: "every 2 weeks" or "monthly" gets no offer, and the run reads the words like any
   other task. The parser sits above the DOM code and is also loaded by test/repeat-offer.test.js.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

const REPEAT_OFFER_DAYS={sun:0,mon:1,tue:2,tues:2,wed:3,wednes:3,thu:4,thur:4,thurs:4,fri:5,sat:6,satur:6};
const REPEAT_OFFER_TIMES={morning:'08:00',breakfast:'08:00',noon:'12:00',lunch:'12:00',afternoon:'14:00',evening:'18:00',dinner:'18:00',night:'21:00',bedtime:'21:00'};
// the clock time in the words → 'HH:MM' (24-hour), or null. "at 9" is the morning and "at 5" the afternoon; am/pm and "17:30" are as said
function repeatTimeFrom(s){
  const text=String(s||'');
  const m=text.match(/(?:\bat|@)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d:])/i)||text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i);
  if(!m)return null;
  let h=Number(m[1]); const min=Number(m[2]||0); const ap=(m[3]||'').replace(/\./g,'').toLowerCase();
  if(h>23||min>59||(ap&&(h>12||h===0)))return null;
  if(ap==='pm'&&h<12)h+=12;
  else if(ap==='am'&&h===12)h=0;
  else if(!ap&&h>=1&&h<=6)h+=12;
  return String(h).padStart(2,'0')+':'+String(min).padStart(2,'0');
}
// "every weekday at 9" → {every:'weekday', day:null, at:'09:00'}; "each Monday at 8am" → {every:'week', day:1, at:'08:00'};
// "every morning" → {every:'day', day:null, at:'08:00'}. Nothing the Agent's repeats can do (every 2 weeks, monthly) → null
function repeatFromWords(text){
  const s=String(text||'').toLowerCase().replace(/\s+/g,' ');
  if(!/\b(every|each|daily|weekly|weekdays|weeknights|mornings|evenings|nights|once a (day|week)|on (sun|mon|tues?|wed(nes)?|thu(rs?)?|fri|sat(ur)?)days?)\b/.test(s))return null;
  if(/\b(every|each)\s+(other|2|two|3|three|few|\d+)\b|\b(every|each)\s+(month|year|weekend|hour|minute|time)\b|\b(bi-?weekly|fortnight\w*|monthly|yearly|annually|hourly)\b/.test(s))return null;
  const at=repeatTimeFrom(s);
  const word=(s.match(/\b(morning|breakfast|noon|lunch|afternoon|evening|dinner|night|bedtime)s?\b/)||[])[1];
  const when=at||REPEAT_OFFER_TIMES[word]||'08:00';
  const dow=s.match(/\b(?:every|each|on)\s+(sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?s?\b/);
  if(dow)return {every:'week',day:REPEAT_OFFER_DAYS[dow[1]],at:when};
  if(/\b(?:every|each)\s+(?:week\s*day|work\s*day)\b|\b(?:on\s+)?week\s*days\b|\bweeknights\b/.test(s))return {every:'weekday',day:null,at:when};
  if(/\b(?:every|each)\s+(?:day|morning|evening|night|afternoon|breakfast|lunch|dinner|bedtime)\b|\bdaily\b|\b(?:mornings|evenings|nights)\b|\bonce a day\b/.test(s))return {every:'day',day:null,at:when};
  if(/\b(?:every|each)\s+week\b|\bweekly\b|\bonce a week\b/.test(s))return {every:'week',day:null,at:when};
  return null;
}
// the same schedule? (what the task has, or an offer still waiting on him)
function repeatSame(a,b){
  if(!a||!b||a.every!==b.every||(a.at||'08:00')!==(b.at||'08:00'))return false;
  return a.every!=='week'||(a.day==null?null:a.day)===(b.day==null?null:b.day);
}
if(typeof module!=='undefined'&&module.exports)module.exports={repeatFromWords,repeatTimeFrom,repeatSame};

// his words on an Agent task (the title as typed, or a reply): propose the schedule they name, once
function repeatOfferFor(t,text){
  if(!t||taskWs(t)!=='agent')return false;
  const offer=repeatFromWords(text); if(!offer)return false;
  if(offer.every==='week'&&offer.day==null)offer.day=new Date().getDay();
  if(repeatSame(t.repeat,offer))return false;
  if((t.history||[]).some(function(h){ return h.repeatOffer&&!h.repeatKept&&!h.repeatDropped&&repeatSame(h.repeatOffer,offer); }))return false;
  agentSay(t,'sys','Make this a repeating task?',{repeatOffer:offer});
  return true;
}
// in the conversation: the schedule his words named (lists.js shows it under the sys line)
function repeatBox(t,h){
  const o=h.repeatOffer, box=el('div','conv-opts');
  box.appendChild(el('div',null,'• '+repeatText(o)));
  if(h.repeatKept)box.appendChild(el('div',null,'Repeats '+repeatText(t.repeat||o).toLowerCase()+(t.nextRun&&typeof fmtWhen==='function'?'; next '+fmtWhen(t.nextRun):'')+'. Change or stop it under Repeat in the task.'));
  else if(h.repeatDropped)box.appendChild(el('div',null,'Just this once.'));
  else{
    const row=el('div','conv-pref-btns');
    const keep=el('button','ghost mono','Repeat'), drop=el('button','ghost mono','Just this once');
    keep.addEventListener('click',function(e){ e.stopPropagation();
      t.repeat={every:o.every,at:o.at||'08:00',day:o.every==='week'?(o.day!=null?o.day:new Date().getDay()):null};
      t.nextRun=nextRepeatAt(t.repeat,Date.now()); h.repeatKept=true; buzz('tap'); touch(); });
    drop.addEventListener('click',function(e){ e.stopPropagation(); h.repeatDropped=true; touch(); });
    row.appendChild(keep); row.appendChild(drop); box.appendChild(row);
  }
  return box;
}
