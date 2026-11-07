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

if(typeof module!=='undefined'&&module.exports){ module.exports={ebtWallet:ebtWallet,ebtClean:ebtClean,ebtYmd:ebtYmd}; }
