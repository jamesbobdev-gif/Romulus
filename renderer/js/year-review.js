/* Year in review: the numbers behind the look back at a whole year (year-review-view.js draws them).
   Tasks: what he checked off (when: t.doneAt, set by setDone since 2026-11; older ones fall back to the last
   change, which for a done task is about when it was ticked), plus the ones he cleared away, kept in a small
   log (reviewLogCleared) so "clear" doesn't wipe them from the year. Agent: the answers in each Agent task's
   conversation, by who wrote them. Hours: the Hours tab's entries. Money: the Finance tab's own income
   statement (finance-statements.js) over the year's months, so transfers, card payments and brokerage moves
   don't count and refunds come off spending, exactly as on the tab; net worth at each end of the year is
   worked back from today's balances. Months before the oldest transaction kept have no money data.
   reviewSample(year) makes up a whole year of all of it, to see the review before January.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them.
   Also loaded by test/year-review.test.js, so it uses no page globals. */
'use strict';

const YR_STMT=typeof module!=='undefined'&&module.exports?require('./finance-statements'):{incomeStatement:incomeStatement,stmtBalanceAt:stmtBalanceAt,stmtIsInvest:stmtIsInvest};
const YR_COSTKEY=typeof module!=='undefined'&&module.exports?require('./finance-costs').costKey:costKey;
const YR_DAY=86400000;
const YR_MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const YR_LISTS=['personal','work','school','agent'];

