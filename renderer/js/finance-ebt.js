/* EBT wallet for the Finance tab: about how much SNAP money is left, and when the next deposit lands.
   No bank sends EBT, so it starts from a balance: the one he types in (from his receipt, the state's EBT
   site or Propel), or the one the Agent saw at checkout on a grocery order, whichever is newer.
   From there it takes off what each Agent order put on EBT (order-match.js orderEbtFrom, kept on the order)
   and adds his monthly deposit on its day of the month. Store trips he pays for himself aren't seen, so it's
   "about", and typing in a fresh balance puts it right again.
   What he types (balance, deposit day and amount) lives in the Finance vault with the rest; never a card
   number or PIN.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them.
   Also loaded by test/finance-ebt.test.js, so it uses no page globals. */
'use strict';

const EBT_DAY=86400000;
function ebtCents(n){ return Math.round(n*100)/100; }
// the deposit day in that month, at midnight (the 31st is the 30th in a 30-day month)
function ebtDepositOn(y,m,day){ const last=new Date(y,m+1,0).getDate(); return new Date(y,m,Math.min(day,last)).getTime(); }
function ebtYmd(ms){ const d=new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }

/* The phone and CSV files keep a plain copy of these settings in 'finance.ebtCopy' for the grocery list
   (finance.js finKeepEbtCopy). Saved from Settings → EBT while Finance is locked, the copy gets pending: true,
   and the next unlock (finance-phone.js, finance-csv.js) moves it into the vault. The computer does the same
   with its sealed file (main/finance.js takeLockedEbt). */
const EBT_COPY_KEY='finance.ebtCopy';
function ebtKeepPending(e){
  try{ localStorage.setItem(EBT_COPY_KEY,JSON.stringify(Object.assign(ebtClean(e),{pending:true}))); return true; }catch(err){ return false; }
}
// → the settings saved while locked, or null. ebtFinishPending drops the mark once they're in the vault
function ebtPending(){
  try{ const c=JSON.parse(localStorage.getItem(EBT_COPY_KEY)||'null'); return c&&c.pending?ebtClean(c):null; }catch(err){ return null; }
}
function ebtFinishPending(e){ try{ localStorage.setItem(EBT_COPY_KEY,JSON.stringify(ebtClean(e))); }catch(err){} }

// what he typed, cleaned: {balance, at (ms), day (1-31), monthly} with anything missing or wrong left out
function ebtClean(e){
  e=e&&typeof e==='object'?e:{};
  const out={};
  const b=Number(e.balance), at=Number(e.at), day=Math.round(Number(e.day)), mo=Number(e.monthly);
  if(e.balance!=null&&e.balance!==''&&Number.isFinite(b)&&b>=0&&b<100000&&at>0){ out.balance=ebtCents(b); out.at=at; }
  if(day>=1&&day<=31)out.day=day;
  if(e.monthly!=null&&e.monthly!==''&&Number.isFinite(mo)&&mo>0&&mo<100000)out.monthly=ebtCents(mo);
  return out;
}

/* ebt: his settings (ebtClean). orders: agentOrders (order-match.js), each maybe with ebt (paid on EBT) and
   ebtLeft (the balance left after it, from what checkout showed).
   → { known: whether there's a balance to go by, balance, asOf (ms of the balance it started from),
       from: 'typed' | 'checkout', spent: [{title, at, ebt}] since the last deposit (or the last 30 days),
       spentTotal, deposits: how many deposits were added, lastDeposit, nextDeposit (ms or null), daysToDeposit } */
function ebtWallet(ebt,orders,now){
  now=now||Date.now();
  const e=ebtClean(ebt);
  const paid=(orders||[]).filter(function(o){ return o&&o.ebt>0&&o.at>0&&o.at<=now; });
  let start=null;
  if(e.balance!=null)start={at:e.at,balance:e.balance,from:'typed'};
  (orders||[]).forEach(function(o){
    if(o&&o.ebtLeft!=null&&o.at>0&&o.at<=now&&(!start||o.at>start.at))start={at:o.at,balance:o.ebtLeft,from:'checkout'};
  });

  // deposit days: the one at or before now, and the next one
  let lastDeposit=null, nextDeposit=null;
  if(e.day){
    const n=new Date(now);
    const thisMonth=ebtDepositOn(n.getFullYear(),n.getMonth(),e.day);
    lastDeposit=thisMonth<=now?thisMonth:ebtDepositOn(n.getFullYear(),n.getMonth()-1,e.day);
    nextDeposit=thisMonth>now?thisMonth:ebtDepositOn(n.getFullYear(),n.getMonth()+1,e.day);
  }

  let balance=null, deposits=0;
  if(start){
    balance=start.balance;
    paid.forEach(function(o){ if(o.at>start.at)balance-=o.ebt; });
    if(e.day&&e.monthly){
      const s=new Date(start.at);
      for(let i=0;i<24;i++){ // every deposit day after the start, up to now
        const d=ebtDepositOn(s.getFullYear(),s.getMonth()+i,e.day);
        if(d>now)break;
        if(d>start.at){ balance+=e.monthly; deposits++; }
      }
    }
    balance=ebtCents(balance);
  }

  const since=lastDeposit||now-30*EBT_DAY;
  const spent=paid.filter(function(o){ return o.at>=since; }).sort(function(a,b){ return b.at-a.at; })
    .map(function(o){ return {title:o.title||o.store||'Grocery order',at:o.at,ebt:o.ebt}; });
  return {known:!!start,balance:balance,asOf:start?start.at:null,from:start?start.from:null,
    spent:spent,spentTotal:ebtCents(spent.reduce(function(s,x){ return s+x.ebt; },0)),
    deposits:deposits,lastDeposit:lastDeposit,nextDeposit:nextDeposit,
    daysToDeposit:nextDeposit==null?null:Math.ceil((nextDeposit-now)/EBT_DAY)};
}

