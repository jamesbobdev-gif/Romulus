/* Fixed and variable costs for the Finance tab's two charts.
   Fixed = the bills that come back every month for about the same amount (rent, insurance, phone, streaming),
   found by a known bill name or by repeating: charged in 2+ months, at most about once a month, each charge
   within 15% of the usual one. Variable = every other purchase. Money in, transfers between his own
   accounts and card payments aren't spending at all (a card payment would count the card's purchases twice).
   He can correct a payee on the tab (fixed / variable / not spending); that's kept in the vault by payee.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them.
   Also loaded by test/finance-costs.test.js, so it uses no page globals. */
'use strict';

const COST_FIXED_WORDS=/\b(rent|mortgage|hoa|insurance|geico|progressive|state ?farm|allstate|netflix|spotify|hulu|disney|hbo|max\.com|youtube ?premium|paramount|peacock|apple\.com\/bill|google \*?(storage|one)|icloud|prime video|amazon prime|verizon|t-?mobile|at ?& ?t|sprint|mint mobile|cricket|comcast|xfinity|spectrum|cox comm|internet|electric|energy|power co|water|sewer|utilit|gas co|planet fitness|gym|fitness|loan|navient|nelnet|mohela|sallie mae|car payment|auto pay(ment)?|lease|simplefin|patreon|adobe|microsoft|openai|anthropic|claude\.ai)\b/i;
const COST_NOT_SPENDING=/\b(transfer|xfer|payment.{0,12}thank|thank you.{0,12}payment|credit card (payment|pmt)|card ?services|cardmember|crd ?pmt|epay|autopay.{0,12}(card|visa|mastercard|discover|amex)|(to|from) (savings|checking)|zelle from|venmo cashout|paypal transfer)\b/i;
const COST_DAY=86400000;

// one name per payee: "NETFLIX.COM 866-579 CA" and "NETFLIX.COM 123" are the same one (the name is what
// comes before the bank's first number, store code or *reference)
function costKey(t){
  const raw=String((t&&(t.description||t.bank))||'').toLowerCase();
  const tidy=function(x){ return x.replace(/[^a-z&.' ]+/g,' ').replace(/\s+/g,' ').trim(); };
  const s=tidy(raw.replace(/(^|\s)[^\s]*[0-9#*].*$/,''))||tidy(raw.replace(/[0-9#*_]+/g,' ')); // "7-ELEVEN 123": the name has a number in it
  return s.split(' ').filter(function(w){ return w.length>1||w==='&'; }).slice(0,3).join(' ')||'(no name)';
}
function costMonth(ms){ const d=new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }
function costMedian(a){ const s=a.slice().sort(function(x,y){ return x-y; }); const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; }

// its own guess for a payee from all its charges (newest history included): 'fixed' | 'variable' | 'skip'
function costGuess(key,charges){
  const text=charges.map(function(t){ return [t.description,t.bank,t.memo].join(' '); }).join(' ');
  if(COST_NOT_SPENDING.test(text))return 'skip';
  if(COST_FIXED_WORDS.test(text))return 'fixed';
  const months={}; charges.forEach(function(t){ months[costMonth(t.posted*1000)]=1; });
  const n=Object.keys(months).length;
  if(n<2||charges.length>n*1.5)return 'variable';
  const usual=costMedian(charges.map(function(t){ return -t.amount; }));
  return charges.every(function(t){ return Math.abs(-t.amount-usual)<=usual*0.15; })?'fixed':'variable';
}

/* txs: every posted transaction, any account. kinds: his corrections {payeeKey: 'fixed'|'variable'|'skip'}.
   → { kindOf(t) (null for money in), fixed: [{key, name, monthly, last}] biggest first, fixedTotal,
       months: [{month, label, total, partial}] oldest first, the last one this month so far } */
function costsOf(txs,kinds,now,monthsBack){
  now=now||Date.now(); kinds=kinds||{}; monthsBack=monthsBack||6;
  const groups={};
  (txs||[]).forEach(function(t){ if(t&&t.amount<0&&t.posted)(groups[costKey(t)]=groups[costKey(t)]||[]).push(t); });
  const kindByKey={};
  kinds=Object.keys(kinds).reduce(function(o,k){ if(['fixed','variable','skip'].indexOf(kinds[k])!==-1)o[k]=kinds[k]; return o; },{}); // not the money-in marks
  Object.keys(groups).forEach(function(k){ kindByKey[k]=kinds[k]||costGuess(k,groups[k]); });
  const kindOf=function(t){ if(!t||!(t.amount<0))return null; const k=costKey(t); return kinds[k]||kindByKey[k]||(t.posted?'variable':costGuess(k,[t])); };

  const fixed=[];
  Object.keys(groups).forEach(function(k){
    if(kindByKey[k]!=='fixed')return;
    const g=groups[k].slice().sort(function(a,b){ return b.posted-a.posted; });
    const last=g[0].posted*1000;
    if(now-last>45*COST_DAY&&!kinds[k])return; // stopped coming: cancelled, or a yearly bill shown when it's due
    const byMonth={}; g.forEach(function(t){ const m=costMonth(t.posted*1000); byMonth[m]=(byMonth[m]||0)-t.amount; });
    fixed.push({key:k,name:g[0].description||k,monthly:costMedian(Object.keys(byMonth).map(function(m){ return byMonth[m]; })),last:last});
  });
  fixed.sort(function(a,b){ return b.monthly-a.monthly; });

  const months=[], d=new Date(now); d.setDate(1); d.setHours(0,0,0,0); d.setMonth(d.getMonth()-(monthsBack-1));
  for(let i=0;i<monthsBack;i++){
    months.push({month:costMonth(d.getTime()),label:d.toLocaleDateString(undefined,{month:'short'}),total:0,partial:i===monthsBack-1});
    d.setMonth(d.getMonth()+1);
  }
  const at={}; months.forEach(function(m){ at[m.month]=m; });
  Object.keys(groups).forEach(function(k){
    groups[k].forEach(function(t){ const m=at[costMonth(t.posted*1000)]; if(m&&kindOf(t)==='variable')m.total-=t.amount; });
  });
  return { kindOf:kindOf, fixed:fixed, fixedTotal:fixed.reduce(function(s,f){ return s+f.monthly; },0), months:months };
}

if(typeof module!=='undefined'&&module.exports){ module.exports={costKey:costKey,costGuess:costGuess,costsOf:costsOf,notSpending:COST_NOT_SPENDING}; }