// which year the review is for on this day: last year through January and February, else none
function reviewYearFor(now){ const d=new Date(now||Date.now()); return d.getMonth()<=1?d.getFullYear()-1:null; }
function yrDayKey(ms){ const d=new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function yrIn(ms,year){ return !!ms&&new Date(ms).getFullYear()===year; }
function yrWs(t){ return YR_LISTS.indexOf(t&&t.ws)!==-1?t.ws:'personal'; }
// when a done task was checked off
function yrDoneAt(t){ return t.doneAt||t.updatedAt||t.created||0; }
function yrTop(counts,n){
  return Object.keys(counts).map(function(k){ return {name:k,count:counts[k]}; })
    .sort(function(a,b){ return b.count-a.count||(a.name<b.name?-1:1); }).slice(0,n);
}
// a payee's name as the cost charts group it, in title case: "TRADER JOE'S #552" → "Trader Joe's"
function yrPlace(t){ return YR_COSTKEY(t).replace(/(^|\s)[a-z]/g,function(c){ return c.toUpperCase(); }); }
function yrMaxAt(list){ let best=-1; list.forEach(function(v,i){ if(v>0&&(best<0||v>list[best]))best=i; }); return best; }

/* a cleared task, as the log keeps it: {id, at (checked off), ws, tag, title, due, runs: [[at, who]]} */
function reviewLogEntry(t){
  const e={id:t.id,at:yrDoneAt(t),ws:yrWs(t),tag:t.tag||null,title:String(t.title||'').slice(0,120)};
  if(t.due)e.due=t.due;
  const runs=yrRuns(t);
  if(runs.length)e.runs=runs;
  return e;
}
// the log after clearing these tasks: theirs added, anything from before last year dropped
function reviewLogAdd(log,tasks,now){
  const keepFrom=new Date(now||Date.now()).getFullYear()-1;
  const have={}; (log||[]).forEach(function(e){ have[e.id]=1; });
  return (log||[]).concat((tasks||[]).filter(function(t){ return t&&t.done&&!have[t.id]; }).map(reviewLogEntry))
    .filter(function(e){ return new Date(e.at).getFullYear()>=keepFrom; });
}
// an Agent task's answers: [[at, who]] — who is 'local' (his own model) or the cloud that wrote it
function yrRuns(t){
  if(!Array.isArray(t.history))return [];
  return t.history.filter(function(h){ return h&&h.who==='claude'&&h.at; }).map(function(h){ return [h.at,h.lane==='local'?'local':h.via||'claude']; });
}
// tasks still in the list and cleared ones from the log, one each
function yrAll(tasks,log){
  const seen={}, out=[];
  (tasks||[]).forEach(function(t){ if(t&&t.id){ seen[t.id]=1; out.push({id:t.id,done:!!t.done,at:t.done?yrDoneAt(t):0,ws:yrWs(t),tag:t.tag||null,title:t.title||'',due:t.due||null,runs:yrRuns(t),suggested:t.status==='suggested'}); } });
  (log||[]).forEach(function(e){ if(e&&e.id&&!seen[e.id]){ seen[e.id]=1; out.push({id:e.id,done:true,at:e.at||0,ws:yrWs(e),tag:e.tag||null,title:e.title||'',due:e.due||null,runs:Array.isArray(e.runs)?e.runs:[]}); } });
  return out;
}

/* → { total, byList {personal, work, school, agent}, byMonth [12], byWeekday [7] (Sunday first), busiestMonth,
       bestDay {day, count}, streak {days, from, to}, activeDays, topTags [{name, count}], lastYear, dated } */
function tasksYear(tasks,log,year){
  const all=yrAll(tasks,log);
  const done=all.filter(function(t){ return t.done&&yrIn(t.at,year); });
  const byList={personal:0,work:0,school:0,agent:0}, byMonth=new Array(12).fill(0), byWeekday=new Array(7).fill(0), days={}, tags={};
  done.forEach(function(t){
    const d=new Date(t.at);
    byList[t.ws]++; byMonth[d.getMonth()]++; byWeekday[d.getDay()]++;
    const k=yrDayKey(t.at); days[k]=(days[k]||0)+1;
    if(t.tag)tags[t.tag]=(tags[t.tag]||0)+1;
  });
  const keys=Object.keys(days).sort();
  let bestDay=null, streak={days:0,from:null,to:null}, run=0, runFrom=null, prev=null;
  keys.forEach(function(k){
    if(!bestDay||days[k]>bestDay.count)bestDay={day:k,count:days[k]};
    const p=k.split('-').map(Number), at=new Date(p[0],p[1]-1,p[2]).getTime();
    run=prev!=null&&Math.round((at-prev)/YR_DAY)===1?run+1:1; if(run===1)runFrom=k;
    if(run>streak.days)streak={days:run,from:runFrom,to:k};
    prev=at;
  });
  const dated=new Array(12).fill(0);
  all.forEach(function(t){ if(t.due&&!t.suggested&&+t.due.slice(0,4)===year)dated[+t.due.slice(5,7)-1]++; });
  return {total:done.length,byList:byList,byMonth:byMonth,byWeekday:byWeekday,busiestMonth:yrMaxAt(byMonth),bestDay:bestDay,streak:streak,
    activeDays:keys.length,topTags:yrTop(tags,5),lastYear:all.filter(function(t){ return t.done&&yrIn(t.at,year-1); }).length,
    dated:{total:dated.reduce(function(s,v){ return s+v; },0),byMonth:dated,busiestMonth:yrMaxAt(dated)}};
}

/* → { answers, tasks (that got at least one answer), finished (Agent tasks he checked off), byWho [{name, count}],
       local (answers his own model wrote), byMonth [12], busiestMonth, longest {title, count} } */
function agentYear(tasks,log,year){
  const all=yrAll(tasks,log).filter(function(t){ return t.ws==='agent'; });
  const byWho={}, byMonth=new Array(12).fill(0);
  let answers=0, touched=0, local=0, longest=null;
  all.forEach(function(t){
    const runs=t.runs.filter(function(r){ return yrIn(r[0],year); });
    if(!runs.length)return;
    touched++; answers+=runs.length;
    runs.forEach(function(r){ byWho[r[1]]=(byWho[r[1]]||0)+1; byMonth[new Date(r[0]).getMonth()]++; if(r[1]==='local')local++; });
    if(!longest||runs.length>longest.count)longest={title:t.title,count:runs.length};
  });
  return {answers:answers,tasks:touched,finished:all.filter(function(t){ return t.done&&yrIn(t.at,year); }).length,
    byWho:yrTop(byWho,8),local:local,byMonth:byMonth,busiestMonth:yrMaxAt(byMonth),longest:longest&&longest.count>1?longest:null};
}

/* the Hours tab: → { total, byKind {school, work}, byMonth [12], busiestMonth, days } */
function hoursYear(entries,year){
  const byKind={school:0,work:0}, byMonth=new Array(12).fill(0), days={};
  (entries||[]).forEach(function(e){
    if(!e||!/^\d{4}-\d{2}-\d{2}$/.test(e.date)||+e.date.slice(0,4)!==year||!(+e.hours>0))return;
    byKind[e.kind==='school'?'school':'work']+=+e.hours; byMonth[+e.date.slice(5,7)-1]+=+e.hours; days[e.date]=1;
  });
  const r=function(v){ return Math.round(v*10)/10; };
  return {total:r(byKind.school+byKind.work),byKind:{school:r(byKind.school),work:r(byKind.work)},byMonth:byMonth.map(r),busiestMonth:yrMaxAt(byMonth),days:Object.keys(days).length};
}

/* Finance: accounts as the tab has them, his payee marks, the year, today.
   → null when the year hasn't started, else { months: [{label, in, out, net, noData}], partial (the year isn't over),
     from (first day with data, ms), in, out, net, savingsRate, bestMonth, priciestMonth (indexes), fixed, variable,
     refunds, places [{name, total}] (variable, biggest first), bills [{name, total}] (fixed), purchases (how many),
     biggest {name, amount, at} (one-off purchase, not a bill), worth {startAt, start, end, change, cash, invest, debts} (null without accounts) } */
function moneyYear(accounts,kinds,year,now){
  now=now||Date.now();
  const yearEnd=new Date(year+1,0,1).getTime()-1;
  if(now<new Date(year,0,1).getTime())return null;
  const end=Math.min(now,yearEnd), endMonth=new Date(end).getMonth();
  // the income statement's columns: the whole months before `end`'s, then `end`'s own; it needs at least one before
  const s=YR_STMT.incomeStatement(accounts,kinds,end,Math.max(1,endMonth));
  const skip=s.cols.length-(endMonth+1);
  const pick=function(l){ return l.slice(skip); };
  let oldest=Infinity;
  (accounts||[]).forEach(function(a){ (a.transactions||[]).forEach(function(t){ if(t&&t.posted&&!t.pending&&t.posted*1000<oldest)oldest=t.posted*1000; }); });
  const from=Math.max(new Date(year,0,1).getTime(),oldest===Infinity?end:oldest);
  const firstMonth=new Date(from).getFullYear()>year?12:new Date(from).getMonth();
  const inc=pick(s.incomeTotal), out=pick(s.expenseTotal);
  const months=inc.map(function(v,i){ return {label:YR_MONTHS[i],in:v,out:out[i],net:v-out[i],noData:i<firstMonth}; });
  const sum=function(l){ return l.reduce(function(t,v){ return t+v; },0); };
  const lineTotal=function(r){ return sum(pick(r.vals)); };
  const named=function(r){ const t=r.items[0]&&r.items[0].t; return t?yrPlace(t):r.name; };
  const realPlaces=s.variable.filter(function(r){ return r.name!=='Refunds and returns'&&!/^Everything else/.test(r.name); });
  const places=realPlaces.map(function(r){ return {name:named(r),total:lineTotal(r)}; }).filter(function(p){ return p.total>0; }).sort(function(a,b){ return b.total-a.total; }).slice(0,5);
  const bills=s.fixed.map(function(r){ return {name:named(r),total:lineTotal(r)}; }).filter(function(p){ return p.total>0; }).sort(function(a,b){ return b.total-a.total; }).slice(0,5);
  const refundLine=s.variable.filter(function(r){ return r.name==='Refunds and returns'; })[0];
  let biggest=null, purchases=0;
  s.variable.forEach(function(r){ if(r.name==='Refunds and returns')return; r.items.forEach(function(x){
    if(x.col<skip||!(x.t.amount<0))return;
    purchases++;
    if(!biggest||-x.t.amount>biggest.amount)biggest={name:yrPlace(x.t),amount:-x.t.amount,at:x.t.posted*1000};
  }); });
  const dataMonths=months.filter(function(m){ return !m.noData; });
  const best=function(f){ let b=-1; months.forEach(function(m,i){ if(!m.noData&&(b<0||f(m)>f(months[b])))b=i; }); return b; };
  const tIn=sum(inc), tOut=sum(out);
  // net worth at each end: every account's balance worked back from today's
  let worth=null;
  if((accounts||[]).length){
    const at=function(ms){
      const w={cash:0,invest:0,debts:0};
      accounts.forEach(function(a){ const b=ms>=now?Math.round((Number(a.balance)||0)*100)/100:YR_STMT.stmtBalanceAt(a,ms); if(b<0)w.debts-=b; else if(YR_STMT.stmtIsInvest(a))w.invest+=b; else w.cash+=b; });
      w.net=w.cash+w.invest-w.debts; return w;
    };
    const a=at(from-1), b=at(end); // before the first day's own transactions
    worth={startAt:from,endAt:end,start:a.net,end:b.net,change:b.net-a.net,cash:b.cash,invest:b.invest,debts:b.debts,investStart:a.invest};
  }
  return {months:months,partial:end<yearEnd,from:from,in:tIn,out:tOut,net:tIn-tOut,savingsRate:tIn>0?(tIn-tOut)/tIn:null,
    bestMonth:dataMonths.length?best(function(m){ return m.net; }):-1,priciestMonth:dataMonths.length?best(function(m){ return m.out; }):-1,
    fixed:sum(pick(s.fixedTotal)),variable:sum(pick(s.variableTotal)),refunds:refundLine?-lineTotal(refundLine):0,
    places:places,bills:bills,purchases:purchases,biggest:biggest,worth:worth};
}

/* a whole made-up year (for `year`, up to `now` when it's this year): tasks, cleared log, hours, bank accounts.
   Same seed, same year: always the same numbers. Nothing here is his. */
function reviewSample(year,now){
  let seed=year*7919;
  const rnd=function(){ seed=(seed*1103515245+12345)%2147483648; return seed/2147483648; };
  const pickOf=function(l){ return l[Math.floor(rnd()*l.length)]; };
  const stop=Math.min(now||Infinity,new Date(year+1,0,1).getTime()-1);
  const tasks=[], log=[], entries=[];
  const titles={personal:['Call the dentist','Pick up groceries','Renew car registration','Fix the leaky tap','Return library books','Water the plants','Book a haircut','Clean out the fridge'],
    work:['Send the weekly report','Prep slides for Monday','Review Sam’s draft','Update the roadmap','Reply to the client'],
    school:['Read chapter 7','Problem set 4','Study for the midterm','Lab write-up','Essay outline'],
    agent:['Find a cheaper phone plan','Compare flights to Denver','Order more printer ink','Summarize the lease','Track the package','Plan a weekend trip']};
  const tags={personal:['home','errands','health',null],work:['work',null],school:['bio','math','history'],agent:[null,'shopping']};
  const clouds=['claude','claude','claude','gemini','openai','local','local'];
  let n=0;
  for(let d=new Date(year,0,1);d.getTime()<=stop;d.setDate(d.getDate()+1)){
    const m=d.getMonth(), busy=[0.6,0.7,1.1,1,0.9,0.7,0.5,0.8,1.3,1.2,1,0.6][m]*(d.getDay()===0||d.getDay()===6?0.6:1.2);
    if(d.getMonth()===3&&d.getDate()>12&&d.getDate()<20)continue; // a week off
    const k=Math.floor(rnd()*4*busy);
    for(let i=0;i<k;i++){
      const ws=pickOf(['personal','personal','personal','work','work','school','agent']);
      const at=new Date(d.getFullYear(),d.getMonth(),d.getDate(),8+Math.floor(rnd()*13),Math.floor(rnd()*60)).getTime();
      if(at>stop)continue;
      const t={id:'s'+(n++),title:pickOf(titles[ws]),done:true,ws:ws,tag:pickOf(tags[ws]),created:at-YR_DAY*Math.floor(rnd()*6),doneAt:at,updatedAt:at};
      if(rnd()<0.3)t.due=yrDayKey(at);
      if(ws==='agent'){
        t.status='done'; t.history=[];
        const r=1+Math.floor(rnd()*4);
        for(let j=0;j<r;j++){
          const h={who:'claude',text:'…',at:at-3600000*(r-j)}, c=pickOf(clouds);
          if(c==='local')h.lane='local'; else if(c!=='claude')h.via=c;
          t.history.push({who:'you',text:'…',at:h.at-60000},h);
        }
      }
      if(rnd()<0.6)log.push(reviewLogEntry(t)); else tasks.push(t);
    }
    if(d.getDay()>=1&&d.getDay()<=5&&rnd()<0.55)entries.push({id:'h'+n++,date:yrDayKey(d.getTime()),kind:m>=5&&m<=7?'work':pickOf(['school','school','work']),hours:Math.round((2+rnd()*5)*2)/2});
  }
  // a still-open task with a date, so the calendar count has more than done ones
  tasks.push({id:'s'+(n++),title:'Dentist checkup',done:false,ws:'personal',due:year+'-12-12',created:new Date(year,10,1).getTime()});
  // money: pay twice a month, rent, bills, shopping, a card paid off, a brokerage with a dividend
  const sec=function(y,m,d){ return Math.floor(new Date(y,m,d,12).getTime()/1000); };
  const chk=[], card=[], brk=[];
  let id=0;
  const tx=function(list,desc,amount,posted){ if(posted*1000<=stop)list.push({id:'x'+(id++),description:desc,amount:Math.round(amount*100)/100,posted:posted}); };
  const places=[["Trader Joe's",60,140,6],['Shell Oil',30,55,3],['Corner Coffee',4,9,8],['Amazon Mktp',12,90,4],['Chipotle',11,18,3],['Target',20,120,2],['Home Depot',25,200,1]];
  for(let m=0;m<12;m++){
    tx(chk,'ACME CORP PAYROLL DIRECT DEP',2450,sec(year,m,1)); tx(chk,'ACME CORP PAYROLL DIRECT DEP',2450,sec(year,m,15));
    tx(chk,'Maple Apartments Rent',-1450,sec(year,m,2)); tx(chk,'Comcast Xfinity',-79.99,sec(year,m,6));
    tx(card,'Netflix.com',-15.49,sec(year,m,9)); tx(card,'Spotify USA',-11.99,sec(year,m,11)); tx(chk,'Geico Insurance',-132,sec(year,m,20));
    tx(chk,'City Electric Utility',-(60+rnd()*70),sec(year,m,18));
    let spent=0;
    places.forEach(function(p){ const k=Math.max(0,Math.round(p[3]*(0.6+rnd()*0.8))); for(let i=0;i<k;i++){ const a=p[1]+rnd()*(p[2]-p[1]); spent+=a; tx(card,p[0]+' #'+(100+Math.floor(rnd()*900)),-a,sec(year,m,1+Math.floor(rnd()*27))); } });
    if(m===10)tx(card,'Best Buy 0412',-899.99,sec(year,m,24)); // the TV
    if(m===2)tx(card,'Amazon Mktp refund',45.5,sec(year,m,20));
    tx(card,'Payment Thank You - Web',Math.round(spent+27.48),sec(year,m,26)); tx(chk,'Chase Card Payment Thank You',-Math.round(spent+27.48),sec(year,m,26));
    tx(chk,'Transfer to Brokerage',-400,sec(year,m,16)); tx(brk,'Transfer from Checking',400,sec(year,m,16));
    if(m%3===2)tx(brk,'Dividend received VTI',38.2,sec(year,m,28));
  }
  const accounts=[
    {id:'sc',name:'Everyday Checking',org:'Sample Bank',currency:'USD',balance:4820.15,transactions:chk},
    {id:'sv',name:'Rewards Visa',org:'Sample Bank',currency:'USD',balance:-612.4,transactions:card},
    {id:'sb',name:'Individual Brokerage',org:'Sample Invest',currency:'USD',balance:15340,holdings:[{symbol:'VTI'}],transactions:brk}];
  return {tasks:tasks,log:log,hours:entries,accounts:accounts,kinds:{}};
}

if(typeof module!=='undefined'&&module.exports){ module.exports={reviewYearFor:reviewYearFor,tasksYear:tasksYear,agentYear:agentYear,hoursYear:hoursYear,moneyYear:moneyYear,reviewLogAdd:reviewLogAdd,reviewLogEntry:reviewLogEntry,reviewSample:reviewSample}; }
