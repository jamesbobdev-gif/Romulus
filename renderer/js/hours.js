/* The Hours tab: how many hours he put in each day, for school or for work.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── hours: one entry per log ──
   {id, date:'YYYY-MM-DD', kind:'school'|'work', hours:number, note, updatedAt}
   They live in state.hours and sync through their own row next to the personal list
   (syncKey+':hours'), the same way the Ideas board does. Per entry the newer updatedAt wins;
   a tombstone beats older copies. */
const HOUR_KINDS=['school','work'];
const hourUI={kind:'school',editing:null,confirmTurnIn:null};
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
function canonHours(d){ return JSON.stringify(d.entries.slice().sort(function(a,b){ return a.id<b.id?-1:1; })); }
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
function hDayLabel(key){
  const diff=Math.round((hParse(key)-todayStart())/864e5);
  if(diff===0)return 'Today';
  if(diff===-1)return 'Yesterday';
  return hParse(key).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
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
function hoursDueDraw(){
  const box=$('hoursDue'); if(!box)return;
  box.innerHTML='';
  box.appendChild(el('div','hours-total-k','Since you last turned in'));
  HOUR_KINDS.forEach(function(kind){
    const pend=hoursPending(kind), sum=pend.reduce(function(a,e){ return a+e.hours; },0), last=hoursLastTurnIn(kind);
    const row=el('div','hours-due-row');
    row.appendChild(el('span','hours-kind '+kind,kind==='school'?'School':'Work'));
    row.appendChild(el('span','hours-due-v',fmtHours(sum)));
    const oldest=pend.map(function(e){ return e.date; }).sort()[0];
    row.appendChild(el('span','hours-due-sub',
      (last?'last turned in '+new Date(last).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'never turned in')+
      (oldest?' · from '+hParse(oldest).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'')));
    if(hourUI.confirmTurnIn===kind){
      // which days the sheet covers: through today unless he picks an earlier day
      const thru=el('input','sm'); thru.type='date'; thru.value=hourUI.turnInThrough||hDateKey(todayStart()); thru.setAttribute('aria-label','Turned in through');
      const upTo=function(){ return pend.filter(function(e){ return e.date<=thru.value; }).reduce(function(a,e){ return a+e.hours; },0); };
      const yes=el('button','btn-accent','Turn in '+fmtHours(upTo()));
      thru.addEventListener('change',function(){ hourUI.turnInThrough=thru.value; yes.textContent='Turn in '+fmtHours(upTo()); yes.disabled=!upTo(); });
      yes.disabled=!upTo();
      yes.addEventListener('click',function(){ hourUI.confirmTurnIn=null; hourUI.turnInThrough=null; hoursTurnIn(kind,thru.value); renderHours(); });
      const no=el('button','ghost','Cancel');
      no.addEventListener('click',function(){ hourUI.confirmTurnIn=null; hourUI.turnInThrough=null; renderHours(); });
      row.appendChild(el('span','hours-due-sub hours-thru-k','through'));
      row.appendChild(thru); row.appendChild(yes); row.appendChild(no);
    } else {
      if(last){
        const undo=el('button','ghost','Undo last');
        undo.title='Count the hours from the last turn-in as not turned in again';
        undo.addEventListener('click',function(){ hoursUndoTurnIn(kind); renderHours(); });
        row.appendChild(undo);
      }
      const go=el('button','btn-accent','Turn in');
      go.disabled=!pend.length;
      go.addEventListener('click',function(){ hourUI.confirmTurnIn=kind; renderHours(); });
      row.appendChild(go);
    }
    box.appendChild(row);
  });
}

function renderHours(){
  const view=$('hoursView'); if(!view)return;
  // the form keeps what he was typing across re-renders (a sync can land mid-entry)
  if(!view.firstChild)hoursBuildForm(view);
  hoursSyncKind();
  hoursSheetDraw();
  hoursDueDraw();
  const today=todayStart(), tk=hDateKey(today);
  const wk=new Date(today); wk.setDate(wk.getDate()-((wk.getDay()+6)%7)); // weeks start Monday
  const mo=new Date(today.getFullYear(),today.getMonth(),1);
  const sums=[['Today',hoursSum(tk,tk)],['This week',hoursSum(hDateKey(wk),tk)],['This month',hoursSum(hDateKey(mo),tk)]];
  const tot=$('hoursTotals'); tot.innerHTML='';
  sums.forEach(function(s){
    const box=el('div','hours-total');
    box.appendChild(el('div','hours-total-k',s[0]));
    box.appendChild(el('div','hours-total-v',fmtHours(s[1].school+s[1].work)));
    box.appendChild(el('div','hours-total-split','School '+fmtHours(s[1].school)+' · Work '+fmtHours(s[1].work)));
    tot.appendChild(box);
  });

  const list=$('hoursList'); list.innerHTML='';
  const byDay={};
  state.hours.entries.forEach(function(e){ (byDay[e.date]=byDay[e.date]||[]).push(e); });
  const days=Object.keys(byDay).sort().reverse();
  $('hoursEmpty').hidden=days.length>0;
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
/* Time sheet due dates: the "Turn in time sheet" tasks on the Work list (each one is a due date). The next
   one shows here with the work hours logged since the one before it, i.e. what goes on that sheet. */
const SHEET_RE=/time\s*-?sheet/i;
function hoursSheetDraw(){
  const box=$('hoursSheet'); if(!box)return;
  const tk=hDateKey(todayStart());
  const sheets=state.tasks.filter(function(t){ return taskWs(t)==='work'&&t.due&&SHEET_RE.test(t.title); });
  const ahead=sheets.filter(function(t){ return !t.done&&t.due>=tk; }).map(function(t){ return t.due; }).sort();
  box.hidden=!ahead.length; box.innerHTML='';
  if(!ahead.length)return;
  const next=ahead[0];
  // the period starts the day after the time sheet before it (or two weeks back when there's none yet)
  const before=sheets.map(function(t){ return t.due; }).filter(function(d){ return d<next; }).sort().pop();
  const from=hParse(before||next); from.setDate(from.getDate()+(before?1:-14));
  const fk=hDateKey(from), worked=hoursSum(fk,tk).work;
  const days=Math.round((hParse(next)-todayStart())/864e5);
  const head=el('div','hours-sheet-head');
  head.appendChild(el('span','hours-sheet-k','Time sheet due'));
  head.appendChild(el('span','hours-sheet-v',hDayLabel(next)+(days>1?' · in '+days+' days':days===1?' · tomorrow':'')));
  box.appendChild(head);
  box.appendChild(el('div','hours-sheet-sub','Work since '+hParse(fk).toLocaleDateString('en-US',{month:'short',day:'numeric'})+': '+fmtHours(worked)));
  if(ahead.length>1)box.appendChild(el('div','hours-sheet-rest','Then '+ahead.slice(1).map(function(d){ return hParse(d).toLocaleDateString('en-US',{month:'short',day:'numeric'}); }).join(', ')));
}
function hoursRow(e){
  const row=el('div','hours-row'+(e.turnedIn?' turned-in':''));
  row.appendChild(el('span','hours-kind '+e.kind,e.kind==='school'?'School':'Work'));
  row.appendChild(el('span','hours-amt mono',fmtHours(e.hours)));
  if(e.turnedIn){ const c=el('span','hours-done'); c.innerHTML=I.check; c.title='Turned in '+new Date(e.turnedIn).toLocaleDateString('en-US',{month:'short',day:'numeric'}); row.appendChild(c); }
  row.appendChild(el('span','hours-note',e.note));
  const edit=iconBtn(I.pen,'Edit entry'); edit.addEventListener('click',function(){ hourUI.editing=e.id; renderHours(); });
  const del=iconBtn(I.x,'Delete entry'); del.addEventListener('click',function(){ hoursRemove(e.id); renderHours(); });
  row.appendChild(edit); row.appendChild(del);
  return row;
}
function hoursEditRow(e){
  const row=el('div','hours-row editing');
  const kind=el('select','sm'); HOUR_KINDS.forEach(function(k){ const o=el('option','',k==='school'?'School':'Work'); o.value=k; kind.appendChild(o); }); kind.value=e.kind;
  const date=el('input','sm'); date.type='date'; date.value=e.date;
  const amt=el('input','sm hours-amt-inp'); amt.value=fmtHours(e.hours); amt.setAttribute('aria-label','Hours');
  const note=el('input','sm hours-note-inp'); note.value=e.note; note.placeholder='Note'; note.setAttribute('aria-label','Note');
  const save=el('button','btn-accent','Save');
  const cancel=el('button','ghost','Cancel');
  function done(){
    const h=parseHours(amt.value);
    if(h===null||h<=0||h>24){ amt.classList.add('bad'); amt.focus(); return; }
    hourUI.editing=null;
    hoursUpdate(e.id,{kind:kind.value,date:date.value||e.date,hours:h,note:note.value.trim()});
    renderHours();
  }
  save.addEventListener('click',done);
  cancel.addEventListener('click',function(){ hourUI.editing=null; renderHours(); });
  [amt,note].forEach(function(i){ i.addEventListener('keydown',function(ev){ if(ev.key==='Enter')done(); else if(ev.key==='Escape'){ hourUI.editing=null; renderHours(); } }); });
  [kind,date,amt,note,save,cancel].forEach(function(n){ row.appendChild(n); });
  setTimeout(function(){ amt.focus(); amt.select(); },0);
  return row;
}
function hoursBuildForm(view){
  view.innerHTML=
    '<div class="hours-form">'+
      '<div class="hours-kinds" role="radiogroup" aria-label="School or work">'+
        '<button type="button" class="hours-kind-btn" data-kind="school" role="radio">School</button>'+
        '<button type="button" class="hours-kind-btn" data-kind="work" role="radio">Work</button>'+
      '</div>'+
      '<input id="hoursDate" class="sm" type="date" aria-label="Day">'+
      '<input id="hoursAmt" class="sm hours-amt-inp" placeholder="Hours (2.5 or 2:30)" aria-label="Hours" inputmode="decimal">'+
      '<input id="hoursNote" class="sm hours-note-inp" placeholder="Note (optional)" aria-label="Note">'+
      '<button id="hoursAddBtn" class="btn-accent">Log hours</button>'+
    '</div>'+
    '<div id="hoursDue" class="hours-due"></div>'+
    '<div id="hoursSheet" class="hours-sheet" hidden></div>'+
    '<div id="hoursTotals" class="hours-totals"></div>'+
    '<div id="hoursList" class="hours-list"></div>'+
    '<div id="hoursEmpty" class="hours-empty">No hours logged yet. Put in how long you worked today above.</div>';
  $('hoursDate').value=hDateKey(new Date());
  view.querySelectorAll('.hours-kind-btn').forEach(function(b){
    b.addEventListener('click',function(){ hourUI.kind=b.dataset.kind; hoursSyncKind(); $('hoursAmt').focus(); });
  });
  function add(){
    const amt=$('hoursAmt'), h=parseHours(amt.value);
    if(h===null||h<=0||h>24){ amt.classList.add('bad'); amt.focus(); return; }
    amt.classList.remove('bad');
    hoursAdd($('hoursDate').value||hDateKey(new Date()),hourUI.kind,h,$('hoursNote').value.trim());
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
