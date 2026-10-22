/* Assets and debts for the Finance tab: what he has (money in accounts) and what he owes (cards, loans).
   An account counts on the side its balance is on that day (SimpleFIN gives card and loan debt as a
   negative balance), so an overdrawn checking account is a debt while it's under zero.
   Past days are worked out backwards from today's balance: each day's balance is today's minus every
   transaction posted after it. That gives the chart a history back to the oldest transaction kept
   (90 days from SimpleFIN, more as the vault builds up) without saving anything new.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them.
   Also loaded by test/finance-worth.test.js, so it uses no page globals. */
'use strict';

const WORTH_DAY=86400000;

// accounts: [{id, name, org, balance, transactions:[{posted (seconds), amount, pending}]}]
// → { days: [{at, assets, debts}] oldest first, one per day up to today; assets: [{name, org, value}],
//     debts: [{name, org, value}] biggest first; assetTotal, debtTotal, net }   (debts are positive numbers)
function worthOf(accounts,now,maxDays){
  now=now||Date.now(); maxDays=maxDays||90;
  accounts=accounts||[];
  const today=new Date(now); today.setHours(0,0,0,0);
  let oldest=today.getTime();
  accounts.forEach(function(a){ (a.transactions||[]).forEach(function(t){ if(!t.pending&&t.posted&&t.posted*1000<oldest)oldest=t.posted*1000; }); });
  const n=Math.max(1,Math.min(maxDays,Math.round((today.getTime()-oldest)/WORTH_DAY)+1));
  const days=[];
  for(let i=n-1;i>=0;i--){
    const d=new Date(today); d.setDate(d.getDate()-i);
    const end=Math.min(now,new Date(d.getFullYear(),d.getMonth(),d.getDate()+1).getTime());
    let assets=0,debts=0;
    accounts.forEach(function(a){
      let b=Number(a.balance)||0;
      (a.transactions||[]).forEach(function(t){ if(!t.pending&&t.posted&&t.posted*1000>=end)b-=t.amount; });
      if(b>=0)assets+=b; else debts-=b;
    });
    days.push({at:d.getTime(),assets:Math.round(assets*100)/100,debts:Math.round(debts*100)/100});
  }
  const side=function(neg){
    return accounts.filter(function(a){ return neg?a.balance<0:a.balance>0; })
      .map(function(a){ return {name:a.name,org:a.org||'',value:Math.abs(a.balance)}; })
      .sort(function(x,y){ return y.value-x.value; });
  };
  const assets=side(false), debts=side(true);
  const sum=function(l){ return l.reduce(function(s,x){ return s+x.value; },0); };
  return {days:days,assets:assets,debts:debts,assetTotal:sum(assets),debtTotal:sum(debts),net:sum(assets)-sum(debts)};
}

if(typeof module!=='undefined'&&module.exports){ module.exports={worthOf:worthOf}; }
