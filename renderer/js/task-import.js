/* Bringing tasks over from another app. Reads the file each popular app exports, or a pasted list:
     Todoist        a project's CSV (Export as a template → Export as file); sections and @labels become tags,
                    indented tasks become steps, "every monday" style dates become repeats
     TickTick       the backup CSV (Settings → Account → Generate backup); lists and tags, checklists → steps,
                    subtasks → steps, its repeat rules → repeats, finished ones
     Google Tasks   Tasks.json from Google Takeout (or the Takeout .zip itself); lists → tags, subtasks → steps
     Trello         a board's JSON export; labels (or the card's list) → tag, checklists → steps
     Asana          a project's CSV; sections → tags, subtasks → steps
     Notion         a database's CSV (or the export .zip); read like any spreadsheet
     any CSV        a spreadsheet saved as CSV: columns named like Task/Title/Name, Due/Date, Notes, Tag/List, Done/Status
     a plain list   one task per line (Apple Reminders, Things, Microsoft To Do and notes apps copy out this way);
                    "- [x]" is finished, indented lines are steps of the line above, "# Heading" or "Heading:" tags the ones under it
   parseImport() turns any of these into plain items; importToTasks() makes Romulus tasks from them, each with an id
   made from where it came from, so importing the same file twice doesn't add copies.
   One of the page scripts in renderer/js (they share one global scope); also loaded by test/task-import.test.js,
   so the reading part uses no page globals. The card that drives it is at the bottom, and runs only in the page. */
'use strict';

const IMP_MAX=5000;
const impTxt=function(v,n){ return String(v==null?'':v).replace(/[\u0000-\u0008\u000b-\u001f]/g,' ').trim().slice(0,n||500); };
function impYmd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function impHm(d){ return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
const impRecur=(typeof recurFromWords==='function')?recurFromWords:(typeof require==='function'?require('./quick-add').recurFromWords:null);
const impTag=(typeof tagFromWords==='function')?tagFromWords:(typeof require==='function'?require('./quick-add').tagFromWords:null);

/* ── CSV ── quoted fields, doubled quotes, commas/newlines inside quotes; ; or tab when the file uses those */
function impSplitCsv(text){
  text=String(text||'').replace(/^\uFEFF/,'');
  const lines=text.split(/\r?\n/).slice(0,12);
  const score=function(sep){ return Math.max.apply(null,lines.map(function(l){ return l.split(sep).length; })); };
  const sep=[',','\t',';'].sort(function(a,b){ return score(b)-score(a); })[0];
  const rows=[]; let row=[], cell='', q=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){ cell+='"'; i++; } else q=false; } else cell+=c; }
    else if(c==='"'&&cell.trim()==='')q=true;
    else if(c===sep){ row.push(cell); cell=''; }
    else if(c==='\n'||c==='\r'){
      if(c==='\r'&&text[i+1]==='\n')i++;
      row.push(cell); cell='';
      if(row.some(function(x){ return x.trim()!==''; }))rows.push(row);
      row=[];
      if(rows.length>IMP_MAX*2)break;
    } else cell+=c;
  }
  row.push(cell);
  if(row.some(function(x){ return x.trim()!==''; }))rows.push(row);
  return rows;
}

