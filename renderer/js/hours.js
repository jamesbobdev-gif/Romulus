/* The Hours tab: how many hours he put in each day, for school or for work. One week at a time, the way a
   timesheet app shows it: the week's total and a bar per day on top, the add line, then the week's entries.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── hours: one entry per log ──
   {id, date:'YYYY-MM-DD', kind:'school'|'work', hours:number, note, updatedAt}
   They live in state.hours and sync through their own row next to the personal list
   (syncKey+':hours'), the same way the Notes board does. Per entry the newer updatedAt wins;
   a tombstone beats older copies. */
const HOUR_KINDS=['school','work'];
/* what the tab is showing: the day the add line logs to (its week is the one on screen), the entry being
   changed, and a turn-in waiting for a yes */
const hourUI={kind:'school',day:null,editing:null,confirmTurnIn:null,turnInThrough:null};
function normHours(raw){
  const r=raw||{};
  const entries=(Array.isArray(r.entries)?r.entries:[]).filter(function(e){ return e&&e.id&&/^\d{4}-\d{2}-\d{2}$/.test(e.date)&&isFinite(e.hours); }).map(function(e){
    const o={id:String(e.id),date:e.date,kind:HOUR_KINDS.indexOf(e.kind)>=0?e.kind:'work',hours:+e.hours,note:String(e.note||''),updatedAt:e.updatedAt||0};
    if(e.turnedIn)o.turnedIn=e.turnedIn; // when he turned these hours in (a timestamp); unset = still to turn in
    return o;
  });
  const tombs=(Array.isArray(r.tombstones)?r.tombstones:[]).filter(function(t){ return t&&t.id; });
  return {entries:entries,tombstones:tombs};
}
function hoursProfile(){
  const p=syncState.cfg&&syncState.cfg.personal;
  return validProfile(p)?{url:p.url,key:p.key,syncKey:p.syncKey+':hours'}:null;
}
function hoursDoc(){ return {v:1,entries:state.hours.entries,tombstones:state.hours.tombstones}; }
function canonHours(d){ return stableJson(d.entries.slice().sort(function(a,b){ return a.id<b.id?-1:1; })); }
function mergeHours(remoteDoc){
  const remote=normHours(remoteDoc), local=state.hours;
  const tombs={};
  local.tombstones.concat(remote.tombstones).forEach(function(x){ if(!tombs[x.id]||x.deletedAt>tombs[x.id])tombs[x.id]=x.deletedAt; });
  const byId={};
  local.entries.concat(remote.entries).forEach(function(it){ const prev=byId[it.id]; if(!prev||(it.updatedAt||0)>(prev.updatedAt||0))byId[it.id]=it; });
  const entries=Object.keys(byId).map(function(id){ return byId[id]; })
    .filter(function(it){ return !(tombs[it.id]&&tombs[it.id]>=(it.updatedAt||0)); });
  const cutoff=Date.now()-60*86400000; // drop tombstones older than 60 days
  const mergedTombs=Object.keys(tombs).filter(function(id){ return tombs[id]>cutoff; })
    .map(function(id){ return {id:id,deletedAt:tombs[id]}; });
  const merged={entries:entries,tombstones:mergedTombs};
  const changedLocal=canonHours(merged)!==canonHours(local);
  const changedRemote=canonHours(merged)!==canonHours(remote)||mergedTombs.length!==remote.tombstones.length;
  state.hours=merged;
  return {changedLocal:changedLocal,changedRemote:changedRemote};
}

