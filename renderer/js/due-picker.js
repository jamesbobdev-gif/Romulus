/* The due date on the add box: one button ("Date", or "Tomorrow 3pm" once set) instead of the browser's
   mm/dd/yyyy and --:-- boxes. It opens quick picks (Today, Tomorrow, the weekend, next week, no date), a
   calendar for any other day, and a time. The real #newDue/#newTime inputs live inside the popup, so
   addTask and voice read and write them as before; setting either from code redraws the button.
   A day typed in the title ("dentist friday at 3") shows on the button too, dashed, so you can see it. */

function duePickKey(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
// the quick picks for a given day: [{name, key}] (key is YYYY-MM-DD)
function duePickDays(now){
  const base=new Date(now||Date.now()); base.setHours(0,0,0,0);
  const plus=function(n){ const d=new Date(base); d.setDate(d.getDate()+n); return duePickKey(d); };
  const dow=base.getDay();
  const toSat=dow===6?7:6-dow; // on a Saturday, the next one
  const toMon=(8-dow)%7||7;    // on a Monday, the next one
  return [
    {name:'Today',key:plus(0)},
    {name:'Tomorrow',key:plus(1)},
    {name:dow===6||dow===0?'Next weekend':'This weekend',key:plus(toSat)},
    {name:'Next week',key:plus(toMon)}
  ];
}
// what the button says for a day: Today, Tomorrow, Sat (this week), else Sat, Nov 28
function duePickLabel(due,now){
  const p=String(due).split('-').map(Number);
  const dt=new Date(p[0],p[1]-1,p[2]);
  const base=new Date(now||Date.now()); base.setHours(0,0,0,0);
  const diff=Math.round((dt-base)/864e5);
  if(diff===0)return 'Today';
  if(diff===1)return 'Tomorrow';
  if(diff>1&&diff<7)return dt.toLocaleDateString('en-US',{weekday:'short'});
  return dt.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
}
// the small date beside a quick pick: Sat, Nov 22
function duePickShort(key){ const p=key.split('-').map(Number); return new Date(p[0],p[1]-1,p[2]).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}); }

if (typeof module !== 'undefined' && module.exports) module.exports = {duePickDays, duePickLabel};

if(typeof document!=='undefined'&&document.getElementById('dueBtn')){(function(){
  const due=$('newDue'), time=$('newTime'), title=$('newTitle');
  const btn=$('dueBtn'), clr=$('dueClear'), pop=$('duePop'), quick=$('dueQuick');
  clr.innerHTML=I.x;

  // any code that sets the boxes (addTask clearing them, voice, "Add anyway") redraws the button
  const valueProp=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
  [due,time].forEach(function(inp){
    Object.defineProperty(inp,'value',{configurable:true,
      get:function(){ return valueProp.get.call(this); },
      set:function(v){ valueProp.set.call(this,v); dueDraw(); }});
  });

  function dueDraw(){
    let text='Date', cls='', tip='Give it a due date';
    if(due.value){
      text=duePickLabel(due.value)+(time.value?' '+fmtTime(time.value):''); cls=' set'; tip='Change the date';
    }else if(title.value.trim()&&state.activeTab!=='agent'){
      const p=parseSpokenTask(title.value);
      if(p.due&&p.title){ text=duePickLabel(p.due)+(p.dueTime?' '+fmtTime(p.dueTime):''); cls=' from-words'; tip='From what you typed. Pick a date to use another.'; }
    }
    btn.className='sm due-btn'+cls; btn.title=tip;
    btn.innerHTML=I.cal; const s=document.createElement('span'); s.textContent=text; btn.appendChild(s);
    clr.hidden=!due.value;
    if(!pop.hidden)drawQuick();
  }
  function drawQuick(){
    quick.innerHTML='';
    duePickDays().concat([{name:'No date',key:''}]).forEach(function(d){
      const b=document.createElement('button'); b.type='button';
      if(d.key&&d.key===due.value)b.className='on';
      const n=document.createElement('span'); n.textContent=d.name; b.appendChild(n);
      if(d.key){ const w=document.createElement('span'); w.className='due-when'; w.textContent=duePickShort(d.key); b.appendChild(w); }
      b.addEventListener('click',function(){ setDue(d.key); close(); title.focus(); });
      quick.appendChild(b);
    });
  }
  function setDue(key){ due.value=key; due.dispatchEvent(new Event('change')); }
  function open(){ pop.hidden=false; btn.setAttribute('aria-expanded','true'); drawQuick(); }
  function close(){ if(pop.hidden)return; pop.hidden=true; btn.setAttribute('aria-expanded','false'); }

  btn.addEventListener('click',function(){ if(pop.hidden)open(); else close(); });
  clr.addEventListener('click',function(){ setDue(''); title.focus(); });
  due.addEventListener('change',dueDraw);
  time.addEventListener('change',dueDraw);
  title.addEventListener('input',dueDraw);
  title.addEventListener('focus',close);
  document.addEventListener('mousedown',function(e){ if(!pop.hidden&&!e.target.closest('.due-wrap'))close(); });
  pop.addEventListener('keydown',function(e){ if(e.key==='Escape'){ close(); btn.focus(); } });
  dueDraw();
})();}
