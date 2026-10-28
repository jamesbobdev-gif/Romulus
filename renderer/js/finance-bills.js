/* Bill reminders: when each bill is next due, whether it's paid for that due date, and whether it charges interest.
   Two kinds:
   - a card or loan account that owes money: due on the day of the month he usually pays it (his payments into
     it); paid once a payment lands after the last due date. Interest: a loan always, a card when it charged
     interest in the last couple of months.
   - a monthly bill from the fixed costs (finance-costs.js), not a subscription that charges itself: due on the
     day of the month it usually comes; paid once this month's charge is in. Interest: loans (by name).
   What it gives back is names, due dates and the interest flag, never amounts: main/finance.js keeps that much,
   sealed, so it can remind him while Finance is locked.
   Next to the other Finance readers in renderer/js so the phone could use it too; today main/finance.js and
   test/finance-bills.test.js load it. */
'use strict';

const BILL_DAY=86400000;
const BILL_GRACE=3*BILL_DAY; // a payment a few days after a due date still counts for that one
const BILL_LOAN=/\b(loan|mortgage|heloc|navient|nelnet|mohela|sallie ?mae|aidvantage|edfinancial|student|auto ?(loan|finance)|car ?(loan|payment)|lending|sofi|upstart|affirm)\b/i;
const BILL_INTEREST=/\b(interest|finance charge)\b/i;
const BILL_SELF_CHARGING=/\b(netflix|spotify|hulu|disney|hbo|max\.com|youtube|paramount|peacock|apple\.com|google|icloud|prime|patreon|adobe|microsoft|openai|anthropic|claude|simplefin|audible|crunchyroll)\b/i;

// that day of the month (the 31st is the 30th in a 30-day month)
function billDate(y,m,day){ const last=new Date(y,m+1,0).getDate(); return new Date(y,m,Math.min(day,last)); }
function billYmd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function billMonthAfter(d,day){ return billDate(d.getFullYear(),d.getMonth()+1,day); }
// the usual day of the month, from the newest few times (ms): toward the late end, since a bill gets paid on
// or before its due day (an early payment shouldn't pull the due day in)
function billDayOf(times){
  const days=times.slice().sort(function(a,b){ return b-a; }).slice(0,6).map(function(t){ return new Date(t).getDate(); }).sort(function(a,b){ return a-b; });
  return days[Math.floor(days.length*0.75)];
}
/* this month's due date, unless that one's paid (then next month's). paidAfter(ms) says whether anything was
   paid after that time → {due, paidThrough} (paidThrough: the last due date the bank shows paid, or null) */
function billCycle(day,paidAfter,now){
  const n=new Date(now);
  const due=billDate(n.getFullYear(),n.getMonth(),day);
  const prev=billDate(n.getFullYear(),n.getMonth()-1,day);
  if(paidAfter(prev.getTime()+BILL_GRACE))return {due:billMonthAfter(due,day),paidThrough:due};
  return {due:due,paidThrough:paidAfter(billDate(n.getFullYear(),n.getMonth()-2,day).getTime()+BILL_GRACE)?prev:null};
}
function billTitleCase(s){ return String(s).replace(/\b[a-z]/g,function(c){ return c.toUpperCase(); }); }
const billWhen=function(t){ return (t.posted||Date.now()/1000)*1000; }; // a pending payment counts as made

/* accounts: the vault's accounts. kinds: his fixed/variable corrections. → [{key, name, day (of the month), due: 'YYYY-MM-DD',
   paidThrough: 'YYYY-MM-DD' | null, interest, kind: 'card' | 'loan' | 'bill'}], soonest first */
function billsOf(accounts,kinds,now){
  now=now||Date.now();
  const out=[];
  const debts=(accounts||[]).filter(function(a){ return a&&a.balance<-1&&!(a.holdings&&a.holdings.length); });
  debts.forEach(function(a){
    const label=(a.org||'')+' '+(a.name||'');
    const pays=(a.transactions||[]).filter(function(t){ return t.amount>0; }).map(billWhen);
    if(!pays.length)return; // never paid here: no day to go by
    const day=billDayOf(pays), c=billCycle(day,function(after){ return pays.some(function(t){ return t>after; }); },now);
    const loan=BILL_LOAN.test(label);
    const charged=(a.transactions||[]).some(function(t){ return t.amount<0&&billWhen(t)>now-70*BILL_DAY&&BILL_INTEREST.test([t.description,t.bank,t.memo].join(' ')); });
    out.push({key:'acct:'+a.id,day:day,name:(a.org&&!String(a.name||'').toLowerCase().includes(a.org.toLowerCase())?a.org+' ':'')+(a.name||'card'),
      due:billYmd(c.due),paidThrough:c.paidThrough?billYmd(c.paidThrough):null,interest:loan||charged,kind:loan?'loan':'card'});
  });
  // the monthly bills; a loan's payment from checking is already there as its account
  const fc=typeof costsOf==='function'?{costsOf:costsOf,costKey:costKey}:require('./finance-costs'); // page global, or in node
  const txs=[].concat.apply([],(accounts||[]).map(function(a){ return a.transactions||[]; }));
  const debtText=debts.map(function(a){ return ((a.org||'')+' '+(a.name||'')).toLowerCase(); }).join(' | ');
  fc.costsOf(txs,kinds,now).fixed.forEach(function(f){
    if(BILL_SELF_CHARGING.test(f.key+' '+f.name))return;
    const word=f.key.split(' ').find(function(w){ return w.length>3; });
    if(word&&debtText.includes(word))return;
    const charges=txs.filter(function(t){ return t.amount<0&&fc.costKey(t)===f.key; }).map(billWhen);
    if(!charges.length)return;
    const day=billDayOf(charges), c=billCycle(day,function(after){ return charges.some(function(t){ return t>after; }); },now);
    out.push({key:'bill:'+f.key,day:day,name:billTitleCase(f.key),due:billYmd(c.due),paidThrough:c.paidThrough?billYmd(c.paidThrough):null,
      interest:BILL_LOAN.test(f.key+' '+f.name),kind:'bill'});
  });
  return out.sort(function(a,b){ return a.due<b.due?-1:a.due>b.due?1:0; });
}
// the Human list's to-do for a bill: "Pay Chase Freedom — accrues interest"
function billTitle(b){ return 'Pay '+b.name+(b.interest?' — accrues interest':''); }

if(typeof module!=='undefined'&&module.exports){ module.exports={billsOf:billsOf,billTitle:billTitle,billCycle:billCycle,billYmd:billYmd,billDate:billDate,billMonthAfter:billMonthAfter,selfCharging:BILL_SELF_CHARGING}; }
