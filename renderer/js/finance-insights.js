/* The Finance tab's look-overs, from what the bank sent (and the stock rows from finance-core.js):
   - debtPlan: each card and loan, the interest it charged, a rough rate from that, which one costs the most
     (pay extra there first), and how long his usual payment takes to clear it.
   - subscriptionCheck: price rises, how long each one has been charging, ones that just started, and a small
     trial charge followed by the full price.
   - cancelPage: the company's own cancel page for a subscription, or a web search for one.
   - discountCheck: a student or EBT price on something he already pays full price for (Prime, Spotify...).
   - oddCharges: a possible double charge, $100+ from a payee never paid before, a foreign transaction fee.
   - portfolioMix: what the stocks add up to by sector, industry, holding, and stocks vs funds.
   - stocksCsv: the holdings as a spreadsheet to download.
   Nothing here gives advice beyond the arithmetic: the rate is worked back from interest actually charged.
   One of the page scripts in renderer/js (after finance-costs.js and finance-bills.js); main/finance.js and
   test/finance-insights.test.js load it too. */
'use strict';

const INS_DAY=86400000;
const INS_INTEREST=/\b(interest|finance charge)\b/i;
const INS_FOREIGN=/\b(foreign (transaction|trans|txn|currency)|international (transaction|purchase|fee)|intl (txn|trans|fee)|fx fee|cross[- ]border)\b/i;
const insCosts=function(){ return typeof costsOf==='function'?{costsOf:costsOf,costKey:costKey,notSpending:COST_NOT_SPENDING}:require('./finance-costs'); };
const insBills=function(){ return typeof billsOf==='function'?{billsOf:billsOf,selfCharging:BILL_SELF_CHARGING}:require('./finance-bills'); };
const insMs=function(t){ return (t.posted||Date.now()/1000)*1000; };
const insText=function(t){ return [t.description,t.bank,t.memo].join(' '); };
function insRound(n){ return Math.round(n*100)/100; }

/* → {debts: [{id, name, owed, interestMonth, interestYear, rate (yearly %, null when it charged none lately),
   monthlyPay, months (to clear at that pace, null when it won't), interestLeft, due, interest}], first (the
   name to put extra toward), interestMonth, interestYear} — highest rate first */
function debtPlan(accounts,kinds,now){
  now=now||Date.now();
  const bills={}; insBills().billsOf(accounts,kinds,now).forEach(function(b){ bills[b.key]=b; });
  const debts=(accounts||[]).filter(function(a){ return a&&a.balance<-1&&!(a.holdings&&a.holdings.length); }).map(function(a){
    const txs=a.transactions||[];
    const charged=function(from){ return txs.filter(function(t){ return t.amount<0&&insMs(t)>=from&&INS_INTEREST.test(insText(t)); }).reduce(function(s,t){ return s-t.amount; },0); };
    const owed=-a.balance, interestMonth=charged(now-35*INS_DAY), interestYear=charged(now-365*INS_DAY);
    // its yearly rate, worked back from the last month's interest on what's owed now
    const rate=interestMonth>0?Math.round(interestMonth/owed*12*1000)/10:null;
    // his usual payment: what went in over the last 3 months, a month's worth
    const paid=txs.filter(function(t){ return t.amount>0&&insMs(t)>=now-92*INS_DAY; }).reduce(function(s,t){ return s+t.amount; },0);
    const monthlyPay=paid>0?insRound(paid/3):0;
    let months=null, interestLeft=null;
    if(monthlyPay>0){
      const r=(rate||0)/100/12; let left=owed, n=0, int=0;
      while(left>0.005&&n<600){ const i=left*r; int+=i; left=left+i-monthlyPay; n++; if(i>=monthlyPay)break; }
      if(left<=0.005){ months=n; interestLeft=insRound(int); }
    }
    const b=bills['acct:'+a.id];
    return {id:a.id,name:(a.org&&!String(a.name||'').toLowerCase().includes(a.org.toLowerCase())?a.org+' ':'')+(a.name||'card'),
      owed:insRound(owed),interestMonth:insRound(interestMonth),interestYear:insRound(interestYear),rate:rate,monthlyPay:monthlyPay,
      months:months,interestLeft:interestLeft,due:b?b.due:null,interest:b?b.interest:interestMonth>0};
  }).sort(function(x,y){ return (y.rate||0)-(x.rate||0)||y.owed-x.owed; });
  const costly=debts.filter(function(d){ return d.rate; });
  return {debts:debts,first:costly.length?costly[0].name:null,
    interestMonth:insRound(debts.reduce(function(s,d){ return s+d.interestMonth; },0)),
    interestYear:insRound(debts.reduce(function(s,d){ return s+d.interestYear; },0))};
}