/* "2.5", "2:30", "2h 30m", "90m", "1h" → hours as a number; null when it isn't a time */
function parseHours(s){
  s=String(s||'').trim().toLowerCase();
  let m=/^(\d{1,2}):(\d{2})$/.exec(s);
  if(m)return +m[1]+(+m[2])/60;
  m=/^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?|s)?)?)?$/.exec(s);
  if(m&&(m[1]||m[2]))return (+(m[1]||0))+(+(m[2]||0))/60;
  m=/^\d*\.?\d+$/.exec(s);
  return m?+s:null;
}
function fmtHours(h){
  const mins=Math.round(h*60), hh=Math.floor(mins/60), mm=mins%60;
  return hh&&mm?hh+'h '+mm+'m':hh?hh+'h':mm+'m';
}
function hDateKey(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function hParse(key){ const p=key.split('-').map(Number); return new Date(p[0],p[1]-1,p[2]); }
function hAddDays(key,n){ const d=hParse(key); d.setDate(d.getDate()+n); return hDateKey(d); }
function hWeekStart(key){ const d=hParse(key); d.setDate(d.getDate()-((d.getDay()+6)%7)); return hDateKey(d); } // weeks start Monday
function hShort(key){ return hParse(key).toLocaleDateString('en-US',{month:'short',day:'numeric'}); }
function hDayLabel(key){
  const diff=Math.round((hParse(key)-todayStart())/864e5);
  if(diff===0)return 'Today';
  if(diff===-1)return 'Yesterday';
  return hParse(key).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
}
/* the week that starts on Monday `mon`, seen from today: "This week", "Last week", "Oct 19 – 25", "Dec 22 – 28, 2025" */
function hWeekLabel(mon,todayKey){
  const thisMon=hWeekStart(todayKey);
  if(mon===thisMon)return 'This week';
  if(mon===hAddDays(thisMon,-7))return 'Last week';
  if(mon===hAddDays(thisMon,7))return 'Next week';
  const sun=hAddDays(mon,6), a=hParse(mon), b=hParse(sun);
  const year=b.getFullYear()!==hParse(todayKey).getFullYear()?', '+b.getFullYear():'';
  if(a.getMonth()===b.getMonth())return a.toLocaleDateString('en-US',{month:'short'})+' '+a.getDate()+' – '+b.getDate()+year;
  return hShort(mon)+' – '+hShort(sun)+year;
}
// totals per kind for entries whose date is in [from, to]
function hoursSum(from,to){
  const t={school:0,work:0};
  state.hours.entries.forEach(function(e){ if(e.date>=from&&e.date<=to)t[e.kind]+=e.hours; });
  return t;
}

function hoursAdd(date,kind,hours,note){
  state.hours.entries.push({id:uid(),date:date,kind:kind,hours:hours,note:note,updatedAt:Date.now()});
  persist();
}
function hoursUpdate(id,patch){
  const e=state.hours.entries.find(function(x){ return x.id===id; }); if(!e)return;
  Object.assign(e,patch,{updatedAt:Date.now()}); persist();
}
function hoursRemove(id){
  state.hours.entries=state.hours.entries.filter(function(e){ return e.id!==id; });
  state.hours.tombstones.push({id:id,deletedAt:Date.now()}); persist();
}

/* Turning hours in: every School (or Work) entry not turned in yet gets stamped with the same time,
   so "since you last turned in" is just the entries still unstamped, even ones logged late for an
   earlier day. Undo clears the newest stamp. */
function hoursPending(kind){ return state.hours.entries.filter(function(e){ return e.kind===kind&&!e.turnedIn; }); }
function hoursLastTurnIn(kind){
  return state.hours.entries.reduce(function(a,e){ return e.kind===kind&&e.turnedIn>a?e.turnedIn:a; },0);
}
// through = 'YYYY-MM-DD': only days up to and including it (an older sheet he already sent)
function hoursTurnIn(kind,through){
  const now=Date.now();
  hoursPending(kind).forEach(function(e){ if(!through||e.date<=through){ e.turnedIn=now; e.updatedAt=now; } });
  persist();
}
function hoursUndoTurnIn(kind){
  const last=hoursLastTurnIn(kind), now=Date.now(); if(!last)return;
  state.hours.entries.forEach(function(e){ if(e.kind===kind&&e.turnedIn===last){ delete e.turnedIn; e.updatedAt=now; } });
  persist();
}

/* ── the tab ── */
// opening the tab (calendar-view.js switchTab): back to today, nothing half-done
function hoursEnter(){ hourUI.day=hDateKey(todayStart()); hourUI.editing=null; hourUI.confirmTurnIn=null; hourUI.turnInThrough=null; }
function renderHours(){
  const view=$('hoursView'); if(!view)return;
  if(!view.firstChild)hoursBuild(view); // built once: the add line keeps what he was typing across re-renders (a sync can land mid-entry)
  const tk=hDateKey(todayStart());
  if(!hourUI.day)hourUI.day=tk;
  hoursWeekDraw(tk);
  hoursSyncKind();
  hoursDueDraw();
  hoursSheetDraw();
  hoursListDraw(tk);
}
function hoursBuild(view){
  view.innerHTML=
    '<div class="hours-week">'+
      '<div class="hours-week-head">'+
        '<div>'+
          '<div id="hoursWeekK" class="hours-week-k"></div>'+
          '<div id="hoursWeekV" class="hours-week-v"></div>'+
          '<div id="hoursWeekSplit" class="hours-week-split"></div>'+
        '</div>'+
        '<div class="hours-week-nav">'+
          '<button id="hoursToday" class="ghost mono" hidden>today</button>'+
          '<button id="hoursPrev" class="cal-nav" aria-label="Previous week">&#8249;</button>'+
          '<button id="hoursNext" class="cal-nav" aria-label="Next week">&#8250;</button>'+
        '</div>'+
      '</div>'+
      '<div id="hoursBars" class="hours-bars"></div>'+
      '<div class="hours-add">'+
        '<div class="hours-kinds" role="radiogroup" aria-label="School or work">'+
          '<button type="button" class="hours-kind-btn" data-kind="school" role="radio">School</button>'+
          '<button type="button" class="hours-kind-btn" data-kind="work" role="radio">Work</button>'+
        '</div>'+
        '<input id="hoursAmt" class="sm hours-amt-inp" placeholder="2.5 or 2:30" aria-label="Hours" inputmode="decimal">'+
        '<input id="hoursNote" class="sm hours-note-inp" placeholder="Note (optional)" aria-label="Note">'+
        '<button id="hoursAddBtn" class="btn-accent">Add</button>'+
      '</div>'+
    '</div>'+
    '<div id="hoursDue" class="hours-due" hidden></div>'+
    '<div id="hoursSheet" class="hours-sheet" hidden></div>'+
    '<div id="hoursList" class="hours-list"></div>'+
    '<div id="hoursEmpty" class="hours-empty" hidden></div>';
  $('hoursPrev').addEventListener('click',function(){ hourUI.day=hAddDays(hourUI.day,-7); renderHours(); });
  $('hoursNext').addEventListener('click',function(){ hourUI.day=hAddDays(hourUI.day,7); renderHours(); });
  $('hoursToday').addEventListener('click',function(){ hourUI.day=hDateKey(todayStart()); renderHours(); });
  view.querySelectorAll('.hours-kind-btn').forEach(function(b){
    b.addEventListener('click',function(){ hourUI.kind=b.dataset.kind; hoursSyncKind(); $('hoursAmt').focus(); });
  });
  function add(){
    const amt=$('hoursAmt'), h=parseHours(amt.value);
    if(h===null||h<=0||h>24){ amt.classList.add('bad'); amt.focus(); return; }
    amt.classList.remove('bad');
    hoursAdd(hourUI.day,hourUI.kind,h,$('hoursNote').value.trim());
    amt.value=''; $('hoursNote').value='';
    renderHours(); amt.focus();
  }
  $('hoursAddBtn').addEventListener('click',add);
  [$('hoursAmt'),$('hoursNote')].forEach(function(i){ i.addEventListener('keydown',function(ev){ if(ev.key==='Enter')add(); }); });
  $('hoursAmt').addEventListener('input',function(){ this.classList.remove('bad'); });
}
function hoursSyncKind(){
  document.querySelectorAll('#hoursView .hours-kind-btn').forEach(function(b){
    const on=b.dataset.kind===hourUI.kind; b.classList.toggle('on',on); b.setAttribute('aria-checked',String(on));
  });
}
/* the card: the week's total with its school/work split, a bar per day (tap one and the add line logs to it) */
function hoursWeekDraw(tk){
  const mon=hWeekStart(hourUI.day), days=[];
  for(let i=0;i<7;i++)days.push(hAddDays(mon,i));
  const week=hoursSum(days[0],days[6]);
  $('hoursWeekK').textContent=hWeekLabel(mon,tk);
  $('hoursWeekV').textContent=fmtHours(week.school+week.work);
  const split=$('hoursWeekSplit'); split.innerHTML='';
  HOUR_KINDS.forEach(function(k){
    const s=el('span','hours-legend'); s.appendChild(el('i','hours-dot '+k));
    s.appendChild(document.createTextNode((k==='school'?'School ':'Work ')+fmtHours(week[k])));
    split.appendChild(s);
  });
  $('hoursToday').hidden=mon===hWeekStart(tk);
  const per=days.map(function(d){ return hoursSum(d,d); });
  const max=per.reduce(function(m,p){ return Math.max(m,p.school+p.work); },0);
  const bars=$('hoursBars'); bars.innerHTML='';
  days.forEach(function(d,i){
    const total=per[i].school+per[i].work;
    const b=el('button','hours-day-btn'+(d===hourUI.day?' on':'')+(d===tk?' today':''));
    b.type='button';
    b.setAttribute('aria-pressed',String(d===hourUI.day));
    b.title=hDayLabel(d)+' · '+(total?fmtHours(total):'nothing logged');
    b.setAttribute('aria-label',b.title);
    const bar=el('span','hours-bar');
    if(total){
      const stack=el('span','hours-stack'); stack.style.height=(total/max*100)+'%';
      HOUR_KINDS.forEach(function(k){ if(per[i][k]){ const seg=el('i','hours-seg '+k); seg.style.flexGrow=per[i][k]; stack.appendChild(seg); } });
      bar.appendChild(stack);
    }
    b.appendChild(bar);
    b.appendChild(el('span','hours-day-k',hParse(d).toLocaleDateString('en-US',{weekday:'short'})));
    b.addEventListener('click',function(){ hourUI.day=d; renderHours(); if(!touchDevice())$('hoursAmt').focus(); });
    bars.appendChild(b);
  });
  $('hoursAddBtn').textContent=hourUI.day===tk?'Add':'Add to '+hParse(hourUI.day).toLocaleDateString('en-US',{weekday:'short'});
}
/* under the card: each kind's hours not turned in yet, with Turn in; a turn-in from the last day can still be undone */
function hoursDueDraw(){
  const box=$('hoursDue'); if(!box)return;
  box.innerHTML='';
  HOUR_KINDS.forEach(function(kind){
    const pend=hoursPending(kind), last=hoursLastTurnIn(kind), recent=last&&Date.now()-last<86400000;
    if(!pend.length&&!recent)return;
    const row=el('div','hours-due-row');
    row.appendChild(el('span','hours-kind '+kind,kind==='school'?'School':'Work'));
    const t=el('span','hours-due-t');
    if(hourUI.confirmTurnIn===kind){
      // which days the sheet covers: through today unless he picks an earlier day
      const thru=el('input','sm'); thru.type='date'; thru.value=hourUI.turnInThrough||hDateKey(todayStart()); thru.setAttribute('aria-label','Turned in through');
      const upTo=function(){ return pend.filter(function(e){ return e.date<=thru.value; }).reduce(function(a,e){ return a+e.hours; },0); };
      const yes=el('button','btn-accent','Turn in '+fmtHours(upTo())); yes.disabled=!upTo();
      thru.addEventListener('change',function(){ hourUI.turnInThrough=thru.value; yes.textContent='Turn in '+fmtHours(upTo()); yes.disabled=!upTo(); });
      yes.addEventListener('click',function(){ hourUI.confirmTurnIn=null; hourUI.turnInThrough=null; hoursTurnIn(kind,thru.value); renderHours(); });
      const no=el('button','ghost','Cancel');
      no.addEventListener('click',function(){ hourUI.confirmTurnIn=null; hourUI.turnInThrough=null; renderHours(); });
      t.className+=' hours-due-thru'; t.textContent='turned in through';
      row.appendChild(t); row.appendChild(thru); row.appendChild(yes); row.appendChild(no);
    } else {
      if(pend.length){
        const sum=pend.reduce(function(a,e){ return a+e.hours; },0), oldest=pend.map(function(e){ return e.date; }).sort()[0];
        t.appendChild(el('b','',fmtHours(sum)));
        t.appendChild(document.createTextNode(' not turned in yet · since '+hShort(oldest)));
      } else {
        const sum=state.hours.entries.filter(function(e){ return e.kind===kind&&e.turnedIn===last; }).reduce(function(a,e){ return a+e.hours; },0);
        t.appendChild(el('b','',fmtHours(sum)));
        t.appendChild(document.createTextNode(' turned in '+(hDateKey(new Date(last))===hDateKey(todayStart())?'today':'yesterday')));
      }
      row.appendChild(t);
      if(recent){
        const undo=el('button','ghost hours-act',pend.length?'Undo last':'Undo');
        undo.title='Count the hours from the last turn-in as not turned in again';
        undo.addEventListener('click',function(){ hoursUndoTurnIn(kind); renderHours(); });
        row.appendChild(undo);
      }
      if(pend.length){
        const go=el('button','ghost hours-act','Turn in');
        go.addEventListener('click',function(){ hourUI.confirmTurnIn=kind; renderHours(); });
        row.appendChild(go);
      }
    }
    box.appendChild(row);
  });
  box.hidden=!box.firstChild;
}
/* Time sheet due dates: the "Turn in time sheet" tasks on the Work list (each one is a due date). The next
   one shows here with the work hours logged since the one before it, i.e. what goes on that sheet. */
const SHEET_RE=/time\s*-?sheet/i;
function hoursSheetDraw(){
  const box=$('hoursSheet'); if(!box)return;
  const tk=hDateKey(todayStart());
  const sheets=state.tasks.filter(function(t){ return taskWs(t)==='work'&&t.due&&SHEET_RE.test(t.title); });
  const ahead=sheets.filter(function(t){ return !t.done&&t.due>=tk; }).map(function(t){ return t.due; }).sort();
  box.hidden=!ahead.length; box.textContent='';
  if(!ahead.length)return;
  const next=ahead[0];
  // the period starts the day after the time sheet before it (or two weeks back when there's none yet)
  const before=sheets.map(function(t){ return t.due; }).filter(function(d){ return d<next; }).sort().pop();
  const fk=hAddDays(before||next,before?1:-14), worked=hoursSum(fk,tk).work;
  const days=Math.round((hParse(next)-todayStart())/864e5);
  box.appendChild(el('b','','Time sheet'));
  box.appendChild(document.createTextNode(' due '+hDayLabel(next)+(days>1?' (in '+days+' days)':days===1?' (tomorrow)':'')+' · '+fmtHours(worked)+' of work since '+hShort(fk)));
}
/* the week's entries by day, newest first; tap one to change or delete it */
function hoursListDraw(tk){
  const list=$('hoursList'); list.innerHTML='';
  const mon=hWeekStart(hourUI.day), sun=hAddDays(mon,6);
  const byDay={};
  state.hours.entries.forEach(function(e){ if(e.date>=mon&&e.date<=sun)(byDay[e.date]=byDay[e.date]||[]).push(e); });
  const days=Object.keys(byDay).sort().reverse();
  const empty=$('hoursEmpty'), label=hWeekLabel(mon,tk);
  empty.hidden=days.length>0;
  empty.textContent=state.hours.entries.length?'Nothing logged '+(/week$/.test(label)?label.toLowerCase():label)+'.':'Nothing logged yet. Put in how long you worked today, above.';
  days.forEach(function(d){
    const sec=el('section','hours-day');
    const sum=byDay[d].reduce(function(a,e){ return a+e.hours; },0);
    const head=el('div','hours-day-head');
    head.appendChild(el('span','hours-day-name',hDayLabel(d)));
    head.appendChild(el('span','hours-day-sum mono',fmtHours(sum)));
    sec.appendChild(head);
    byDay[d].sort(function(a,b){ return a.kind<b.kind?-1:a.kind>b.kind?1:(a.updatedAt-b.updatedAt); }).forEach(function(e){
      sec.appendChild(hourUI.editing===e.id?hoursEditRow(e):hoursRow(e));
    });
    list.appendChild(sec);
  });
}
function hoursRow(e){
  const row=el('button','hours-row'+(e.turnedIn?' turned-in':''));
  row.type='button';
  row.appendChild(el('span','hours-kind '+e.kind,e.kind==='school'?'School':'Work'));
  row.appendChild(el('span','hours-amt mono',fmtHours(e.hours)));
  row.appendChild(el('span','hours-note',e.note));
  if(e.turnedIn){ const c=el('span','hours-done'); c.innerHTML=I.check; c.title='Turned in '+hShort(hDateKey(new Date(e.turnedIn))); row.appendChild(c); }
  row.addEventListener('click',function(){ hourUI.editing=e.id; renderHours(); });
  return row;
}
function hoursEditRow(e){
  const row=el('div','hours-edit');
  const kind=el('select','sm'); HOUR_KINDS.forEach(function(k){ const o=el('option','',k==='school'?'School':'Work'); o.value=k; kind.appendChild(o); }); kind.value=e.kind; kind.setAttribute('aria-label','School or work');
  const date=el('input','sm'); date.type='date'; date.value=e.date; date.setAttribute('aria-label','Day');
  const amt=el('input','sm hours-amt-inp'); amt.value=fmtHours(e.hours); amt.setAttribute('aria-label','Hours');
  const note=el('input','sm hours-note-inp'); note.value=e.note; note.placeholder='Note'; note.setAttribute('aria-label','Note');
  const save=el('button','btn-accent','Save');
  const del=el('button','ghost danger','Delete');
  const cancel=el('button','ghost','Cancel');
  function close(){ hourUI.editing=null; renderHours(); }
  function done(){
    const h=parseHours(amt.value);
    if(h===null||h<=0||h>24){ amt.classList.add('bad'); amt.focus(); return; }
    hourUI.editing=null;
    hoursUpdate(e.id,{kind:kind.value,date:date.value||e.date,hours:h,note:note.value.trim()});
    renderHours();
  }
  save.addEventListener('click',done);
  del.addEventListener('click',function(){ hourUI.editing=null; hoursRemove(e.id); renderHours(); });
  cancel.addEventListener('click',close);
  [kind,date,amt,note].forEach(function(i){ i.addEventListener('keydown',function(ev){ if(ev.key==='Enter')done(); else if(ev.key==='Escape')close(); }); });
  [kind,date,amt,note,save,cancel,del].forEach(function(n){ row.appendChild(n); });
  setTimeout(function(){ amt.focus(); amt.select(); },0);
  return row;
}

if(typeof module!=='undefined'&&module.exports){ module.exports={parseHours:parseHours,fmtHours:fmtHours,hAddDays:hAddDays,hWeekStart:hWeekStart,hWeekLabel:hWeekLabel,normHours:normHours}; }