/* ── dates ── → {due:'YYYY-MM-DD'|null, dueTime:'HH:MM'|null} */
const IMP_MON=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function impTime(h,m,ap){
  h=Number(h); m=Number(m||0);
  if(ap){ ap=ap.toLowerCase(); if(ap[0]==='p'&&h<12)h+=12; if(ap[0]==='a'&&h===12)h=0; }
  if(h>23||m>59)return null;
  return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
}
function impValid(y,mo,d){ const dt=new Date(y,mo-1,d); return dt.getFullYear()===y&&dt.getMonth()===mo-1&&dt.getDate()===d?dt:null; }
// dateOnly: the stamp is a day written as UTC midnight (Google Tasks), so its date is read as written, not moved to local time
function impDate(s,opts){
  opts=opts||{};
  s=impTxt(s,80); if(!s)return {due:null,dueTime:null};
  const now=opts.now?new Date(opts.now):new Date();
  let m;
  // 2026-11-10, 2026-11-10 15:00, 2026-11-10T15:00:00Z, 2026-11-10T08:00:00+0000
  if((m=/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(s))){
    if(m[6]&&!opts.dateOnly){
      const dt=new Date(m[1]+'-'+m[2]+'-'+m[3]+'T'+m[4].padStart(2,'0')+':'+m[5]+':00'+(m[6].toUpperCase()==='Z'?'Z':m[6].replace(/(\d{2})(\d{2})$/,'$1:$2')));
      if(isNaN(dt))return {due:null,dueTime:null};
      return {due:impYmd(dt),dueTime:opts.allDay?null:impHm(dt)};
    }
    if(!impValid(+m[1],+m[2],+m[3]))return {due:null,dueTime:null};
    const time=m[4]&&!opts.dateOnly&&!opts.allDay&&!(m[4]==='00'&&m[5]==='00')?impTime(m[4],m[5]):null;
    return {due:m[1]+'-'+m[2]+'-'+m[3],dueTime:time};
  }
  const timeOf=function(rest){ const t=/(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i.exec(rest||''); return t&&(t[2]||t[3])?impTime(t[1],t[2],t[3]&&t[3].replace(/\./g,'')):null; };
  // 11/10/2026, 11/10/26, 10/11/2026 when the first number can't be a month
  if((m=/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{2}|\d{4})\b(.*)$/.exec(s))){
    let a=+m[1], b=+m[2], y=+m[3]; if(y<100)y+=2000;
    let mo=a, d=b; if(a>12&&b<=12){ mo=b; d=a; }
    const dt=impValid(y,mo,d); if(!dt)return {due:null,dueTime:null};
    return {due:impYmd(dt),dueTime:timeOf(m[4])};
  }
  // Nov 10 2026, November 10, 2026 3pm, 10 Nov 2026, Nov 10 (this year, or next if that's long gone)
  const mon=function(w){ const i=IMP_MON.indexOf(String(w).slice(0,3).toLowerCase()); return i<0?null:i+1; };
  let mo=null, d=null, y=null, rest='';
  if((m=/^(?:[a-z]{3,9},?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?\b(.*)$/i.exec(s))&&mon(m[1])){ mo=mon(m[1]); d=+m[2]; y=m[3]?+m[3]:null; rest=m[4]; }
  else if((m=/^(?:[a-z]{3,9},?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?,?(?:\s+(\d{4}))?\b(.*)$/i.exec(s))&&mon(m[2])){ mo=mon(m[2]); d=+m[1]; y=m[3]?+m[3]:null; rest=m[4]; }
  if(mo){
    if(!y){ y=now.getFullYear(); const t=impValid(y,mo,d); if(t&&(now-t)>180*864e5)y++; }
    const dt=impValid(y,mo,d); if(!dt)return {due:null,dueTime:null};
    return {due:impYmd(dt),dueTime:timeOf(rest)};
  }
  return {due:null,dueTime:null};
}
const impDone=function(v){ return /^(true|yes|y|1|x|done|completed?|finished|closed|checked|\u2713|\u2714)$/i.test(impTxt(v,20)); };

/* RRULE (TickTick, Google) → a recur.js rule */
function impRrule(s){
  s=String(s||'').toUpperCase(); if(!/FREQ=/.test(s))return null;
  const get=function(k){ const m=new RegExp(k+'=([^;]+)').exec(s); return m?m[1]:null; };
  const f=get('FREQ'), n=+(get('INTERVAL')||1), by=get('BYDAY');
  if(f==='DAILY'&&n===1)return 'day';
  if(f==='WEEKLY'&&by&&by.split(',').sort().join(',')==='FR,MO,TH,TU,WE')return 'weekday';
  if(f==='WEEKLY'&&n===1)return 'week';
  if(f==='WEEKLY'&&n===2)return '2week';
  if(f==='MONTHLY'&&n===1)return 'month';
  if(f==='YEARLY'&&n===1)return 'year';
  return null;
}
// "every monday", "every day" as a whole due string (Todoist) → {every, due}
function impRecurWords(s,now){
  if(!impRecur||!s)return null;
  const r=impRecur('x '+s,now);
  return r&&r.title==='x'?r:null;
}
function impTagName(s){ s=impTxt(s,40).replace(/^#/,''); return s&&!/^(inbox|my tasks|tasks|reminders|no list|none)$/i.test(s)?s:null; }
function impItem(o){
  return {title:impTxt(o.title,500),notes:impTxt(o.notes,8000)||null,due:o.due||null,dueTime:o.due&&o.dueTime||null,
    done:!!o.done,doneAt:o.doneAt||null,tag:impTagName(o.tag||''),recur:o.due?(o.recur||null):null,
    subs:(o.subs||[]).filter(function(x){ return x&&impTxt(x.title); }).map(function(x){ return {title:impTxt(x.title,300),done:!!x.done}; }),
    key:o.key||null};
}

/* ── Todoist: TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,… ── */
function impTodoist(rows,opts){
  const h=rows[0].map(function(x){ return x.trim().toUpperCase(); });
  const at=function(k){ return h.indexOf(k); };
  const iT=at('TYPE'), iC=at('CONTENT'), iD=at('DESCRIPTION'), iI=at('INDENT'), iDate=at('DATE'), iDl=at('DEADLINE');
  const out=[]; let section=null, parent=null;
  const project=opts.fileName?impTagName(opts.fileName.replace(/\.[a-z]+$/i,'').replace(/[_-]+/g,' ')):null;
  rows.slice(1).forEach(function(r,n){
    const type=(r[iT]||'').trim().toLowerCase(), content=impTxt(r[iC]);
    if(type==='section'){ section=content; parent=null; return; }
    if(type==='note'){ if(parent&&content)parent.notes=(parent.notes?parent.notes+'\n\n':'')+content; return; }
    if(type!=='task'||!content)return;
    let title=content, tag=null;
    const lab=/(^|\s)@([\w-]{1,30})/.exec(title);
    if(lab){ tag=lab[2]; title=title.replace(/(^|\s)@[\w-]{1,30}/g,' ').replace(/\s+/g,' ').trim(); }
    const indent=+(r[iI]||1);
    if(indent>1&&parent){ parent.subs.push({title:title,done:false}); return; }
    const words=impTxt(r[iDate],80);
    const rec=impRecurWords(words,opts.now);
    let d=rec?{due:rec.due,dueTime:null}:impDate(words,opts);
    if(!d.due&&iDl>=0)d=impDate(r[iDl],opts);
    const t={title:title,notes:impTxt(r[iD],8000),due:d.due,dueTime:d.dueTime,tag:tag||section||project,recur:rec?rec.every:null,subs:[],key:'todoist:'+(opts.fileName||'')+':'+n};
    out.push(t); parent=t;
  });
  return out;
}

/* ── TickTick backup: a few lines about the file, then "Folder Name","List Name","Title","Kind","Tags","Content",… ── */
function impTickTick(rows,opts){
  const hi=rows.findIndex(function(r){ const s=r.join('|'); return /\bTitle\b/.test(s)&&/List Name/.test(s); });
  const h=rows[hi].map(function(x){ return x.trim().toLowerCase(); });
  const at=function(k){ return h.indexOf(k); };
  const c={list:at('list name'),title:at('title'),kind:at('kind'),tags:at('tags'),content:at('content'),start:at('start date'),due:at('due date'),
    repeat:at('repeat'),status:at('status'),done:at('completed time'),allDay:at('is all day'),id:at('taskid'),parent:at('parentid')};
  const byId={}, out=[];
  rows.slice(hi+1).forEach(function(r){
    const title=impTxt(r[c.title]); if(!title)return;
    const allDay=/^true$/i.test(impTxt(r[c.allDay]));
    const d=impDate(r[c.due]||r[c.start],Object.assign({},opts,{allDay:allDay}));
    const status=impTxt(r[c.status]);
    const done=status!==''&&status!=='0';
    let notes=impTxt(r[c.content],8000), subs=[];
    // a checklist's items sit in its content, one per line: \u25ab to do, \u25aa done
    if(/checklist/i.test(impTxt(r[c.kind]))||/^[\u25ab\u25aa]/m.test(notes)){
      const keep=[];
      notes.split(/\r?\n/).forEach(function(l){ const m=/^\s*([\u25ab\u25aa])\s*(.*)$/.exec(l); if(m&&m[2].trim())subs.push({title:m[2].trim(),done:m[1]==='\u25aa'}); else keep.push(l); });
      notes=keep.join('\n').trim();
    }
    const tags=impTxt(r[c.tags]).split(/[,;]/).map(function(x){ return x.trim(); }).filter(Boolean);
    const doneAt=done&&r[c.done]?Date.parse(String(r[c.done]).replace(/([+-]\d{2})(\d{2})$/,'$1:$2'))||null:null;
    const t={title:title,notes:notes,due:d.due,dueTime:d.dueTime,done:done,doneAt:doneAt,tag:tags[0]||impTxt(r[c.list]),
      recur:impRrule(r[c.repeat]),subs:subs,key:'ticktick:'+(impTxt(r[c.id])||title+'|'+d.due)};
    const pid=impTxt(r[c.parent]);
    if(pid&&byId[pid]){ byId[pid].subs.push({title:title,done:done}); return; }
    if(impTxt(r[c.id]))byId[impTxt(r[c.id])]=t;
    out.push(t);
  });
  return out;
}

/* ── Asana: Task ID,Created At,Completed At,Last Modified,Name,Section/Column,Assignee,…,Due Date,Tags,Notes,Projects,Parent task ── */
function impAsana(rows,opts){
  const h=rows[0].map(function(x){ return x.trim().toLowerCase(); });
  const at=function(k){ return h.indexOf(k); };
  const c={id:at('task id'),done:at('completed at'),name:at('name'),section:at('section/column'),due:at('due date'),tags:at('tags'),notes:at('notes'),parent:at('parent task')};
  const out=[], byName={}, later=[];
  rows.slice(1).forEach(function(r){
    const title=impTxt(r[c.name]); if(!title)return;
    const d=impDate(r[c.due],opts);
    const t={title:title,notes:impTxt(r[c.notes],8000),due:d.due,dueTime:d.dueTime,done:!!impTxt(r[c.done]),doneAt:Date.parse(r[c.done])||null,
      tag:impTxt(r[c.tags]).split(',')[0]||impTxt(r[c.section]).replace(/:$/,''),subs:[],key:'asana:'+(impTxt(r[c.id])||title)};
    const p=c.parent>=0?impTxt(r[c.parent]):'';
    if(p){ later.push([p,t]); return; }
    byName[title]=t; out.push(t);
  });
  later.forEach(function(x){ if(byName[x[0]])byName[x[0]].subs.push({title:x[1].title,done:x[1].done}); else out.push(x[1]); });
  return out;
}

/* ── any spreadsheet: work out the columns from the header ── */
const IMP_COLS={
  title:/^(title|name|task|tasks|task name|to ?do|todo|item|subject|summary|content|description|what)$/i,
  due:/^(due|due ?date|date|deadline|due on|when|reminder|start ?date|end ?date|do date)$/i,
  time:/^(time|due ?time|start ?time)$/i,
  notes:/^(notes?|description|details|body|comments?|memo|content)$/i,
  done:/^(done|completed?|status|finished|checked|state|is ?completed|completed at|completed on|done at)$/i,
  tag:/^(tags?|labels?|list|list name|project|category|folder|section|context|area|group)$/i
};
function impColumns(header){
  const h=header.map(function(x){ return impTxt(x,60).replace(/\s+/g,' '); });
  const at={};
  ['title','due','time','done','tag','notes'].forEach(function(k){
    for(let i=0;i<h.length;i++){ if(IMP_COLS[k].test(h[i])&&!Object.values(at).includes(i)){ at[k]=i; break; } }
  });
  return at;
}
function impGenericCsv(rows,opts){
  let at=impColumns(rows[0]), body=rows.slice(1);
  if(at.title==null){ at={title:0}; body=rows; } // no header: the first column is the task
  return body.map(function(r,n){
    const title=impTxt(r[at.title]); if(!title)return null;
    const d=impDate(r[at.due],opts);
    if(at.time!=null&&d.due&&!d.dueTime){ const t=/(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i.exec(r[at.time]||''); if(t)d.dueTime=impTime(t[1],t[2],t[3]); }
    const dv=at.done!=null?impTxt(r[at.done],60):'';
    // a status of "Done"/"Complete", a tick, or a completed-at date
    const done=impDone(dv)||/^(done|complete|completed|finished|closed)\b/i.test(dv)||!!impDate(dv,opts).due;
    return {title:title,notes:at.notes!=null?impTxt(r[at.notes],8000):null,due:d.due,dueTime:d.dueTime,done:done,tag:at.tag!=null?impTxt(r[at.tag]).split(/[,;]/)[0]:null,
      subs:[],key:'csv:'+(opts.fileName||'')+':'+title+'|'+(d.due||'')+'|'+n};
  }).filter(Boolean);
}

/* ── Trello board JSON ── */
function impTrello(j){
  // keyed by ids from the file: plain maps with no prototype, so an id like "__proto__" is just another key
  const lists=Object.create(null); (j.lists||[]).forEach(function(l){ if(l&&l.id!=null)lists[l.id]=l; });
  const labels=Object.create(null); (j.labels||[]).forEach(function(l){ if(l&&l.id!=null)labels[l.id]=l.name||l.color; });
  const checks=Object.create(null); (j.checklists||[]).forEach(function(c){ if(c&&c.idCard!=null)(checks[c.idCard]=checks[c.idCard]||[]).push(c); });
  return (j.cards||[]).filter(function(c){ return !c.closed&&!(lists[c.idList]&&lists[c.idList].closed); }).map(function(c){
    const list=lists[c.idList]?lists[c.idList].name:'';
    const d=impDate(c.due);
    const subs=[]; (checks[c.id]||[]).forEach(function(cl){ (cl.checkItems||[]).slice().sort(function(a,b){ return (a.pos||0)-(b.pos||0); }).forEach(function(it){ subs.push({title:it.name,done:it.state==='complete'}); }); });
    const label=(c.idLabels||[]).map(function(id){ return labels[id]; }).filter(Boolean)[0];
    const doneList=/^(done|complete|completed|finished)\b/i.test(list);
    return {title:c.name,notes:c.desc,due:d.due,dueTime:d.dueTime,done:!!c.dueComplete||doneList,tag:label||(doneList?null:list),subs:subs,key:'trello:'+c.id};
  });
}

/* ── Google Tasks (Takeout Tasks.json) ── */
function impGoogle(j){
  const out=[];
  (j.items||[]).forEach(function(list){
    const byId={}, kids=[];
    (list.items||[]).forEach(function(t){
      if(t.deleted||!impTxt(t.title))return;
      const d=impDate(t.due,{dateOnly:true});
      const it={title:t.title,notes:t.notes,due:d.due,dueTime:null,done:t.status==='completed',doneAt:Date.parse(t.completed)||null,tag:list.title,subs:[],key:'gtasks:'+(t.id||t.title)};
      if(t.parent){ kids.push([t.parent,it]); return; }
      byId[t.id]=it; out.push(it);
    });
    kids.forEach(function(k){ if(byId[k[0]])byId[k[0]].subs.push({title:k[1].title,done:k[1].done}); else out.push(k[1]); });
  });
  return out;
}

/* ── a pasted (or .txt / .md) list ── */
// the add box's date reader, parseSpokenTask (task-actions.js, another page script); looked up when a list is
// read, so the tests can put it on the global object
function impWhen(s,now){
  const read=typeof parseSpokenTask==='function'?parseSpokenTask:(typeof globalThis!=='undefined'&&globalThis.parseSpokenTask);
  if(typeof read!=='function')return null;
  try{ return read(s,now?new Date(now):new Date()); }catch(e){ return null; }
}
function impText(text,opts){
  const out=[]; let heading=null, last=null;
  String(text||'').replace(/^\uFEFF/,'').split(/\r?\n/).forEach(function(raw,n){
    if(!raw.trim())return;
    const indent=/^(\s*)/.exec(raw.replace(/\t/g,'    '))[1].length;
    let s=raw.trim();
    const h=/^#{1,6}\s+(.+)$/.exec(s)||(/^[^-*\u2022\d\[].{0,40}:$/.test(s)?[s,s.slice(0,-1)]:null);
    if(h&&indent===0){ heading=h[1].trim(); last=null; return; }
    let done=false;
    s=s.replace(/^([-*+\u2022\u25e6\u25aa\u25ab]|\d{1,3}[.)])\s+/,'');
    const box=/^(\[( |x|X)\]|\u2610|\u2611|\u2612|\u2713|\u2714|\u25cb|\u25cf)\s*/.exec(s);
    if(box){ done=/[xX\u2611\u2612\u2713\u2714\u25cf]/.test(box[1]); s=s.slice(box[0].length); }
    s=s.trim(); if(!s)return;
    if(indent>=2&&last){ last.subs.push({title:s,done:done}); return; }
    let tag=heading, rec=null;
    if(impTag){ const g=impTag(s); if(g.tag){ s=g.title; tag=g.tag; } }
    if(impRecur){ const r=impRecur(s,opts.now); if(r){ s=r.title; rec=r; } }
    const key='text:'+s.toLowerCase()+'|'+n;
    // "Call dentist tomorrow", "Pay rent every month on the 1st": the day comes out of the title as it does in the
    // add box (task-actions.js); "every sunday" keeps its own day over one that's also typed
    let due=rec?rec.due:null, dueTime=null;
    const p=impWhen(s,opts.now);
    if(p&&p.due&&p.title){ s=p.title; if(!(rec&&rec.onDay)){ due=p.due; dueTime=p.dueTime; } }
    last={title:s,done:done,tag:tag,due:due,dueTime:dueTime,recur:rec?rec.every:null,subs:[],key:key};
    out.push(last);
  });
  return out;
}

/* ── which one is it ── → {source, items:[…]} */
const IMP_NAMES={todoist:'Todoist',ticktick:'TickTick',gtasks:'Google Tasks',trello:'Trello',asana:'Asana',csv:'a spreadsheet',text:'a list',json:'a JSON file'};
function parseImport(text,opts){
  opts=opts||{};
  text=String(text||'').replace(/^\uFEFF/,'');
  const name=String(opts.fileName||'').toLowerCase();
  let source=null, items=[];
  const t=text.trim();
  if(/^[\[{]/.test(t)){
    let j=null; try{ j=JSON.parse(t); }catch(e){}
    if(j&&j.cards&&j.lists){ source='trello'; items=impTrello(j); }
    else if(j&&(j.kind==='tasks#taskLists'||(Array.isArray(j.items)&&j.items.some(function(x){ return x&&Array.isArray(x.items); })))){ source='gtasks'; items=impGoogle(j); }
    else if(j&&Array.isArray(j)&&j.length&&typeof j[0]==='object'){ // an array of records: read it as a table
      const keys=Object.keys(j[0]); source='json';
      items=impGenericCsv([keys].concat(j.map(function(o){ return keys.map(function(k){ const v=o[k]; return v==null?'':typeof v==='object'?(Array.isArray(v)?impJoin(v):''):String(v); }); })),opts);
    }
    else if(j)return {source:'json',items:[],error:'That file doesn’t look like a task list Romulus can read.'};
  }
  if(!source){
    const rows=/\.(md|markdown|txt)$/.test(name)?null:impSplitCsv(text);
    const head=rows&&rows[0]?rows[0].map(function(x){ return x.trim(); }):[];
    if(rows&&head[0]&&head[0].toUpperCase()==='TYPE'&&head.map(function(x){ return x.toUpperCase(); }).includes('CONTENT')){ source='todoist'; items=impTodoist(rows,opts); }
    else if(rows&&rows.slice(0,12).some(function(r){ const s=r.join('|'); return /\bTitle\b/.test(s)&&/List Name/.test(s); })){ source='ticktick'; items=impTickTick(rows,opts); }
    else if(rows&&head.includes('Task ID')&&head.includes('Name')&&head.includes('Section/Column')){ source='asana'; items=impAsana(rows,opts); }
    else if(rows&&rows.length>1&&head.length>1&&(/\.(csv|tsv)$/.test(name)||impColumns(head).title!=null)){ source='csv'; items=impGenericCsv(rows,opts); }
    else { source='text'; items=impText(text,opts); }
  }
  items=items.slice(0,IMP_MAX).map(impItem).filter(function(x){ return x.title; });
  return {source:source,name:IMP_NAMES[source]||source,items:items};
}

/* ── items → Romulus tasks ──
   ws: the list they go on. existing: tasks already here; tombstones: ids taken off (a task deleted after an import
   doesn't come back on the next one). Skipped: ones already here (same id, or same name and date). */
function impHash(s){ let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return (h>>>0).toString(36); }
function importToTasks(items,o){
  o=o||{};
  const now=o.now||Date.now();
  const have={}; (o.existing||[]).forEach(function(t){ have[t.id]=1; });
  (o.tombstones||[]).forEach(function(t){ have[t.id||t]=1; });
  const norm=function(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); };
  const same={}; (o.existing||[]).forEach(function(t){ same[norm(t.title)+'|'+(t.due||'')]=1; });
  const tasks=[]; let skipped=0;
  items.forEach(function(it,i){
    if(it.done&&!o.withDone)return;
    const id='imp-'+impHash(it.key||it.title+'|'+(it.due||''));
    const k=norm(it.title)+'|'+(it.due||'');
    if(have[id]||same[k]){ skipped++; return; }
    have[id]=1; same[k]=1;
    const t={id:id,title:it.title,done:!!it.done,due:it.due||null,dueTime:it.dueTime||null,tag:it.tag||null,ws:o.ws||'personal',
      subs:it.subs.map(function(s,j){ return {id:id+'-'+j,title:s.title,done:!!s.done,due:null}; }),googleEventId:null,created:now+i};
    if(it.notes)t.notes=it.notes;
    if(it.done)t.doneAt=it.doneAt||now;
    if(it.recur&&t.due)t.recur={every:it.recur,dom:Number(t.due.slice(8)),series:id};
    if(t.ws==='school')t.kind='regular';
    tasks.push(t);
  });
  return {tasks:tasks,skipped:skipped};
}

// a value that is a list in a JSON export → "a, b" (one nested too deep to flatten just comes out empty, never a crash)
function impJoin(v){ try{ return v.flat(20).map(function(x){ return x==null?'':String(x); }).join(', ').slice(0,2000); }catch(e){ return ''; } }

/* ── zip files (Google Takeout, Notion) ── read with the browser's own inflate; only the files that could be tasks */
const IMP_ZIP_FILE_MAX=20e6;
// the browser's inflate, read in pieces and stopped past max bytes: a zip's directory can say a file is small when it isn't
async function impInflate(raw,max){
  const rd=new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts=[]; let n=0;
  for(;;){
    const r=await rd.read(); if(r.done)break;
    n+=r.value.length;
    if(n>max){ rd.cancel().catch(function(){}); throw new Error('a file in the zip is too big'); }
    parts.push(r.value);
  }
  const out=new Uint8Array(n); let o=0; parts.forEach(function(p){ out.set(p,o); o+=p.length; });
  return out;
}
async function impUnzip(buf){
  const b=new Uint8Array(buf), v=new DataView(buf);
  let e=-1; for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--){ if(v.getUint32(i,true)===0x06054b50){ e=i; break; } }
  if(e<0)throw new Error('not a zip');
  const count=v.getUint16(e+10,true); let p=v.getUint32(e+16,true);
  const files=[];
  for(let n=0;n<count;n++){
    if(p+46>b.length||v.getUint32(p,true)!==0x02014b50)break; // offsets from the file itself: checked before they are read
    const method=v.getUint16(p+10,true), comp=v.getUint32(p+20,true), size=v.getUint32(p+24,true), nl=v.getUint16(p+28,true), xl=v.getUint16(p+30,true), cl=v.getUint16(p+32,true), off=v.getUint32(p+42,true);
    if(p+46+nl>b.length)break;
    const name=new TextDecoder().decode(b.subarray(p+46,p+46+nl));
    p+=46+nl+xl+cl;
    if(!/\.(csv|json|txt|md)$/i.test(name)||/(^|\/)(__MACOSX|\.)/.test(name)||size>IMP_ZIP_FILE_MAX||comp>IMP_ZIP_FILE_MAX)continue;
    if(off+30>b.length)continue;
    const start=off+30+v.getUint16(off+26,true)+v.getUint16(off+28,true);
    if(start+comp>b.length)continue;
    const raw=b.subarray(start,start+comp);
    let data;
    if(method===0)data=raw;
    else if(method===8)data=await impInflate(raw,IMP_ZIP_FILE_MAX);
    else continue;
    files.push({name:name,text:new TextDecoder().decode(data)});
  }
  // Notion puts each table in twice ("Tasks.csv" and "Tasks_all.csv"): keep the full one
  const names=new Set(files.map(function(f){ return f.name; }));
  return files.filter(function(f){ return !/\.csv$/i.test(f.name)||/_all\.csv$/i.test(f.name)||!names.has(f.name.replace(/\.csv$/i,'_all.csv')); });
}

if(typeof module!=='undefined'&&module.exports)module.exports={parseImport:parseImport,importToTasks:importToTasks,impDate:impDate,impRrule:impRrule,impSplitCsv:impSplitCsv,impUnzip:impUnzip};

/* ── the card: pick where from, see how to get the file, choose it (or paste), check what came out, import ── */
if(typeof document!=='undefined'&&document.getElementById('importCard'))(function(){
  const SOURCES=[
    ['Todoist','In Todoist (web or computer app), open a project, click the three dots at the top, choose Export as a template, then Export as file. That saves a CSV. Do it for each project; you can pick several files at once. Sections and labels become tags.'],
    ['TickTick','In TickTick on the web, go to Settings, then Account, and press Generate backup. That saves a CSV with every list. Lists and tags become tags; checklists become steps.'],
    ['Google Tasks','Go to takeout.google.com, press Deselect all, tick Tasks, then Next step and Create export. Google emails you a link: choose the .zip it gives you (or the Tasks.json inside it).'],
    ['Trello','Open the board, open its menu (the three dots), choose Print, export and share, then Export as JSON. Save that page as a file and choose it here. Labels become tags and checklists become steps.'],
    ['Asana','Open the project, click the arrow next to its name, choose Export/Print, then CSV. Sections become tags; subtasks become steps.'],
    ['Microsoft To Do','To Do has no export file. In the Windows app, open a list, open its menu (the three dots) and choose Email list or Print list, then copy the tasks from there and paste them below, one per line.',true],
    ['Apple Reminders','On a Mac, open Reminders, click a list, press Command-A to select every reminder, then Command-C to copy. Paste them below.',true],
    ['Notion','Open the tasks database, click the three dots at the top right, choose Export, pick Markdown & CSV, and export. Choose the .zip it saves (or the .csv inside it).'],
    ['A spreadsheet','In Excel, Google Sheets or Numbers, save or download the sheet as CSV. Columns named like Task, Due, Notes, Tag and Done are picked up; with no header, the first column is the task.'],
    ['A plain list','Paste one task per line. "- [x]" marks one finished, indented lines become steps of the line above, and "# Heading" or "Heading:" tags the tasks under it. Things, notes apps and email lists paste in this way.',true]
  ];
  const card=$('importCard');
  let pending=null; // {name, items}
  const box=$('importSources');
  SOURCES.forEach(function(s){
    const b=el('button','ghost mono import-src',s[0]); b.type='button';
    b.addEventListener('click',function(){
      box.querySelectorAll('.import-src').forEach(function(x){ x.classList.toggle('active',x===b); });
      $('importHow').textContent=s[1]; $('importHow').hidden=false;
      if(s[2])$('importPaste').focus();
    });
    box.appendChild(b);
  });
  function status(msg,err){ const st=$('importStatus'); st.textContent=msg||''; st.style.color=err?'var(--late)':''; }
  function lists(){
    const sel=$('importWs'), cur=sel.value;
    sel.textContent='';
    [['personal','Personal'],['work','Work']].concat(typeof schoolConfigured==='function'&&schoolConfigured()?[['school','School']]:[]).forEach(function(o){
      const op=el('option',null,o[1]); op.value=o[0]; sel.appendChild(op);
    });
    sel.value=cur||(state.activeTab==='work'||state.activeTab==='school'?state.activeTab:'personal');
    if(!sel.value)sel.value='personal';
  }
  function preview(res){
    pending=res;
    const pv=$('importPreview');
    if(!res||!res.items.length){ pv.hidden=true; status(res?(res.error||'No tasks found in that. Check it’s the file the steps above give you.'):'',!!res); return; }
    status('');
    const done=res.items.filter(function(i){ return i.done; }).length, open=res.items.length-done;
    $('importSummary').textContent='Found '+res.items.length+' task'+(res.items.length===1?'':'s')+' from '+res.name+(done?': '+open+' to do, '+done+' finished.':'.');
    const ul=$('importSample'); ul.textContent='';
    const shown=res.items.filter(function(i){ return !i.done; }).concat(res.items.filter(function(i){ return i.done; }));
    shown.slice(0,6).forEach(function(i){
      const li=el('li',null,i.title);
      const bits=[i.tag?'#'+i.tag:'',i.due?dateInfo(i.due,i.dueTime).text:'',i.recur?'repeats':'',i.subs.length?i.subs.length+' step'+(i.subs.length===1?'':'s'):'',i.done?'finished':''].filter(Boolean);
      if(bits.length)li.appendChild(el('span','import-meta',' '+bits.join(' · ')));
      ul.appendChild(li);
    });
    if(shown.length>6)ul.appendChild(el('li','import-meta','and '+(shown.length-6)+' more'));
    $('importDoneRow').hidden=!done; $('importDone').checked=false;
    $('importDoneText').textContent='Also bring the '+done+' finished one'+(done===1?'':'s');
    lists(); pv.hidden=false;
  }
  async function readFiles(files){
    status('Reading…'); $('importPreview').hidden=true;
    const all=[], names=new Set();
    try{
      for(const f of files){
        if(/\.zip$/i.test(f.name)||f.type==='application/zip'){
          let inner;
          try{ inner=await impUnzip(await f.arrayBuffer()); }catch(e){ status('Couldn’t open '+f.name+'. Unzip it and choose the file inside instead.',true); return; }
          inner.forEach(function(x){ const r=parseImport(x.text,{fileName:x.name.split('/').pop()}); if(r.items.length){ all.push.apply(all,r.items); names.add(r.name); } });
        } else {
          const r=parseImport(await f.text(),{fileName:f.name});
          if(r.items.length){ all.push.apply(all,r.items); names.add(r.name); }
          else if(files.length===1&&r.error){ preview(r); return; }
        }
      }
    }catch(e){ status('Couldn’t read that file: '+(e.message||e),true); return; }
    preview({name:names.size===1?Array.from(names)[0]:'your files',items:all});
  }
  $('importFileBtn').addEventListener('click',function(){ $('importFile').click(); });
  $('importFile').addEventListener('change',function(){ const f=Array.from(this.files||[]); this.value=''; if(f.length){ $('importPaste').value=''; readFiles(f); } });
  // a file dropped on the card works too
  card.addEventListener('dragover',function(e){ if(e.dataTransfer&&Array.from(e.dataTransfer.types||[]).includes('Files')){ e.preventDefault(); card.classList.add('drop'); } });
  card.addEventListener('dragleave',function(){ card.classList.remove('drop'); });
  card.addEventListener('drop',function(e){ card.classList.remove('drop'); const f=Array.from(e.dataTransfer&&e.dataTransfer.files||[]); if(f.length){ e.preventDefault(); readFiles(f); } });
  let pasteT=null;
  $('importPaste').addEventListener('input',function(){
    clearTimeout(pasteT); const v=this.value;
    pasteT=setTimeout(function(){ if(!v.trim()){ preview(null); return; } let r; try{ r=parseImport(v); }catch(e){ preview(null); return; } if(r.source==='text')r.name='what you pasted'; preview(r); },300);
  });
  $('importGo').addEventListener('click',function(){
    if(!pending||!pending.items.length)return;
    const ws=$('importWs').value||'personal', where=$('importWs').selectedOptions[0].textContent;
    const r=importToTasks(pending.items,{ws:ws,withDone:$('importDone').checked,existing:state.tasks,tombstones:state.tombstones});
    r.tasks.forEach(function(t){ state.tasks.push(t); });
    $('importPreview').hidden=true; $('importPaste').value=''; pending=null;
    status(r.tasks.length
      ?'Added '+r.tasks.length+' task'+(r.tasks.length===1?'':'s')+' to '+where+'.'+(r.skipped?' '+r.skipped+' '+(r.skipped===1?'was':'were')+' already here.':'')
      :(r.skipped?'Nothing new: '+(r.skipped===1?'it’s':'all '+r.skipped+' are')+' already here.':'Nothing to add.'));
    if(r.tasks.length){
      if(typeof buzz==='function')buzz('add');
      if(state.activeTab!==(ws==='personal'?'list':ws))switchTab(ws==='personal'?'list':ws);
      touch();
    }
  });
  function openImport(){
    if(typeof setSettingsOpen==='function')setSettingsOpen(false);
    if($('listView').hidden||state.activeTab==='agent')switchTab('list');
    card.hidden=false; status(''); lists();
    requestAnimationFrame(function(){ card.scrollIntoView({block:'start',behavior:'smooth'}); });
  }
  window.openImport=openImport;
  $('importClose').addEventListener('click',function(e){ e.preventDefault(); card.hidden=true; if(typeof drawSyncNudge==='function')drawSyncNudge(); });
  $('importOpenBtn').addEventListener('click',openImport);
  $('welcomeImportBtn').addEventListener('click',function(){ if(typeof markWelcomed==='function')markWelcomed(); openImport(); });
})();