/* subscriptions: the monthly bills that charge on their own (a known name, or under $60 and not a loan) →
   {subs: [{key, name, monthly, last, since, months}], total, raised: [{name, from, to, when}] (any monthly bill,
   rent included), fresh: [{name, amount, when}] (first charged in the last 40 days, history going back further) */
function subscriptionCheck(txs,kinds,now){
  now=now||Date.now();
  const fc=insCosts();
  const c=fc.costsOf(txs,kinds,now);
  const byKey={};
  (txs||[]).forEach(function(t){ if(t&&t.amount<0&&t.posted)(byKey[fc.costKey(t)]=byKey[fc.costKey(t)]||[]).push(t); });
  const subs=[], raised=[], fresh=[];
  const selfCharging=insBills().selfCharging, loanish=/\b(loan|mortgage|rent|insurance|lease)\b/i;
  let earliest=now; (txs||[]).forEach(function(t){ if(t&&t.posted&&t.posted*1000<earliest)earliest=t.posted*1000; });
  c.fixed.forEach(function(f){
    const g=(byKey[f.key]||[]).slice().sort(function(a,b){ return a.posted-b.posted; });
    if(!g.length)return;
    const first=g[0].posted*1000, last=g[g.length-1];
    const months=Math.max(1,Math.round((last.posted*1000-first)/(30.44*INS_DAY))+1);
    if(selfCharging.test(f.key+' '+f.name)||(f.monthly<60&&!loanish.test(f.key+' '+f.name)))subs.push({key:f.key,name:f.name,monthly:insRound(f.monthly),last:last.posted*1000,since:first,months:months});
    if(g.length>=2){
      const prev=-g[g.length-2].amount, now2=-last.amount;
      // a real change, not cents of tax or currency: over 50 cents and 2%
      if(Math.abs(now2-prev)>0.5&&Math.abs(now2-prev)>prev*0.02&&now-last.posted*1000<70*INS_DAY)raised.push({name:f.name,from:insRound(prev),to:insRound(now2),when:last.posted*1000});
    }
  });
  // a trial that turned paid: a first charge of $5 or less, then one at least 3 times it (and $5+) 3 to 35 days
  // later, in the last 60 days. 3 days apart at least, so a card check or a gas pump hold isn't one
  const trials=[], trialKey={};
  Object.keys(byKey).forEach(function(k){
    const g=byKey[k].slice().sort(function(a,b){ return a.posted-b.posted; });
    const a=g[0];
    if(-a.amount>5||c.kindOf(a)==='skip'||fc.notSpending.test(insText(a)))return;
    const b=g.find(function(t){ const gap=(t.posted-a.posted)*1000; return -t.amount>=Math.max(5,-a.amount*3)&&gap>=3*INS_DAY&&gap<=35*INS_DAY; });
    if(!b||now-b.posted*1000>60*INS_DAY)return;
    trialKey[k]=1;
    trials.push({key:k,name:a.description||k,first:insRound(-a.amount),firstWhen:a.posted*1000,then:insRound(-b.amount),thenWhen:b.posted*1000});
  });
  // started lately: a payee's very first charge in the last 40 days, that looks like a subscription
  if(now-earliest>60*INS_DAY)Object.keys(byKey).forEach(function(k){
    if(trialKey[k])return; // already said above
    const g=byKey[k].slice().sort(function(a,b){ return a.posted-b.posted; });
    const first=g[0];
    if(now-first.posted*1000>40*INS_DAY||c.kindOf(first)==='skip')return;
    const looksLike=c.kindOf(first)==='fixed'||/\b(trial|subscription|subscr|membership)\b/i.test(insText(first));
    if(looksLike)fresh.push({key:k,name:first.description||k,amount:insRound(-first.amount),when:first.posted*1000});
  });
  subs.sort(function(a,b){ return b.monthly-a.monthly; });
  return {subs:subs,total:insRound(subs.reduce(function(s,x){ return s+x.monthly; },0)),raised:raised,fresh:fresh,trials:trials};
}

