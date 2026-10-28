/* Bill reminders on the Human list (main/finance.js billsNow, worked out by renderer/js/finance-bills.js):
   - on this computer, every hour and whenever Finance works its bills out again: a "Pay …" to-do for each bill
     due within 3 days (or overdue), dated its due day, "— accrues interest" when it does; the to-dos of bills
     the bank shows paid get checked off. Works while Finance is locked; paid is learned when it unlocks.
   - on the phone, where those to-dos arrive through sync: a notification when one arrives and another at 9am
     on its due day, both taken back once it's checked off or gone.
   - charges worth a second look (a double charge, $100+ from a new payee, a foreign fee) come the same way, as
     "Check a …" to-dos dated the day they're found, with one notification on the phone.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

const BILL_TAG='bill';
const CHARGE_TAG='charge'; // "Check a possible double charge from …" (finance-insights.js oddCharges)
const BILL_NOTE_KEY='billNotes'; // {taskId: due} this phone has notifications set for
function isBillTask(prefix,t){ return t.tag===BILL_TAG&&taskWs(t)==='personal'&&(t.title===prefix||t.title.startsWith(prefix+' —')); }

async function billCheck(){
  if(!window.desktop||!window.desktop.financeBills)return;
  let r; try{ r=await window.desktop.financeBills(); }catch(e){ return; }
  if(!r)return;
  let changed=false;
  (r.paid||[]).forEach(function(p){
    state.tasks.forEach(function(t){ if(!t.done&&t.due&&t.due<=p.through&&isBillTask(p.prefix,t)){ t.done=true; changed=true; } });
  });
  (r.due||[]).forEach(function(b){
    const tag=b.kind==='charge'?CHARGE_TAG:BILL_TAG;
    if(state.tasks.some(function(t){ return t.tag===tag&&taskWs(t)==='personal'&&(tag===CHARGE_TAG?t.title===b.title:t.due===b.due&&isBillTask(b.prefix,t)); }))return;
    state.tasks.push({id:uid(),title:b.title,done:false,due:b.due,dueTime:null,tag:tag,ws:'personal',subs:[],googleEventId:null,created:Date.now()});
    changed=true;
  });
  if(changed)touch();
}
if(window.desktop&&window.desktop.financeBills){
  setTimeout(billCheck,8000);
  setInterval(billCheck,60*60*1000);
  if(window.desktop.onFinanceUpdated)window.desktop.onFinanceUpdated(function(what){ if(what==='bills')billCheck(); });
}

// two notification ids per to-do (arrived, due day), steady across restarts
function billNoteIds(id){ let h=0; for(let i=0;i<id.length;i++)h=(h*31+id.charCodeAt(i))|0; h=Math.abs(h)%1000000000; return [h*2,h*2+1]; }
// the phone (Capacitor LocalNotifications); a no-op on desktop. Called after each save and sync
function billAlerts(){
  const cap=window.Capacitor;
  if(!cap||typeof cap.nativePromise!=='function'||!(cap.isPluginAvailable&&cap.isPluginAvailable('LocalNotifications')))return;
  const call=function(method,opts){ try{ return Promise.resolve(cap.nativePromise('LocalNotifications',method,opts||{})).catch(function(){}); }catch(e){ return Promise.resolve(); } };
  let had={}; try{ had=JSON.parse(localStorage.getItem(BILL_NOTE_KEY)||'{}')||{}; }catch(e){}
  const open={};
  state.tasks.forEach(function(t){ if((t.tag===BILL_TAG||t.tag===CHARGE_TAG)&&!t.done&&t.due&&taskWs(t)==='personal')open[t.id]=t; });
  const cancel=[], add=[];
  Object.keys(had).forEach(function(id){ if(!open[id]||open[id].due!==had[id])billNoteIds(id).forEach(function(n){ cancel.push({id:n}); }); });
  Object.keys(open).forEach(function(id){
    const t=open[id];
    if(had[id]===t.due)return;
    const n=billNoteIds(id), p=t.due.split('-').map(Number);
    const onDay=new Date(p[0],p[1]-1,p[2],9,0,0);
    const when=onDay.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
    if(t.tag===CHARGE_TAG){ if(!had[id])add.push({id:n[0],title:'Check a charge',body:t.title,schedule:{at:new Date(Date.now()+3000)}}); return; }
    if(!had[id])add.push({id:n[0],title:'Bill due '+when,body:t.title,schedule:{at:new Date(Date.now()+3000)}}); // it just came
    if(onDay.getTime()>Date.now())add.push({id:n[1],title:'Bill due today',body:t.title,schedule:{at:onDay}});
  });
  const now={}; Object.keys(open).forEach(function(id){ now[id]=open[id].due; });
  try{ localStorage.setItem(BILL_NOTE_KEY,JSON.stringify(now)); }catch(e){}
  if(!cancel.length&&!add.length)return;
  (cancel.length?call('cancel',{notifications:cancel}):Promise.resolve()).then(function(){
    if(!add.length)return;
    return call('requestPermissions').then(function(){ return call('schedule',{notifications:add}); });
  });
}
setTimeout(billAlerts,4000);
