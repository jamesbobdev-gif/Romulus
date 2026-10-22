/* Statements for the Finance tab, laid out like a company's: an income statement (months as columns) and a
   balance sheet (today against 30 and 90 days ago), worked out from the same SimpleFIN data as the rest.
   Income: money in that isn't a transfer between his accounts (finance-costs.js COST_NOT_SPENDING), sorted into
   pay, interest & dividends, refunds (which count against spending) and other income. He can say otherwise
   for a payee's money in (kinds['in:'+payee] = 'income' | 'skip', the tag on it in the transaction list).
   In an investment account only dividends and interest count: buying, selling and moving cash there is his
   own money moving. Expenses: fixed and variable exactly as the cost charts count them, laid out in the
   contribution format: income − variable costs = contribution margin; − fixed costs = net income.
   Every line keeps its transactions (items), so the tab can show what's behind a number.
   Balance sheet: each account's balance on a past day is today's minus what was posted since; investment
   accounts move with the market too, so theirs are only as good as their transactions.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them.
   Also loaded by test/finance-statements.test.js. */
'use strict';

const STMT_COSTS=typeof module!=='undefined'&&module.exports?require('./finance-costs'):{costsOf:costsOf,costKey:costKey,notSpending:COST_NOT_SPENDING};
const STMT_PAY=/\b(payroll|direct ?dep(osit)?|salary|paycheck|pay ?check|wages|dir dep|ach credit.*(pay|sal))\b/i;
const STMT_INTEREST=/\b(interest|dividend|div(idend)? ?(paid|reinv)|apy)\b/i;
const STMT_REFUND=/\b(refund|return|reversal|credit adj|chargeback|cashback|cash back)\b/i;
const STMT_INVEST=/\b(brokerage|invest|ira|401 ?k|403 ?b|roth|hsa|individual|stock|etf|fidelity|schwab|vanguard|robinhood|e\*?trade|webull)\b/i;

const stmtIsInvest=function(a){ return !!((a.holdings&&a.holdings.length)||STMT_INVEST.test((a.name||'')+' '+(a.org||''))); };
// money in: does it count as income? → 'income' | 'skip' (his mark first, then the rules)
function stmtIncomeKind(t,a,kinds){
  const mark=(kinds||{})['in:'+STMT_COSTS.costKey(t)];
  if(mark==='income'||mark==='skip')return mark;
  const text=stmtText(t);
  if(a&&stmtIsInvest(a)&&!STMT_INTEREST.test(text))return 'skip';
  return STMT_COSTS.notSpending.test(text)||(kinds||{})[STMT_COSTS.costKey(t)]==='skip'?'skip':'income';
}
function stmtMonth(ms){ const d=new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }
const stmtText=function(t){ return [t.description,t.bank,t.memo].join(' '); };
const stmtSum=function(rows,n){ const out=new Array(n).fill(0); rows.forEach(function(r){ r.vals.forEach(function(v,i){ out[i]+=v; }); }); return out; };

/* accounts → { cols: [{label, partial}], income, fixed, variable: [{name, vals}], and per column:
   incomeTotal, fixedTotal, variableTotal, expenseTotal, net, savingsRate (null without income) }.
   Columns: the last `full` whole months, then this month so far. Expenses are positive numbers. */