/* where to stop a subscription: the company's own cancel or membership page when it's one we know, otherwise a
   web search for its cancel steps (only the payee's name goes in the search: no amounts, no accounts) →
   {url, known} */
const INS_CANCEL=[
  [/\bnetflix\b/i,'https://www.netflix.com/cancelplan'],
  [/\bspotify\b/i,'https://www.spotify.com/account/subscription/'],
  [/\bhulu\b/i,'https://secure.hulu.com/account'],
  [/\bdisney ?(plus|\+)/i,'https://www.disneyplus.com/account'],
  [/\byoutube|google \*?youtube/i,'https://www.youtube.com/paid_memberships'],
  [/\bgoogle \*?(one|storage|play)\b/i,'https://play.google.com/store/account/subscriptions'],
  [/\bapple\.com\/bill|\bapple (music|tv|one|icloud)\b|\bicloud\b/i,'https://apps.apple.com/account/subscriptions'],
  [/\b(amazon|amzn) ?prime|\bprime video\b|\bprime membership\b/i,'https://www.amazon.com/mc'],
  [/\baudible\b/i,'https://www.audible.com/account/overview'],
  [/\bopenai\b|\bchatgpt\b/i,'https://chatgpt.com/#settings/Account'],
  [/\banthropic\b|\bclaude\.ai\b/i,'https://claude.ai/settings/billing'],
  [/\bmicrosoft\b|\bmsft\b|\bxbox\b/i,'https://account.microsoft.com/services'],
  [/\badobe\b/i,'https://account.adobe.com/plans'],
  [/\bdropbox\b/i,'https://www.dropbox.com/account/plan'],
  [/\bpatreon\b/i,'https://www.patreon.com/settings/memberships'],
  [/\bwalmart ?(\+|plus)/i,'https://www.walmart.com/plus/account'],
  [/\bgithub\b/i,'https://github.com/settings/billing'],
  [/\bsupabase\b/i,'https://supabase.com/dashboard/org/_/billing'],
  [/\bcloudflare\b/i,'https://dash.cloudflare.com/?to=/:account/billing/subscriptions']
];
function cancelName(name){
  return String(name||'').replace(/^\s*(paypal|pp|sq|tst|sp)\s*\*\s*/i,'').replace(/\*(?=[a-z]*\d)[a-z0-9]{4,}\b/gi,' ').replace(/\*/g,' ').replace(/#\s*\d+/g,' ')
    .replace(/\b\d[\d-]{3,}\b/g,' ').replace(/\s+/g,' ').trim();
}
function cancelPage(name){
  const s=String(name||'');
  for(let i=0;i<INS_CANCEL.length;i++)if(INS_CANCEL[i][0].test(s))return {url:INS_CANCEL[i][1],known:true};
  return {url:'https://duckduckgo.com/?q='+encodeURIComponent((cancelName(s)||s)+' cancel subscription'),known:false};
}
/* discounts for who he is, on what he already pays for. `who` is {student, ebt} (finance.js finWho works it
   out from what's already here: tuition paid, a School list, his notes about himself, EBT on). Prices are the
   usual US ones and may have moved: the page it links to has today's. price null: it varies or it's through
   the school, so there's no saving to work out */
const INS_TUITION=/\b(tuition|bursar|college|university|univ|flywire|student acc(oun)?t)\b/i;
const INS_DEALS=[
  {id:'prime-student',who:'student',re:/\b(amazon|amzn) ?prime\b|\bprime (video|membership)\b/i,program:'Prime for Young Adults (students and ages 18 to 24)',price:7.49,url:'https://www.amazon.com/joinstudent'},
  {id:'prime-access',who:'ebt',re:/\b(amazon|amzn) ?prime\b|\bprime (video|membership)\b/i,program:'Prime Access (for people on EBT or Medicaid)',price:6.99,url:'https://www.amazon.com/qualify'},
  {id:'spotify-student',who:'student',re:/\bspotify\b/i,program:'Spotify Premium Student',price:5.99,url:'https://www.spotify.com/us/student/'},
  {id:'youtube-student',who:'student',re:/\byoutube\b/i,program:'YouTube Premium Student',price:7.99,url:'https://www.youtube.com/premium/student'},
  {id:'hulu-student',who:'student',re:/\bhulu\b/i,program:'Hulu for students',price:1.99,url:'https://www.hulu.com/student'},
  {id:'adobe-student',who:'student',re:/\badobe\b/i,program:'Adobe Creative Cloud for students',price:null,url:'https://www.adobe.com/creativecloud/buy/students.html'},
  {id:'ms365-student',who:'student',re:/\bmicrosoft\b|\bmsft\b/i,program:'Microsoft 365 through your school (often free)',price:null,url:'https://www.microsoft.com/en-us/education/products/microsoft-365'},
  {id:'github-student',who:'student',re:/\bgithub\b/i,program:'GitHub Student Developer Pack (free)',price:null,url:'https://education.github.com/pack'},
  {id:'walmart-assist',who:'ebt',re:/\bwalmart ?(\+|plus)\b|\bwmt plus\b/i,program:'Walmart+ Assist (half price on EBT)',price:6.47,url:'https://www.walmart.com/plus/assist'}
];
// tuition or a college paid in the last year: a sign he's a student
function paysTuition(txs,now){
  now=now||Date.now();
  return (txs||[]).some(function(t){ return t&&t.amount<0&&now-insMs(t)<365*INS_DAY&&INS_TUITION.test(insText(t)); });
}
/* → [{id, who, program, name (the payee), pays (the last charge), price, saveYear (null when unknown), url}]
   biggest saving first. Only payees charged in the last 75 days, and not when he already pays the deal's price */
function discountCheck(txs,who,now){
  now=now||Date.now(); who=who||{};
  const fc=insCosts(), last={};
  (txs||[]).forEach(function(t){
    if(!t||!(t.amount<0)||now-insMs(t)>75*INS_DAY||fc.notSpending.test(insText(t)))return;
    const k=fc.costKey(t); if(!last[k]||insMs(t)>insMs(last[k]))last[k]=t;
  });
  const out=[], took={};
  INS_DEALS.forEach(function(d){
    if(!who[d.who])return;
    Object.keys(last).forEach(function(k){
      const t=last[k];
      if(took[d.id]||!d.re.test(k+' '+insText(t)))return;
      const pays=insRound(-t.amount);
      if(d.price!=null&&pays<=d.price+0.5)return; // already on it, or close enough
      took[d.id]=1;
      out.push({id:d.id,who:d.who,program:d.program,name:cancelName(t.description||k),pays:pays,price:d.price,
        saveYear:d.price!=null?Math.round((pays-d.price)*12):null,url:d.url});
    });
  });
  // one Prime deal, not both: the cheaper one
  const p=out.filter(function(x){ return /^prime-/.test(x.id); });
  if(p.length>1){ const keep=p.sort(function(a,b){ return a.price-b.price; })[0]; return out.filter(function(x){ return !/^prime-/.test(x.id)||x===keep; }).sort(insBySave); }
  return out.sort(insBySave);
}
function insBySave(a,b){ return (b.saveYear||0)-(a.saveYear||0); }

/* a new or trial subscription as a to-do on the Human list: the name and day only, no amount */
function newSubTitle(o){
  const when=new Date(o.thenWhen||o.when).toLocaleDateString(undefined,{month:'short',day:'numeric'});
  return o.thenWhen?'Check '+cancelName(o.name)+': a trial that turned paid on '+when
    :'Check a new subscription from '+cancelName(o.name)+' (started '+when+')';
}

/* charges worth a second look, from the last `days` days (pending ones too) →
   [{id, kind: 'double' | 'new-big' | 'foreign', name, amount, when, account}] newest first */
function oddCharges(accounts,kinds,now,days){
  now=now||Date.now(); days=days||7;
  const fc=insCosts();
  const all=[];
  (accounts||[]).forEach(function(a){ (a.transactions||[]).forEach(function(t){ if(t&&t.amount<0)all.push({t:t,a:a,k:fc.costKey(t),ms:insMs(t)}); }); });
  const firstSeen={};
  all.forEach(function(x){ if(!(x.k in firstSeen)||x.ms<firstSeen[x.k])firstSeen[x.k]=x.ms; });
  const recent=all.filter(function(x){ return x.ms>=now-days*INS_DAY; });
  const earliest=all.reduce(function(m,x){ return Math.min(m,x.ms); },now);
  const out=[], flagged={};
  const add=function(x,kind,twin){ if(flagged[x.t.id])return; flagged[x.t.id]=1; if(twin)flagged[twin.t.id]=1; out.push({id:x.t.id,kind:kind,name:x.t.description||x.k,amount:insRound(-x.t.amount),when:x.ms,account:x.a.name}); };
  recent.forEach(function(x){
    const text=insText(x.t);
    if(fc.notSpending.test(text))return; // transfers and card payments
    if(INS_FOREIGN.test(text))return add(x,'foreign');
    // the same payee, account and amount twice within a day; a pending one beside a posted one is usually the same charge
    const twin=all.find(function(y){ return y.t.id!==x.t.id&&y.a===x.a&&y.k===x.k&&y.t.amount===x.t.amount&&Math.abs(y.ms-x.ms)<=INS_DAY&&!!y.t.pending===!!x.t.pending; });
    if(twin&&x.t.amount<=-5)return add(x,'double',twin);
    // $100+ from a payee never paid before (with a month of history before it to know)
    if(x.t.amount<=-100&&firstSeen[x.k]===x.ms&&x.ms-earliest>30*INS_DAY)add(x,'new-big');
  });
  return out.sort(function(a,b){ return b.when-a.when; });
}
// the Human list's to-do for one: no amount, just enough to find it
function oddTitle(o){
  const when=new Date(o.when).toLocaleDateString(undefined,{month:'short',day:'numeric'});
  return o.kind==='double'?'Check a possible double charge from '+o.name+' on '+when
    :o.kind==='foreign'?'Check a foreign transaction fee on '+when+' ('+o.name+')'
    :'Check a new $100+ charge from '+o.name+' on '+when;
}

/* the stock rows (finance-core.js stocksView, with type/sector/industry) → {total, sectors, industries,
   holdings, types}: each [{name, value, pct}] biggest first. A fund counts under "Funds" for sectors */
function portfolioMix(rows){
  const total=(rows||[]).reduce(function(s,r){ return s+(r.value||0); },0);
  const group=function(by){
    const m={};
    (rows||[]).forEach(function(r){ if(!(r.value>0))return; const k=by(r); m[k]=(m[k]||0)+r.value; });
    return Object.keys(m).map(function(k){ return {name:k,value:insRound(m[k]),pct:total?m[k]/total*100:0}; }).sort(function(a,b){ return b.value-a.value; });
  };
  const fund=function(r){ return r.type&&r.type!=='Stock'; };
  return {total:insRound(total),
    sectors:group(function(r){ return r.sector||(fund(r)?'Funds ('+r.type+')':'Unknown'); }),
    industries:group(function(r){ return r.industry||(fund(r)?'Funds ('+r.type+')':'Unknown'); }),
    holdings:group(function(r){ return r.symbol||r.name||'?'; }),
    types:group(function(r){ return r.type||'Unknown'; })};
}

/* every holding as a .csv (Excel, Numbers, Google Sheets), biggest first, with plain numbers so the sheet can
   add them up. rows: [{r: a stocksView row, pct: its move over the chart's window}]; short: that window ('6M') */
function stocksCsv(rows,short,cur){
  const cell=function(v){
    if(v==null||v==='')return '';
    if(typeof v==='number')return isFinite(v)?String(Math.round(v*10000)/10000):'';
    let t=String(v); if(/^[=+\-@\t\r]/.test(t))t="'"+t; // a name starting with = isn't a formula
    return /[",\n\r]/.test(t)?'"'+t.replace(/"/g,'""')+'"':t;
  };
  const head=['Symbol','Name','Type','Sector','Industry','Shares','Price ('+cur+')','Today %',short+' %','Value ('+cur+')','Cost ('+cur+')','Gain ('+cur+')'];
  const lines=[head.map(cell).join(',')];
  rows.slice().sort(function(a,b){ return b.r.value-a.r.value; }).forEach(function(x){
    const r=x.r;
    lines.push([r.symbol,r.name,r.type,r.sector,r.industry,r.shares,r.price,r.live?r.changePct:null,x.pct,r.value,r.cost,r.gain].map(cell).join(','));
  });
  return lines.join('\r\n')+'\r\n';
}

if(typeof module!=='undefined'&&module.exports){ module.exports={debtPlan:debtPlan,subscriptionCheck:subscriptionCheck,oddCharges:oddCharges,oddTitle:oddTitle,cancelPage:cancelPage,cancelName:cancelName,newSubTitle:newSubTitle,paysTuition:paysTuition,discountCheck:discountCheck,portfolioMix:portfolioMix,stocksCsv:stocksCsv}; }
