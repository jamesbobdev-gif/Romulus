/* The Calendar tab.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── calendar view ── */
function formatDate(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }

// one line only: chips that don't fit fold into "+N", which opens the Agent tab
function fitNeedsBar(){
  const nb=$('needsBar'); if(nb.hidden)return;
  const chips=[].slice.call(nb.querySelectorAll('.needs-chip')); if(!chips.length||!nb.clientWidth)return; // not laid out yet: nothing to measure
  const more=el('button','needs-chip more'); more.title='Open the Agent tab';
  more.addEventListener('click',function(){ switchTab('agent'); });
  const over=function(){ return nb.scrollWidth>nb.clientWidth+1; };
  if(!over())return;
  let hidden=0;
  nb.appendChild(more);
  for(let i=chips.length-1;i>=0&&over();i--){ chips[i].remove(); hidden++; more.textContent='+'+hidden; }
  more.title=hidden+' more need you — open the Agent tab';
}
let fitNeedsTimer=null;
window.addEventListener('resize',function(){ clearTimeout(fitNeedsTimer); fitNeedsTimer=setTimeout(function(){ if(!$('needsBar').hidden)renderActive(); },150); });
// a couple of words that say which task it is: "Look for motherboard that will allow…" → "motherboard"
const SHORT_SKIP=('a an the my me i you your our some any for of on in at from up out into onto through about please under over near around by like '+
  'look find search get check see go use apply make do help try want need can could should would').split(' ');
const SHORT_STOP='that which who so because if when while with and or but to'.split(' '); // a new clause: the subject's already said
function shortName(title,n){
  const clauses=String(title||'').toLowerCase()
    .replace(/#\S+/g,' ').replace(/\([^)]*\)?/g,' ') // #tags, (asides)
    .split(/[:;,.!?—–]| - /);
  let out=[];
  // the first clause that says something ("Apply — Congresswoman Brown" → "congresswoman brown")
  for(let c=0;c<clauses.length&&!out.length;c++){
    const words=clauses[c].split(/\s+/).map(function(w){ return w.replace(/^[^\w$]+|[^\w$]+$/g,''); }).filter(Boolean);
    for(let i=0;i<words.length&&out.length<n;i++){
      if(SHORT_STOP.indexOf(words[i])!==-1&&out.length)break;
      if(SHORT_SKIP.indexOf(words[i])===-1&&SHORT_STOP.indexOf(words[i])===-1)out.push(words[i]);
    }
  }
  if(!out.length)return String(title||'').trim().split(/\s+/).slice(0,2).join(' ').toLowerCase().slice(0,22)||'task';
  const name=out.join(' ');
  return name.length>22?name.slice(0,21)+'…':name;
}
// two words each; a third (and more) only where two tasks would read the same
function uniqueShortNames(titles){
  const names=titles.map(function(t){ return shortName(t,2); });
  for(let n=3;n<=5;n++){
    const dup=names.map(function(x,i){ return names.indexOf(x)!==i||names.lastIndexOf(x)!==i; });
    if(dup.indexOf(true)===-1)break;
    dup.forEach(function(d,i){ if(d)names[i]=shortName(titles[i],n); });
  }
  return names;
}
function switchTab(tab){
  closeDayPop();
  if(tab!==state.activeTab)state.selectedId=null;
  state.activeTab=tab;
  if(tab!=='ideas')ideaLeave();
  if(tab!=='finance')financeLeave();
  [['tabList','list'],['tabAgent','agent'],['tabSchool','school'],['tabWork','work'],['tabCal','calendar'],['tabIdeas','ideas'],['tabHours','hours'],['tabFinance','finance']].forEach(function(p){
    $(p[0]).classList.toggle('active',tab===p[1]);
    $(p[0]).setAttribute('aria-selected',String(tab===p[1]));
  });
  $('listView').hidden=tab==='calendar'||tab==='ideas'||tab==='hours'||tab==='finance';
  $('calView').hidden=tab!=='calendar';
  $('ideasView').hidden=tab!=='ideas';
  $('hoursView').hidden=tab!=='hours';
  $('financeView').hidden=tab!=='finance';
  document.querySelector('.composer').hidden=tab==='ideas'||tab==='hours'||tab==='finance';
  document.body.classList.toggle('ideas-mode',tab==='ideas');
  if(tab==='calendar')$('newTitle').placeholder='Add a task…'; // render() sets it on the list tabs; don't keep the last one's
  if(tab==='calendar') renderCal(); else if(tab==='ideas') renderIdeas(); else if(tab==='hours') renderHours(); else if(tab==='finance') renderFinance(); else render();
}