function incomeStatement(accounts,kinds,now,full){
  now=now||Date.now(); full=full||3; kinds=kinds||{};
  const cols=[], at={};
  const d=new Date(now); d.setDate(1); d.setHours(0,0,0,0); d.setMonth(d.getMonth()-full);
  for(let i=0;i<=full;i++){
    at[stmtMonth(d.getTime())]=i;
    cols.push({label:d.toLocaleDateString(undefined,{month:'short',year:i===0||d.getMonth()===0?'numeric':undefined}),partial:i===full});
    d.setMonth(d.getMonth()+1);
  }
  const n=cols.length;
  const txs=[];
  (accounts||[]).forEach(function(a){ (a.transactions||[]).forEach(function(t){ if(t&&t.posted&&!t.pending&&at[stmtMonth(t.posted*1000)]!=null)txs.push({t:t,a:a}); }); });
  const costs=STMT_COSTS.costsOf(txs.map(function(x){ return x.t; }),kinds,now,full+1);
  const lines={income:{},fixed:{},variable:{}};
  const add=function(group,key,name,x,i,v){
    const g=lines[group]; const r=g[key]||(g[key]={name:name,vals:new Array(n).fill(0),items:[]});
    r.vals[i]+=v; r.items.push({t:x.t,account:x.a.name||'',col:i});
  };
  txs.forEach(function(x){
    const t=x.t, i=at[stmtMonth(t.posted*1000)];
    if(t.amount>0){
      if(stmtIncomeKind(t,x.a,kinds)==='skip')return; // his own money moving
      const text=stmtText(t);
      if(STMT_REFUND.test(text))return add('variable','~refunds','Refunds and returns',x,i,-t.amount);
      if(STMT_PAY.test(text))return add('income','pay','Pay',x,i,t.amount);
      if(STMT_INTEREST.test(text))return add('income','interest','Interest and dividends',x,i,t.amount);
      return add('income','other','Other income',x,i,t.amount);
    }
    if(stmtIsInvest(x.a))return; // buying stock or moving cash out of the brokerage isn't spending
    const kind=costs.kindOf(t);
    if(kind==='fixed')add('fixed',STMT_COSTS.costKey(t),t.description||STMT_COSTS.costKey(t),x,i,-t.amount);
    else if(kind==='variable')add('variable',STMT_COSTS.costKey(t),t.description||STMT_COSTS.costKey(t),x,i,-t.amount);
  });
  const total=function(r){ return r.vals.reduce(function(s,v){ return s+v; },0); };
  const income=['pay','interest','other'].map(function(k){ return lines.income[k]; }).filter(Boolean);
  const fixed=Object.keys(lines.fixed).map(function(k){ return lines.fixed[k]; }).sort(function(a,b){ return total(b)-total(a); });
  // variable: the 6 biggest places by name, the rest as one line, refunds last
  const refunds=lines.variable['~refunds'];
  const vs=Object.keys(lines.variable).filter(function(k){ return k!=='~refunds'; }).map(function(k){ return lines.variable[k]; }).sort(function(a,b){ return total(b)-total(a); });
  const variable=vs.slice(0,6);
  if(vs.length>6)variable.push({name:'Everything else ('+(vs.length-6)+' places)',vals:stmtSum(vs.slice(6),n),items:[].concat.apply([],vs.slice(6).map(function(r){ return r.items; }))});
  if(refunds)variable.push(refunds);
  const incomeTotal=stmtSum(income,n), fixedTotal=stmtSum(fixed,n), variableTotal=stmtSum(variable,n);
  const expenseTotal=fixedTotal.map(function(v,i){ return v+variableTotal[i]; });
  const net=incomeTotal.map(function(v,i){ return v-expenseTotal[i]; });
  // contribution margin: what's left of income after the variable costs, to cover the fixed ones
  const contribution=incomeTotal.map(function(v,i){ return v-variableTotal[i]; });
  const ofIncome=function(l){ return l.map(function(v,i){ return incomeTotal[i]>0?v/incomeTotal[i]:null; }); };
  return {cols:cols,income:income,fixed:fixed,variable:variable,incomeTotal:incomeTotal,fixedTotal:fixedTotal,variableTotal:variableTotal,
    expenseTotal:expenseTotal,contribution:contribution,contributionRatio:ofIncome(contribution),net:net,savingsRate:ofIncome(net)};
}

// an account's balance at the end of a past moment: today's minus what was posted after it
function stmtBalanceAt(a,end){
  let b=Number(a.balance)||0;
  (a.transactions||[]).forEach(function(t){ if(!t.pending&&t.posted&&t.posted*1000>end)b-=t.amount; });
  return Math.round(b*100)/100;
}
/* accounts → { cols: [{label, at}], cash, investments, liabilities: [{name, org, vals}] (owed as positive),
   cashTotal, investTotal, assetTotal, liabilityTotal, netWorth }. Columns: now, 30 and 90 days ago. */
function balanceSheet(accounts,now,daysBack){
  now=now||Date.now(); daysBack=daysBack||[0,30,90];
  const cols=daysBack.map(function(days){ return {label:days?days+' days ago':'Today',at:now-days*86400000}; });
  const cash=[], investments=[], liabilities=[];
  (accounts||[]).forEach(function(a){
    const vals=cols.map(function(c){ return c.at>=now?Math.round((Number(a.balance)||0)*100)/100:stmtBalanceAt(a,c.at); });
    const row={name:a.name,org:a.org||'',vals:vals};
    if((Number(a.balance)||0)<0)liabilities.push({name:a.name,org:a.org||'',vals:vals.map(function(v){ return -v; })});
    else if(stmtIsInvest(a))investments.push(row);
    else cash.push(row);
  });
  const n=cols.length, by=function(l){ return l.sort(function(x,y){ return y.vals[0]-x.vals[0]; }); };
  const cashTotal=stmtSum(cash,n), investTotal=stmtSum(investments,n), liabilityTotal=stmtSum(liabilities,n);
  const assetTotal=cashTotal.map(function(v,i){ return v+investTotal[i]; });
  return {cols:cols,cash:by(cash),investments:by(investments),liabilities:by(liabilities),cashTotal:cashTotal,investTotal:investTotal,
    assetTotal:assetTotal,liabilityTotal:liabilityTotal,netWorth:assetTotal.map(function(v,i){ return v-liabilityTotal[i]; })};
}

if(typeof module!=='undefined'&&module.exports){ module.exports={incomeStatement:incomeStatement,balanceSheet:balanceSheet,stmtBalanceAt:stmtBalanceAt,stmtIncomeKind:stmtIncomeKind}; }
