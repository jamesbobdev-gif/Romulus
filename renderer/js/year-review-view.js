/* Year in review: a page that looks back on a whole year (the numbers come from year-review.js).
   It opens like Settings, in place of the lists: a few cards, each led by one big number (the way Spotify
   Wrapped, GitHub's year in review and the budgeting apps' recaps lead with one), then a chart and a few lines.
   Shown from January 1 through February (a card at the top of the To do list until he opens it or says not now),
   any time from Settings → Year in review (the year so far), and with made-up data there to see it early.
   Money: only with Finance unlocked, and then hidden from screenshots like the Finance tab itself
   (finApi.financeScreen); the bank data is dropped again when the page closes or Finance locks.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

const yr={ open:false, year:null, sample:null, screen:false, moneyHost:null };
const YR_LOG_KEY='review.cleared';
const YR_MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];
const YR_DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const YR_LIST_NAMES={personal:'To do',work:'Work',school:'School',agent:'Agent'};

// the cleared done tasks the year still counts (wiring.js calls this when he clears them)
function reviewLog(){ try{ return JSON.parse(localStorage.getItem(YR_LOG_KEY))||[]; }catch(e){ return []; } }
function reviewLogCleared(tasks){ try{ localStorage.setItem(YR_LOG_KEY,JSON.stringify(reviewLogAdd(reviewLog(),tasks,Date.now()))); }catch(e){} }

function yrNum(n){ return Math.round(n).toLocaleString(); }
function yrPlural(n,one,many){ return yrNum(n)+' '+(Math.round(n)===1?one:many||one+'s'); }
function yrDayText(key){ const p=key.split('-').map(Number); return new Date(p[0],p[1]-1,p[2]).toLocaleDateString(undefined,{month:'short',day:'numeric'}); }
function yrCard(eyebrow,big,line){
  const c=el('section','fin-card yr-card');
  c.appendChild(el('div','mono fin-label',eyebrow));
  if(big!=null)c.appendChild(el('div','yr-big',big));
  if(line)c.appendChild(el('p','yr-line',line));
  return c;
}
// twelve month columns; the top one is labeled and stronger
function yrMonthCols(vals,fmt,color,title){
  const top=Math.max.apply(null,vals.concat([1])), peak=vals.indexOf(Math.max.apply(null,vals));
  const cols=el('div','fin-cols yr-cols');
  vals.forEach(function(v,i){
    const col=el('div','fin-col'+(i===peak&&v>0?' yr-peak':''));
    col.title=YR_MONTH_NAMES[i]+': '+(title?title(v):fmt(v));
    const plot=el('div','fin-col-plot');
    const b=el('span','fin-col-fill'); b.style.height=(v>0?Math.max(2,v/top*100):0)+'%'; if(color)b.style.background=color;
    if(i===peak&&v>0)b.appendChild(el('span','fin-col-val yr-val',fmt(v))); // above the bar, not taking its height
    plot.appendChild(b); col.appendChild(plot);
    col.appendChild(el('span','mono fin-col-label',YR_MONTH_NAMES[i].slice(0,1)));
    cols.appendChild(col);
  });
  return cols;
}
function yrBars(rows,fmt,color){
  const box=el('div','yr-bars');
  const top=Math.max.apply(null,rows.map(function(r){ return r.value; }).concat([1]));
  rows.forEach(function(r){
    const row=el('div','fin-hbar'); row.title=r.name+': '+fmt(r.value);
    row.appendChild(el('span','fin-hbar-name',r.name));
    const track=el('span','fin-hbar-track'), b=el('span','fin-hbar-fill');
    b.style.width=Math.max(2,r.value/top*100)+'%'; if(r.color||color)b.style.background=r.color||color;
    track.appendChild(b); row.appendChild(track);
    row.appendChild(el('span','fin-amt',fmt(r.value)));
    box.appendChild(row);
  });
  return box;
}
function yrFacts(list){
  const ul=el('ul','yr-facts');
  list.filter(Boolean).forEach(function(f){ const li=el('li'); li.appendChild(el('span','mono fin-label',f[0])); li.appendChild(el('b',null,f[1])); ul.appendChild(li); });
  return ul;
}
function yrWho(k){ return k==='local'?'Your own model':k==='claude'?'Claude':(typeof CLOUD_NAMES!=='undefined'&&CLOUD_NAMES[k])||k; }

function openReview(opts){
  opts=opts||{};
  const now=Date.now();
  yr.year=opts.year||reviewYearFor(now)||new Date(now).getFullYear();
  yr.sample=opts.sample?reviewSample(yr.year,now):null;
  yr.open=true;
  if(typeof setSettingsOpen==='function')setSettingsOpen(false);
  try{ localStorage.setItem('review.seen.'+yr.year,'1'); }catch(e){}
  reviewBannerCheck();
  document.body.classList.add('review-open');
  $('reviewPanel').hidden=false;
  drawReview();
  window.scrollTo(0,0);
}
function closeReview(){
  if(!yr.open)return;
  yr.open=false; yr.sample=null; yr.moneyHost=null;
  yrScreenOff();
  $('reviewPanel').hidden=true; $('reviewPanel').textContent='';
  document.body.classList.remove('review-open');
}
function yrScreenOff(){
  // the Finance tab keeps its own screen protection; anywhere else it goes back off with the bank data
  if(yr.screen&&finApi&&finApi.financeScreen&&state.activeTab!=='finance'&&!fin.screen)finApi.financeScreen(false);
  yr.screen=false;
}

function drawReview(){
  const p=$('reviewPanel'); p.textContent='';
  const now=Date.now(), y=yr.year, s=yr.sample;
  const tasks=s?s.tasks:state.tasks, log=s?s.log:reviewLog(), hours=s?s.hours:state.hours.entries;
  const soFar=new Date(now).getFullYear()===y;

  const head=el('div','settings-head yr-head');
  const back=el('button','settings-back','← Back'); back.addEventListener('click',closeReview);
  head.appendChild(back);
  const h=el('h2',null,y+(soFar?' so far':' in review')); head.appendChild(h);
  if(s)head.appendChild(el('span','chip yr-sample','made-up data'));
  p.appendChild(head);

  const t=tasksYear(tasks,log,y), a=agentYear(tasks,log,y), hr=hoursYear(hours,y);
  // 1. the headline: everything checked off
  const hero=yrCard(soFar?'Jan 1 to today':'January 1 to December 31',yrNum(t.total),t.total===1?'thing done':'things done');
  hero.classList.add('yr-hero');
  const bits=[];
  if(t.activeDays)bits.push('on '+yrPlural(t.activeDays,'day'));
  if(t.streak.days>1)bits.push('a '+t.streak.days+'-day streak at best ('+yrDayText(t.streak.from)+' to '+yrDayText(t.streak.to)+')');
  if(t.lastYear&&!soFar){ const ch=Math.round((t.total-t.lastYear)/t.lastYear*100); bits.push(ch===0?'the same as '+(y-1):(ch>0?'up ':'down ')+Math.abs(ch)+'% on '+(y-1)); }
  if(bits.length)hero.appendChild(el('p','yr-line',bits.join(' · ')));
  if(!t.total)hero.appendChild(el('p','fin-note','Nothing checked off yet this year. Ticked tasks count from the day you tick them.'));
  p.appendChild(hero);

  // 2. when: by month, the weekday, the biggest day, what had a date
  if(t.total){
    const when=yrCard('When',t.busiestMonth>=0?YR_MONTH_NAMES[t.busiestMonth]:'', 'was your busiest month, with '+yrPlural(t.byMonth[t.busiestMonth]||0,'thing')+' done.');
    when.appendChild(yrMonthCols(t.byMonth,function(v){ return yrNum(v); }));
    const wd=t.byWeekday.indexOf(Math.max.apply(null,t.byWeekday));
    when.appendChild(yrFacts([
      ['best weekday',YR_DAYS[wd]+'s'],
      t.bestDay&&['biggest day',yrDayText(t.bestDay.day)+': '+t.bestDay.count+' done'],
      t.dated.total&&['on the calendar',yrPlural(t.dated.total,'thing')+' with a date'+(t.dated.busiestMonth>=0?', most in '+YR_MONTH_NAMES[t.dated.busiestMonth]:'')]
    ]));
    p.appendChild(when);

    // 3. where: which lists, which tags
    const lists=YR_LISTS.filter(function(k){ return t.byList[k]; }).map(function(k){ return {name:YR_LIST_NAMES[k],value:t.byList[k]}; }).sort(function(x,z){ return z.value-x.value; });
    const where=yrCard('Where',lists[0]?lists[0].name:'',lists[0]?'got the most done: '+Math.round(lists[0].value/t.total*100)+'% of it.':'');
    where.appendChild(yrBars(lists,yrNum));
    if(t.topTags.length){
      const tags=el('div','yr-tags'); tags.appendChild(el('span','mono fin-label','top tags'));
      t.topTags.forEach(function(g){ tags.appendChild(el('span','chip','#'+g.name+' · '+g.count)); });
      where.appendChild(tags);
    }
    p.appendChild(where);
  }

  // 4. the Agent
  if(a.answers){
    const ag=yrCard('The Agent',yrNum(a.answers),(a.answers===1?'answer':'answers')+' on '+yrPlural(a.tasks,'task')+(a.finished?', '+yrNum(a.finished)+' of them checked off':'')+'.');
    ag.appendChild(yrBars(a.byWho.map(function(w){ return {name:yrWho(w.name),value:w.count,color:w.name==='local'?FIN_DEBT:null}; }),yrNum));
    ag.appendChild(yrFacts([
      a.local&&['stayed on your computers',Math.round(a.local/a.answers*100)+'% (your own model wrote them)'],
      a.busiestMonth>=0&&['busiest month',YR_MONTH_NAMES[a.busiestMonth]+', '+yrPlural(a.byMonth[a.busiestMonth],'answer')],
      a.longest&&['longest back-and-forth',a.longest.title+' ('+a.longest.count+' answers)']
    ]));
    p.appendChild(ag);
  }

  // 5. hours
  if(hr.total){
    const hc=yrCard('Hours',yrNum(hr.total),'hours logged on '+yrPlural(hr.days,'day')+'.');
    hc.appendChild(yrMonthCols(hr.byMonth,function(v){ return yrNum(v)+' h'; }));
    hc.appendChild(yrBars([{name:'School',value:hr.byKind.school},{name:'Work',value:hr.byKind.work}].filter(function(r){ return r.value; }),function(v){ return yrNum(v)+' h'; }));
    p.appendChild(hc);
  }

  // 6. money
  const money=el('div','yr-money'); yr.moneyHost=money; p.appendChild(money);
  if(s)yrDrawMoney(money,s.accounts,s.kinds,'USD');
  else yrMoneyGate(money);

  const end=el('section','yr-end');
  end.appendChild(el('b',null,soFar?'That’s '+y+' so far.':'That was '+y+'.'));
  end.appendChild(el('p','fin-note',soFar?'The full look back opens on January 1.':'See you at the end of '+(y+1)+'.'));
  p.appendChild(end);
}

// real bank data: only with Finance unlocked, and hidden from screenshots while it's on screen
async function yrMoneyGate(host){
  host.textContent='';
  if(!finApi)return;
  if(fin.data&&fin.data.accounts&&fin.data.accounts.length)return yrDrawMoney(host,fin.data.accounts,fin.data.kinds,fin.data.accounts[0].currency);
  let set=null; try{ set=await finApi.financeStatus(); }catch(e){}
  if(!set||!set.setUp||!yr.open||yr.moneyHost!==host)return; // no Finance here: no money card
  const c=yrCard('Money',null,'Your income, spending and net worth for the year, from the Finance tab.');
  const go=el('button','btn-accent yr-money-go','Show my money year'); c.appendChild(go);
  const msg=el('p','fin-note'); msg.hidden=true; c.appendChild(msg);
  host.appendChild(c);
  let locked=false;
  go.addEventListener('click',async function(){
    if(locked){ fin.reviewAfterUnlock=yr.year; closeReview(); switchTab('finance'); return; }
    go.disabled=true;
    let st=null; try{ st=await finApi.financeStatus(); }catch(e){}
    if(!yr.open||yr.moneyHost!==host)return;
    go.disabled=false;
    if(!st||!st.setUp){ msg.hidden=false; msg.textContent='Finance isn’t set up yet.'; go.hidden=true; return; }
    if(!st.unlocked){ locked=true; go.textContent='Unlock Finance'; msg.hidden=false; msg.textContent='Finance is locked. Unlock it and the year comes back here.'; return; }
    if(finApi.financeScreen&&!fin.screen&&!fin.allowCapture&&!yr.screen){ yr.screen=true; finApi.financeScreen(true); }
    const d=await finApi.financeData().catch(function(){ return {locked:true}; });
    if(!yr.open||yr.moneyHost!==host){ yrScreenOff(); return; }
    if(d.locked||!d.accounts||!d.accounts.length){ yrScreenOff(); msg.hidden=false; msg.textContent=d.locked?'Finance locked again.':'No bank accounts yet.'; return; }
    yrDrawMoney(host,d.accounts,d.kinds,d.accounts[0].currency);
  });
}
if(finApi&&finApi.onFinanceLocked)finApi.onFinanceLocked(function(){ if(yr.open&&!yr.sample&&yr.moneyHost){ yrScreenOff(); yrMoneyGate(yr.moneyHost); } });

function yrDrawMoney(host,accounts,kinds,cur){
  host.textContent='';
  const m=moneyYear(accounts,kinds||{},yr.year,Date.now());
  if(!m)return;
  const money=function(v){ return finCompact(v,cur); };
  const kept=m.net;
  const c=yrCard('Money',finMoney(Math.round(kept),cur).replace(/\.00$/,''),kept>=0?'kept: what came in minus what went out'+(m.savingsRate!=null?', '+Math.round(m.savingsRate*100)+'% of your income.':'.'):'more went out than came in.');
  const tiles=el('div','fin-tiles');
  [['In',finMoney(m.in,cur)],['Out',finMoney(m.out,cur)],['Purchases',yrNum(m.purchases)]].forEach(function(x){
    const tile=el('div','fin-tile'); tile.appendChild(el('span','mono fin-label',x[0])); tile.appendChild(el('b',null,x[1])); tiles.appendChild(tile);
  });
  c.appendChild(tiles);
  const first=m.months.findIndex(function(x){ return !x.noData; });
  if(first>0)c.appendChild(el('p','fin-note','Money from '+new Date(m.from).toLocaleDateString(undefined,{month:'long',day:'numeric'})+' on: your bank’s history before that isn’t kept here.'));
  // in and out by month, side by side (finance.js finInOutChart, over the year)
  const legend=el('div','fin-legend');
  [['In',FIN_ASSET],['Out',FIN_DEBT]].forEach(function(x){ const k=el('span','fin-key'); const sw=el('span','fin-swatch'); sw.style.background=x[1]; k.appendChild(sw); k.appendChild(el('span',null,x[0])); legend.appendChild(k); });
  c.appendChild(legend);
  const top=Math.max.apply(null,m.months.map(function(x){ return Math.max(x.in,x.out); }).concat([1]));
  const cols=el('div','fin-cols fin-cols-pair yr-cols');
  m.months.forEach(function(x,i){
    const col=el('div','fin-col'+(x.noData?' yr-nodata':'')+(m.partial&&i===m.months.length-1?' partial':''));
    col.title=YR_MONTH_NAMES[i]+(x.noData?': no data':': in '+finMoney(x.in,cur)+', out '+finMoney(x.out,cur));
    const plot=el('div','fin-col-plot fin-col-pair');
    [[x.in,FIN_ASSET],[x.out,FIN_DEBT]].forEach(function(q){
      const bar=el('div','fin-col-bar'); const b=el('span','fin-col-fill');
      b.style.background=q[1]; b.style.height=(q[0]>0?Math.max(2,q[0]/top*100):0)+'%'; bar.appendChild(b); plot.appendChild(bar);
    });
    col.appendChild(plot); col.appendChild(el('span','mono fin-col-label',x.label.slice(0,1)));
    cols.appendChild(col);
  });
  c.appendChild(cols);
  c.appendChild(yrFacts([
    m.bestMonth>=0&&['best month',YR_MONTH_NAMES[m.bestMonth]+': kept '+money(m.months[m.bestMonth].net)],
    m.priciestMonth>=0&&['priciest month',YR_MONTH_NAMES[m.priciestMonth]+': '+money(m.months[m.priciestMonth].out)+' out'],
    m.refunds>0&&['refunds back',finMoney(m.refunds,cur)]
  ]));
  c.appendChild(el('p','fin-note','Counted like the Finance tab: moving money between your own accounts and paying off cards don’t count, and refunds come off what went out.'));
  host.appendChild(c);

  // where it went: bills against everything else, the places, the biggest one-off
  if(m.out>0){
    const w=yrCard('Where the money went',m.places[0]?m.places[0].name:'',m.places[0]?'was where you spent the most: '+finMoney(Math.round(m.places[0].total),cur).replace(/\.00$/,'')+'.':'');
    const fixedPct=Math.round(m.fixed/Math.max(1,m.fixed+m.variable)*100);
    const split=el('div','yr-split'); split.title='Bills '+finMoney(m.fixed,cur)+' · everything else '+finMoney(m.variable,cur);
    const f=el('span','yr-split-fixed'); f.style.width=fixedPct+'%'; split.appendChild(f);
    w.appendChild(el('div','mono fin-label yr-split-label','bills and rent '+fixedPct+'% · everything else '+(100-fixedPct)+'%'));
    w.appendChild(split);
    if(m.places.length){ w.appendChild(el('div','mono fin-label yr-sub','top places')); w.appendChild(yrBars(m.places.map(function(x){ return {name:x.name,value:x.total}; }),money,FIN_DEBT)); }
    if(m.bills.length){ w.appendChild(el('div','mono fin-label yr-sub','biggest bills')); w.appendChild(yrBars(m.bills.map(function(x){ return {name:x.name,value:x.total}; }),money)); }
    if(m.biggest)w.appendChild(yrFacts([['biggest purchase',m.biggest.name+', '+finMoney(m.biggest.amount,cur)+' on '+new Date(m.biggest.at).toLocaleDateString(undefined,{month:'short',day:'numeric'})]]));
    host.appendChild(w);
  }

  // net worth from one end of the year to the other
  if(m.worth){
    const wv=m.worth, up=wv.change>=0;
    const nw=yrCard('Net worth',(up?'+':'−')+finMoney(Math.abs(Math.round(wv.change)),cur).replace(/\.00$/,''),
      'from '+money(wv.start)+' on '+new Date(wv.startAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})+' to '+money(wv.end)+(m.partial?' today.':' on Dec 31.'));
    nw.appendChild(yrBars([{name:'Cash',value:wv.cash,color:FIN_ASSET},{name:'Investments',value:wv.invest,color:FIN_ASSET},{name:'Owed',value:wv.debts,color:FIN_DEBT}].filter(function(r){ return r.value>0; }),money));
    if(wv.invest>0)nw.appendChild(el('p','fin-note','Past balances are worked back from today’s, so investments’ ups and downs in the market all show up in today’s number.'));
    host.appendChild(nw);
  }
}

/* the card at the top of the To do list, January 1 through February, until he opens it or says not now */
function reviewBannerCheck(){
  const b=$('reviewBanner'); if(!b)return;
  const y=reviewYearFor(Date.now());
  let hide=!y;
  if(y){ try{ hide=localStorage.getItem('review.seen.'+y)==='1'; }catch(e){} }
  if(!hide&&tasksYear(state.tasks,reviewLog(),y).total===0&&!finApi)hide=true;
  b.hidden=hide;
  if(!hide)$('reviewBannerText').textContent='Your '+y+' in review is ready: what you got done, what the Agent did, your hours'+(finApi?' and your money':'')+'.';
}
$('reviewBannerOpen').addEventListener('click',function(){ openReview({}); });
$('reviewBannerLater').addEventListener('click',function(){ const y=reviewYearFor(Date.now()); try{ localStorage.setItem('review.seen.'+y,'1'); }catch(e){} reviewBannerCheck(); });
$('reviewOpenBtn').addEventListener('click',function(){ openReview({}); });
$('reviewSampleBtn').addEventListener('click',function(){ openReview({sample:true,year:reviewYearFor(Date.now())||new Date().getFullYear()}); });
$('reviewOpenBtn').textContent=reviewYearFor(Date.now())?'Open your '+reviewYearFor(Date.now()):'Your '+new Date().getFullYear()+' so far';
document.addEventListener('keydown',function(e){ if(e.key==='Escape'&&yr.open){ e.preventDefault(); closeReview(); } });
setInterval(reviewBannerCheck,3600000); // the morning of January 1 with the app left open