/* ── a receipt photo (Finance → EBT → read a receipt): most store receipts print the SNAP balance left ── */
const EBT_RECEIPT_ASK='The attached picture is a photo of a store receipt, not his screen. Find the EBT / SNAP food balance '+
  'left after this purchase (often "SNAP BAL", "FS BAL", "EBT FOOD BAL", "FOOD STAMP BALANCE" or "Ending balance" in the EBT '+
  'section; not the cash benefit balance, not the total, not change due) and the date on the receipt. Answer with only this '+
  'JSON, nothing else: {"balance": 0.00 or null, "date": "YYYY-MM-DD" or null}. Use null when it isn\'t printed or you can\'t read it.';
// the AI's answer → {balance, at (ms)} or null. A date in the future or over 60 days old isn't trusted: today then
function ebtReceiptAnswer(text,now){
  now=now||Date.now();
  const m=String(text||'').match(/\{[\s\S]*?\}/); if(!m)return null;
  let j; try{ j=JSON.parse(m[0]); }catch(e){ return null; }
  const b=Number(j&&j.balance);
  if(j==null||j.balance==null||!Number.isFinite(b)||b<0||b>=100000)return null;
  let at=now;
  if(/^\d{4}-\d{2}-\d{2}$/.test(String(j.date||''))){
    const p=j.date.split('-').map(Number), d=new Date(p[0],p[1]-1,p[2],20).getTime(); // evening: after that day's shopping
    if(d<=now+EBT_DAY&&d>now-60*EBT_DAY)at=Math.min(d,now);
  }
  return {balance:ebtCents(b),at:at};
}

/* ── alerts (ebt-alerts.js): what to tell him now, each once ──
   seen: {key: ms} of ones already told. → [{key, title, body}]
   - deposit day: "EBT deposit today", with about the balance after it
   - each Agent order that put money on EBT (in the last 2 days): how much, and about what's left
   - under his low mark (low, dollars): once per deposit cycle */
function ebtAlertsDue(ebt,orders,seen,low,now){
  now=now||Date.now(); seen=seen||{};
  const w=ebtWallet(ebt,orders,now), e=ebtClean(ebt), out=[];
  const money=function(n){ return '$'+n.toFixed(2); };
  if(w.lastDeposit!=null&&now-w.lastDeposit<EBT_DAY){
    const k='dep|'+ebtYmd(w.lastDeposit);
    if(!seen[k])out.push({key:k,title:'EBT deposit today',body:(e.monthly?money(e.monthly)+' should load today.':'Your benefits should load today.')+(w.known?' About '+money(w.balance)+' on the card.':'')});
  }
  (orders||[]).forEach(function(o){
    if(!o||!(o.ebt>0)||!(o.at>now-2*EBT_DAY)||o.at>now)return;
    const k='ord|'+o.at;
    if(!seen[k])out.push({key:k,title:money(o.ebt)+' on EBT',body:(o.title||'Grocery order')+(w.known?'. About '+money(w.balance)+' left.':'.')});
  });
  if(w.known&&low>0&&w.balance<low){
    const k='low|'+(w.lastDeposit!=null?ebtYmd(w.lastDeposit):ebtYmd(now).slice(0,7));
    if(!seen[k])out.push({key:k,title:'EBT running low',body:'About '+money(w.balance)+' left'+(w.nextDeposit!=null?', next deposit '+new Date(w.nextDeposit).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'')+'.'});
  }
  return out;
}

if(typeof module!=='undefined'&&module.exports){ module.exports={ebtWallet:ebtWallet,ebtClean:ebtClean,ebtYmd:ebtYmd,ebtReceiptAnswer:ebtReceiptAnswer,ebtAlertsDue:ebtAlertsDue,EBT_RECEIPT_ASK:EBT_RECEIPT_ASK,
  ebtKeepPending:ebtKeepPending,ebtPending:ebtPending,ebtFinishPending:ebtFinishPending}; }
