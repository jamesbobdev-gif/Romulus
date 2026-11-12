/* EBT alerts, on every device while Finance → EBT is on (grocery-list.js ebtOn):
   - deposit day: "EBT deposit today"
   - each Agent grocery order that put money on EBT: how much, and about what's left
   - under his low mark (Finance → EBT, $25 to start): once per deposit cycle
   What's due comes from finance-ebt.js ebtAlertsDue, on the wallet's settings the grocery list already has
   (groceryEbt: Finance's sealed copy on the computer, this device's copy elsewhere), so it works while
   Finance is locked. Each alert is told once per device ('ebt.alerted').
   On the phone it's a notification (Capacitor LocalNotifications), and the next deposit's is set ahead for
   9am that day, so it comes with the app closed. On the computer: a system notification and a toast.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

const EBT_SEEN_KEY='ebt.alerted', EBT_LOW_KEY='ebt.low', EBT_LOW_START=25;
const EBT_DEPOSIT_NOTE=880000001; // the phone's set-ahead deposit notification (one at a time)
function ebtLow(){ try{ const v=localStorage.getItem(EBT_LOW_KEY); if(v==null)return EBT_LOW_START; const n=Number(v); return n>=0?n:EBT_LOW_START; }catch(e){ return EBT_LOW_START; } }
function ebtPhoneNotes(){
  const cap=window.Capacitor;
  if(!cap||typeof cap.nativePromise!=='function'||!(cap.isPluginAvailable&&cap.isPluginAvailable('LocalNotifications')))return null;
  return function(method,opts){ try{ return Promise.resolve(cap.nativePromise('LocalNotifications',method,opts||{})).catch(function(){}); }catch(e){ return Promise.resolve(); } };
}
function ebtNoteId(key){ let h=0; for(let i=0;i<key.length;i++)h=(h*31+key.charCodeAt(i))|0; return 880000100+Math.abs(h)%100000000; }

function ebtAlertCheck(){
  if(typeof ebtAlertsDue!=='function'||typeof ebtOn!=='function')return;
  const call=ebtPhoneNotes();
  if(!ebtOn()){ if(call)call('cancel',{notifications:[{id:EBT_DEPOSIT_NOTE}]}); return; }
  const orders=agentOrders(state.tasks), now=Date.now();
  let seen=null; try{ seen=JSON.parse(localStorage.getItem(EBT_SEEN_KEY)||'null'); }catch(e){}
  const first=!seen||typeof seen!=='object'; if(first)seen={};
  const due=ebtAlertsDue(groceryEbt,orders,seen,ebtLow(),now);
  Object.keys(seen).forEach(function(k){ if(seen[k]<now-90*86400000)delete seen[k]; }); // old ones go
  due.forEach(function(a){ seen[a.key]=now; });
  try{ localStorage.setItem(EBT_SEEN_KEY,JSON.stringify(seen)); }catch(e){}
  // the first look on this device only learns what's already there: no burst of old news
  if(!first)due.forEach(function(a){
    if(call)call('requestPermissions').then(function(){ return call('schedule',{notifications:[{id:ebtNoteId(a.key),title:a.title,body:a.body,schedule:{at:new Date(Date.now()+3000)}}]}); });
    else{
      try{ if(window.Notification&&Notification.permission!=='denied')new Notification(a.title,{body:a.body,silent:false}); }catch(e){}
      if(typeof voiceToast==='function')voiceToast(a.title+': '+a.body);
    }
  });
  // the phone: the next deposit's notification, set ahead for 9am that day
  if(call){
    const w=ebtWallet(groceryEbt,orders,now);
    if(w.nextDeposit!=null){
      const at=new Date(w.nextDeposit); at.setHours(9,0,0,0);
      const e=ebtClean(groceryEbt);
      call('schedule',{notifications:[{id:EBT_DEPOSIT_NOTE,title:'EBT deposit today',body:e.monthly?'$'+e.monthly.toFixed(2)+' should load today.':'Your benefits should load today.',schedule:{at:at}}]});
      seen['dep|'+ebtYmd(w.nextDeposit)]=now; // told ahead: not again when the day comes
      try{ localStorage.setItem(EBT_SEEN_KEY,JSON.stringify(seen)); }catch(e){}
    }else call('cancel',{notifications:[{id:EBT_DEPOSIT_NOTE}]});
  }
}
// after the wallet loads, every 5 minutes, and when a sync or the Agent brings a new order
setTimeout(ebtAlertCheck,6000);
setInterval(ebtAlertCheck,5*60*1000);

// Finance → EBT (finance.js finEbtCard): the low mark, typed like "$25". → false when it isn't an amount
function setEbtLow(text){
  const n=Number(String(text).replace(/[$,\s]/g,''));
  if(String(text).trim()===''||!(n>=0))return false;
  try{ localStorage.setItem(EBT_LOW_KEY,String(n)); }catch(e){}
  ebtAlertCheck();
  return true;
}
