/* Finance tab: his bank accounts through SimpleFIN, read-only. On the computer main/finance.js keeps them
   encrypted behind his passphrase; on the phone mobile/finance-phone.js keeps its own copy (paired from the
   computer with a QR code) behind his fingerprint. Both answer the same finance* calls (finApi). Bank text is shown with textContent only, never as HTML, and this page
   drops its copy of the data when he leaves the tab or it locks.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

const fin={ data:null, query:'', account:'', shown:50, busy:false, msg:'', msgErr:false };
const finApi=window.desktop&&window.desktop.financeStatus?window.desktop:(window.phoneFinance||null);
if(finApi){
  $('tabFinance').hidden=false;
  finApi.onFinanceLocked(function(){ fin.data=null; if(state.activeTab==='finance')renderFinance(); });
  // purchase emails came in (or it started or stopped looking): drawn again, search and filter kept
  if(finApi.onFinanceUpdated)finApi.onFinanceUpdated(function(){ if(state.activeTab==='finance'&&fin.data&&!fin.busy)renderFinance(); });
  // the phone: back in the app on a locked Finance tab → the fingerprint prompt again
  if(finApi.phone)document.addEventListener('visibilitychange',function(){
    if(document.hidden)return;
    const inFlight=fin.unlocking&&Date.now()-fin.unlocking<15000; // some phones hide the page under the prompt itself
    if(state.activeTab==='finance'&&!fin.data&&!fin.invalidated&&!inFlight){ fin.autoAsked=false; renderFinance(); }
  });
}
function financeLeave(){ if(typeof finStopStocks==='function')finStopStocks(); fin.autoAsked=false; fin.data=null; fin.query=''; fin.account=''; fin.shown=50; fin.msg=''; const v=$('financeView'); if(v)v.textContent=''; }

function finMoney(n,cur){
  try{ return new Intl.NumberFormat(undefined,{style:'currency',currency:cur||'USD'}).format(n); }catch(e){ return (n<0?'-':'')+'$'+Math.abs(n).toFixed(2); }
}
function finAgo(ms){
  if(!ms)return 'not updated yet';
  const m=Math.round((Date.now()-ms)/60000);
  return m<1?'updated just now':m<60?'updated '+m+' min ago':m<48*60?'updated '+Math.round(m/60)+' h ago':'updated '+Math.round(m/1440)+' days ago';
}
function finDate(sec){ return sec?new Date(sec*1000).toLocaleDateString(undefined,{month:'short',day:'numeric'}):'pending'; }
function finSay(msg,isErr){ fin.msg=msg||''; fin.msgErr=!!isErr; }
function finMsgEl(){ const p=el('p','fin-msg'+(fin.msgErr?' err':''),fin.msg); p.hidden=!fin.msg; return p; }
function finInput(type,placeholder,id){
  const i=el('input','fin-input'); i.type=type; i.placeholder=placeholder; i.autocomplete=type==='password'?'new-password':'off'; i.spellcheck=false; if(id)i.id=id; return i;
}

async function renderFinance(){
  const v=$('financeView'); if(!v||!finApi)return;
  let st; try{ st=await finApi.financeStatus(); }catch(e){ v.textContent=''; v.appendChild(el('p','empty','Finance isn’t available.')); return; }
  if(state.activeTab!=='finance')return;
  if(!st.setUp)return drawFinSetup(v,st);
  if(!st.unlocked){ fin.data=null; return drawFinLocked(v,st); }
  const d=await finApi.financeData();
  if(state.activeTab!=='finance')return;
  if(d.locked){ fin.data=null; return drawFinLocked(v,st); }
  fin.data=d; drawFinMain(v);
}

/* ── first time: SimpleFIN setup token + a passphrase (on the phone: pairing with the computer) ── */
function drawFinSetup(v,st){
  if(finApi.phone)return drawFinPair(v);
  v.textContent='';
  const box=el('div','fin-card fin-setup');
  box.appendChild(el('h3',null,'Connect your bank accounts'));
  const steps=el('ol','fin-steps');
  ['Make an account at bridge.simplefin.org (about $15 a year) and connect your banks there.',
   'On SimpleFIN, choose New connection and copy the setup token.',
   'Paste it below and pick a passphrase. Your bank data is encrypted with it on this computer.'].forEach(function(t){ steps.appendChild(el('li',null,t)); });
  box.appendChild(steps);
  const link=el('button','ghost mono','open bridge.simplefin.org ↗');
  link.addEventListener('click',function(){ window.open('https://bridge.simplefin.org/','_blank'); });
  box.appendChild(link);
  const tok=finInput('password','SimpleFIN setup token');
  const p1=finInput('password','passphrase (at least '+st.minPassphrase+' characters)');
  const p2=finInput('password','passphrase again');
  [tok,p1,p2].forEach(function(i){ box.appendChild(i); });
  box.appendChild(el('p','fin-note','The passphrase isn’t saved anywhere and nobody can reset it. If you forget it, choose “forgot your passphrase?” on the lock screen and connect again with a new token. SimpleFIN can only read your accounts. It can’t move money.'));
  const go=el('button','btn-accent',fin.busy?'Connecting…':'Connect'); go.disabled=fin.busy;
  go.addEventListener('click',async function(){
    if(p1.value.length<st.minPassphrase){ finSay('Use at least '+st.minPassphrase+' characters for the passphrase.',true); return drawFinSetup(v,st); }
    if(p1.value!==p2.value){ finSay('The two passphrases don’t match.',true); return drawFinSetup(v,st); }
    fin.busy=true; finSay(''); go.disabled=true; go.textContent='Connecting…';
    const r=await finApi.financeSetup(tok.value.trim(),p1.value).catch(function(e){ return {ok:false,error:e.message}; });
    tok.value=p1.value=p2.value=''; fin.busy=false;
    if(!r.ok){ finSay(r.error,true); return drawFinSetup(v,st); }
    finSay(r.warning||'',!!r.warning); renderFinance();
  });
  box.appendChild(go);
  box.appendChild(finMsgEl());
  v.appendChild(box);
  tok.focus();
}

// the phone: scan the code the computer's Finance tab shows, then his fingerprint
function drawFinPair(v){
  v.textContent='';
  const box=el('div','fin-card fin-setup');
  box.appendChild(el('h3',null,'Finance on this phone'));
  const steps=el('ol','fin-steps');
  ['On your computer, open Finance and unlock it.',
   'At the bottom, open “pair your phone” and choose Show the code.',
   'Tap Scan below and point the phone at the code, then use your fingerprint.'].forEach(function(t){ steps.appendChild(el('li',null,t)); });
  box.appendChild(steps);
  box.appendChild(el('p','fin-note','This phone then gets your accounts from SimpleFIN and prices from Yahoo Finance itself, and opens Finance only with your fingerprint. Purchase emails stay on the computer.'));
  const go=el('button','btn-accent',fin.busy?'Setting up…':'Scan'); go.disabled=fin.busy;
  go.addEventListener('click',async function(){
    fin.busy=true; finSay(''); go.disabled=true; go.textContent='Setting up…';
    const r=await finApi.financePair().catch(function(e){ return {ok:false,error:e.message}; });
    fin.busy=false;
    if(!r.ok){ finSay(r.cancelled?'':r.error,!r.cancelled); return drawFinPair(v); }
    finSay(r.warning||'',!!r.warning); renderFinance();
  });
  box.appendChild(go);
  box.appendChild(finMsgEl());
  v.appendChild(box);
}
// the phone: one tap (and once by itself when the tab opens) for the fingerprint prompt
function drawFinPhoneLocked(v){
  v.textContent='';
  const box=el('div','fin-card fin-lock');
  box.appendChild(el('h3',null,'Finance is locked'));
  box.appendChild(el('p','fin-note','It locks when you leave the app and after 30 minutes without use.'));
  const go=el('button','btn-accent','Unlock with fingerprint');
  // one prompt at a time, but a request that never came back (or is 15 s old) never blocks the button
  const unlock=async function(){
    if(fin.unlocking&&Date.now()-fin.unlocking<15000)return;
    const mine=fin.unlocking=Date.now(); go.textContent='Unlocking…';
    const r=await finApi.financeUnlock().catch(function(e){ return {ok:false,error:e.message}; });
    if(fin.unlocking===mine)fin.unlocking=0;
    if(r.notVisible){ fin.autoAsked=false; go.textContent='Unlock with fingerprint'; return; } // asked again when the app is back
    finSay(r.ok?(r.warning||''):r.cancelled?'':r.error,!r.ok&&!r.cancelled||!!r.warning);
    if(r.invalidated)fin.invalidated=true;
    renderFinance();
  };
  go.addEventListener('click',unlock);
  box.appendChild(go);
  box.appendChild(finMsgEl());
  box.appendChild(finForgetFold(fin.invalidated?'pair again':'remove Finance from this phone','This deletes Finance’s data and fingerprint key on this phone only. Your computer and SimpleFIN keep working, and you can pair again from the computer.'));
  v.appendChild(box);
  // asked by itself once, only while the app is on screen (Android can't show it in the background)
  if(!fin.autoAsked&&!fin.invalidated&&!document.hidden){ fin.autoAsked=true; setTimeout(function(){ if(!document.hidden)unlock(); else fin.autoAsked=false; },250); }
}

/* ── locked ── */
function drawFinLocked(v,st){
  if(finApi.phone)return drawFinPhoneLocked(v);
  v.textContent='';
  const box=el('div','fin-card fin-lock');
  box.appendChild(el('h3',null,'Finance is locked'));
  box.appendChild(el('p','fin-note','It locks after 30 minutes without use, when the screen locks, and when the computer sleeps.'));
  // Windows Hello first (asked by itself once when the tab opens); the passphrase folded under it
  let passBox=box;
  if(st.hello&&finApi.financeHelloUnlock){
    const hb=el('button','btn-accent','Unlock with Windows Hello');
    const helloUnlock=async function(){
      if(fin.busy)return;
      fin.busy=true; hb.disabled=true; hb.textContent='Waiting for Windows Hello…';
      const r=await finApi.financeHelloUnlock().catch(function(e){ return {ok:false,error:e.message}; });
      fin.busy=false;
      finSay(r.ok?(r.warning||''):r.error,!r.ok&&!!r.error||!!r.warning);
      renderFinance();
    };
    hb.addEventListener('click',helloUnlock);
    box.appendChild(hb);
    box.appendChild(el('p','fin-note','Your Windows PIN, fingerprint or face.'));
    passBox=el('details','fin-fold fin-pass-fold');
    passBox.appendChild(el('summary','mono','use your passphrase instead'));
    passBox.open=!!(fin.msg&&fin.msgErr); // Hello didn't work: the passphrase is right there
    if(!fin.autoAsked){ fin.autoAsked=true; setTimeout(helloUnlock,200); }
  }
  const pass=finInput('password','passphrase');
  const go=el('button','btn-accent','Unlock');
  const unlock=async function(){
    if(!pass.value||fin.busy)return;
    fin.busy=true; go.disabled=true; go.textContent='Unlocking…';
    const r=await finApi.financeUnlock(pass.value).catch(function(e){ return {ok:false,error:e.message}; });
    pass.value=''; fin.busy=false;
    finSay(r.ok?(r.warning||''):r.error,!r.ok||!!r.warning);
    renderFinance();
  };
  pass.addEventListener('keydown',function(e){ if(e.key==='Enter')unlock(); });
  go.addEventListener('click',unlock);
  const row=el('div','fin-row'); row.appendChild(pass); row.appendChild(go); passBox.appendChild(row);
  if(passBox!==box){ box.appendChild(finMsgEl()); box.appendChild(passBox); }
  if(st.waitSeconds&&!fin.msg)finSay('Too many wrong tries. Wait '+st.waitSeconds+' seconds.',true);
  if(passBox===box){
    box.appendChild(finMsgEl());
    box.appendChild(el('p','fin-note','After you unlock, Windows Hello (your Windows PIN, fingerprint or face) can open Finance next time.'));
  }
  box.appendChild(finForgetFold('forgot your passphrase?','Nobody can reset it. The only way back in is to forget this connection: the saved bank data and history on this computer are deleted, and you connect again with a new SimpleFIN token.'));
  v.appendChild(box);
  if(passBox===box)pass.focus();
}
/* Forgetting deletes everything, so it stays folded away and needs the word typed before the button works */
function finForgetFold(label,note){
  const fold=el('details','fin-fold');
  fold.appendChild(el('summary','mono',label));
  fold.appendChild(el('p','fin-note',note));
  const word=finInput('text','type forget to confirm');
  const go=el('button','fin-forget-go','Forget this connection'); go.disabled=true;
  word.addEventListener('input',function(){ go.disabled=word.value.trim().toLowerCase()!=='forget'; });
  go.addEventListener('click',async function(){
    if(go.disabled)return;
    go.disabled=true;
    await finApi.financeForget(); fin.invalidated=false;
    finSay(finApi.phone?'Removed from this phone. Pair again from the computer whenever you like.':'Forgotten. Remember to disable it on bridge.simplefin.org too.'); renderFinance();
  });
  const row=el('div','fin-row'); row.appendChild(word); row.appendChild(go); fold.appendChild(row);
  fold.addEventListener('toggle',function(){ if(!fold.open){ word.value=''; go.disabled=true; } });
  return fold;
}

// an Agent order under the charge that paid for it: the first few items, the rest on a tap
function finOrderEl(m){
  const o=m.order, box=el('details','fin-order'+(m.sure?'':' maybe'));
  const line=function(it){ return (it.qty&&it.qty>1?it.qty+'× ':'')+it.name+(it.price?' · '+(typeof it.price==='number'?finMoney(it.price):it.price):''); };
  const what=o.email?(m.sure?'From your email: ':'Maybe from your email: '):(m.sure?'Agent order: ':'Maybe the Agent order: ');
  const count=o.items.length?' ('+o.items.length+(o.items.length===1?' item':' items')+')':o.total?' ('+finMoney(o.total)+', '+finDate(o.at/1000)+')':'';
  box.appendChild(el('summary',null,what+o.title+count));
  if(!o.items.length){ box.classList.add('bare'); return box; }
  const ul=el('ul','fin-items');
  o.items.forEach(function(it){ ul.appendChild(el('li',null,line(it))); });
  box.appendChild(ul);
  box.open=o.items.length<=3;
  return box;
}

// how the purchase-email look is doing, beside "updated 5 min ago"
function finMailWord(m){
  if(!m)return '';
  if(m.phone)return 'purchase emails show on the computer';
  if(m.busy)return 'reading purchase emails…';
  if(m.off)return 'connect Gmail in Settings → Calendars to match emails';
  if(m.error)return 'emails: '+m.error;
  return m.last?'emails '+finAgo(m.last).replace('updated ','checked '):'emails not read yet';
}

// any section folds up to its title (with a one-line summary while it's folded); remembered on this computer
function finOpen(id){ try{ return localStorage.getItem('finOpen.'+id)!=='0'; }catch(e){ return true; } }
function finFoldable(card,id,title,summary){
  const h=card.querySelector(':scope > h3'); if(h)h.remove();
  const body=el('div','fin-fold-body');
  while(card.firstChild)body.appendChild(card.firstChild);
  let open=finOpen(id);
  const t=el('button','fin-fold-title');
  const chev=el('span','fin-chev'); chev.innerHTML='<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  t.appendChild(chev); t.appendChild(el('h3',null,title));
  const sum=el('span','fin-amt fin-fold-sum',summary||'');
  t.appendChild(sum);
  const show=function(){
    body.hidden=!open; chev.classList.toggle('open',open); sum.hidden=open||!summary; t.setAttribute('aria-expanded',String(open));
    if(open)body.querySelectorAll('.fin-line').forEach(function(h){ if(h._draw)h._draw(); }); // charts drawn while folded had no width
  };
  t.addEventListener('click',function(){ open=!open; try{ localStorage.setItem('finOpen.'+id,open?'1':'0'); }catch(e){} show(); });
  show();
  card.appendChild(t); card.appendChild(body);
  return card;
}

/* ── assets and debts (finance-worth.js) ── */
const FIN_ASSET='#2742C8', FIN_DEBT='#C4651A'; // checked together: colorblind-safe, 3:1 on the card
function finCompact(n,cur){
  const a=Math.abs(n);
  if(a<1000)return finMoney(Math.round(n),cur).replace(/\.00$/,'');
  try{ return new Intl.NumberFormat(undefined,{style:'currency',currency:cur||'USD',notation:'compact',maximumFractionDigits:1}).format(n); }catch(e){ return '$'+Math.round(n/1000)+'K'; }
}
function finWorthChart(accounts,cur){
  const w=worthOf(accounts);
  const box=el('div','fin-card fin-chart fin-worth');
  box.appendChild(el('h3',null,'Assets and debts'));
  box.appendChild(el('p','fin-note','Net worth '+finMoney(w.net,cur)+': what’s in your accounts minus what you owe on cards and loans.'));
  const legend=el('div','fin-legend');
  [['Assets',w.assetTotal,FIN_ASSET],['Debts',w.debtTotal,FIN_DEBT]].forEach(function(p){
    const k=el('span','fin-key'); const sw=el('span','fin-swatch'); sw.style.background=p[2];
    k.appendChild(sw); k.appendChild(el('span',null,p[0]+' ')); k.appendChild(el('b',null,finMoney(p[1],cur))); legend.appendChild(k);
  });
  box.appendChild(legend);
  if(w.days.length>1){
    const host=el('div','fin-line'); box.appendChild(host);
    const tip=el('div','fin-tip'); tip.hidden=true; host.appendChild(tip);
    const draw=function(){ const width=host.clientWidth; if(width>0)finWorthLine(host,tip,w.days,width,cur); };
    host._draw=draw; setTimeout(draw,0);
    if(typeof ResizeObserver!=='undefined')new ResizeObserver(draw).observe(host);
  }
  // each account, on its side
  const cols=el('div','fin-worth-cols');
  [['What you have',w.assets,FIN_ASSET],['What you owe',w.debts,FIN_DEBT]].forEach(function(p){
    const col=el('div');
    col.appendChild(el('div','mono fin-label fin-org',p[0]));
    if(!p[1].length)col.appendChild(el('p','fin-note','Nothing here.'));
    const top=Math.max.apply(null,p[1].map(function(a){ return a.value; }).concat([1]));
    p[1].forEach(function(a){
      const r=el('div','fin-hbar'); r.title=(a.org?a.org+' · ':'')+a.name+': '+finMoney(a.value,cur);
      r.appendChild(el('span','fin-hbar-name',a.name));
      const track=el('span','fin-hbar-track'), b=el('span','fin-hbar-fill');
      b.style.width=Math.max(2,a.value/top*100)+'%'; b.style.background=p[2]; track.appendChild(b); r.appendChild(track);
      r.appendChild(el('span','fin-amt',finMoney(a.value,cur)));
      col.appendChild(r);
    });
    cols.appendChild(col);
  });
  box.appendChild(cols);
  return finFoldable(box,'worth','Assets and debts','Net worth '+finMoney(w.net,cur));
}
// the two lines over the days, with a hairline grid and a hover readout
function finWorthLine(host,tip,days,width,cur){
  const NS='http://www.w3.org/2000/svg', H=170, L=52, R=10, T=10, B=22;
  const old=host.querySelector('svg'); if(old)old.remove();
  const svg=document.createElementNS(NS,'svg'); svg.setAttribute('width',width); svg.setAttribute('height',H); svg.setAttribute('role','img');
  svg.setAttribute('aria-label','Assets and debts over the last '+days.length+' days');
  const mk=function(tag,attrs){ const n=document.createElementNS(NS,tag); Object.keys(attrs).forEach(function(k){ n.setAttribute(k,attrs[k]); }); svg.appendChild(n); return n; };
  const top=Math.max.apply(null,days.map(function(d){ return Math.max(d.assets,d.debts); }).concat([1]));
  const step=Math.pow(10,Math.floor(Math.log10(top/2))); const tick=[1,2,2.5,5,10].map(function(m){ return m*step; }).find(function(s){ return top/s<=3; })||step*10;
  const ymax=Math.ceil(top/tick)*tick;
  const x=function(i){ return L+(width-L-R)*(days.length===1?0:i/(days.length-1)); };
  const y=function(v){ return T+(H-T-B)*(1-v/ymax); };
  for(let v=0;v<=ymax+0.01;v+=tick){
    mk('line',{x1:L,x2:width-R,y1:y(v),y2:y(v),class:'fin-grid'});
    mk('text',{x:L-6,y:y(v)+3,'text-anchor':'end',class:'fin-axis'}).textContent=finCompact(v,cur);
  }
  [0,Math.floor((days.length-1)/2),days.length-1].forEach(function(i,k){
    mk('text',{x:x(i),y:H-6,'text-anchor':k===0?'start':k===2?'end':'middle',class:'fin-axis'}).textContent=finDate(days[i].at/1000);
  });
  [['assets',FIN_ASSET],['debts',FIN_DEBT]].forEach(function(s){
    mk('polyline',{points:days.map(function(d,i){ return x(i)+','+y(d[s[0]]); }).join(' '),fill:'none',stroke:s[1],'stroke-width':2,'stroke-linejoin':'round','stroke-linecap':'round'});
  });
  const last=days.length-1;
  [['assets',FIN_ASSET],['debts',FIN_DEBT]].forEach(function(s){ mk('circle',{cx:x(last),cy:y(days[last][s[0]]),r:4,fill:s[1],class:'fin-dot'}); });
  // hover: a hairline at the nearest day, a dot on each line, the numbers in a box
  const cross=mk('line',{y1:T,y2:H-B,class:'fin-cross',visibility:'hidden'});
  const dots=[FIN_ASSET,FIN_DEBT].map(function(c){ return mk('circle',{r:4,fill:c,class:'fin-dot',visibility:'hidden'}); });
  const hit=mk('rect',{x:L,y:0,width:Math.max(0,width-L-R),height:H,fill:'transparent'});
  hit.addEventListener('mousemove',function(e){
    const rx=e.clientX-svg.getBoundingClientRect().left;
    const i=Math.max(0,Math.min(last,Math.round((rx-L)/(width-L-R)*last)));
    const d=days[i], cx=x(i);
    cross.setAttribute('x1',cx); cross.setAttribute('x2',cx); cross.setAttribute('visibility','visible');
    [d.assets,d.debts].forEach(function(v,k){ dots[k].setAttribute('cx',cx); dots[k].setAttribute('cy',y(v)); dots[k].setAttribute('visibility','visible'); });
    tip.textContent='';
    tip.appendChild(el('b',null,finDate(d.at/1000)));
    tip.appendChild(el('span',null,'Assets '+finMoney(d.assets,cur)));
    tip.appendChild(el('span',null,'Debts '+finMoney(d.debts,cur)));
    tip.appendChild(el('span',null,'Net '+finMoney(d.assets-d.debts,cur)));
    tip.hidden=false;
    tip.style.left=Math.min(Math.max(0,cx+10),width-tip.offsetWidth)+'px';
  });
  hit.addEventListener('mouseleave',function(){ tip.hidden=true; cross.setAttribute('visibility','hidden'); dots.forEach(function(c){ c.setAttribute('visibility','hidden'); }); });
  host.insertBefore(svg,tip);
}

/* ── live stocks (main/finance-stocks.js): asked again every minute while the tab is open ── */
let finStockTimer=null;
function finStopStocks(){ clearInterval(finStockTimer); finStockTimer=null; }
function finStocksCard(cur){
  const box=el('div','fin-card fin-chart fin-stocks');
  box.appendChild(finStocksTitle(box,null,cur));
  const wait=el('div','fin-stocks-body'); wait.hidden=!finStocksOpen(); wait.appendChild(el('p','fin-note','Loading prices…')); box.appendChild(wait);
  const load=async function(force){
    const s=await finApi.financeStocks(!!force).catch(function(e){ return {error:e.message,rows:[]}; });
    if(!box.isConnected)return; // the tab was drawn again meanwhile: its new card has its own timer
    if(s.locked){ finStopStocks(); fin.data=null; if(state.activeTab==='finance')renderFinance(); return; }
    finDrawStocks(box,s,cur,load);
  };
  load(false);
  finStopStocks();
  finStockTimer=setInterval(function(){ if(state.activeTab!=='finance'||!fin.data)return finStopStocks(); load(false); },60000);
  return box;
}
function finSigned(n,cur){ return (n>0?'+':n<0?'−':'')+finMoney(Math.abs(n),cur); }
// the card folds up to its title line (which then shows the total and today's move); remembered on this computer
function finStocksOpen(){ try{ return localStorage.getItem('finStocksOpen')!=='0'; }catch(e){ return true; } }
function finStocksTitle(box,s,cur){
  const open=finStocksOpen();
  const t=el('button','fin-fold-title');
  t.setAttribute('aria-expanded',String(open));
  const chev=el('span','fin-chev'+(open?' open':'')); chev.innerHTML='<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'; t.appendChild(chev);
  t.appendChild(el('h3',null,'Stocks'));
  if(!open&&s&&s.held){
    t.appendChild(el('span','fin-amt',finMoney(s.total,cur)));
    if(s.rows.some(function(r){ return r.live; }))t.appendChild(el('span','fin-amt fin-delta '+(s.changePct>=0?'up':'down'),(s.changePct>=0?'▲ ':'▼ ')+Math.abs(s.changePct).toFixed(2)+'%'));
  }
  t.addEventListener('click',function(){
    try{ localStorage.setItem('finStocksOpen',open?'0':'1'); }catch(e){}
    if(s)finDrawStocks(box,s,cur); else{ const b=box.querySelector('.fin-stocks-body'); if(b)b.hidden=open; box.replaceChild(finStocksTitle(box,s,cur),t); }
  });
  return t;
}
function finDrawStocks(box,s,cur,load){
  box.textContent='';
  box.appendChild(finStocksTitle(box,s,cur));
  const body=el('div','fin-stocks-body'); body.hidden=!finStocksOpen(); box.appendChild(body);
  if(!s.held){
    body.appendChild(el('p','fin-note','No stocks came from SimpleFIN. To see them here, connect your brokerage (Fidelity, Schwab, Robinhood…) on bridge.simplefin.org, then press refresh.'));
    return;
  }
  const when=s.at?new Date(s.at).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}):'';
  const live=s.rows.some(function(r){ return r.live; });
  body.appendChild(el('p','fin-note'+(s.error?' fin-msg err':''),s.error||(live?'Live from Yahoo Finance · price at '+when+(new Date(s.at).toDateString()!==new Date().toDateString()?' on '+finDate(s.at/1000):''):'Values from your brokerage, as SimpleFIN last sent them.')+(s.warning&&!s.error?' '+s.warning:'')));
  // the headline: what it's all worth, today's move, and the gain since bought
  const head=el('div','fin-stock-head');
  head.appendChild(el('b','fin-stock-total',finMoney(s.total,cur)));
  if(live){
    const ch=el('span','fin-delta '+(s.change>=0?'up':'down'),(s.change>=0?'▲ ':'▼ ')+finSigned(s.change,cur)+' ('+(s.changePct>=0?'+':'−')+Math.abs(s.changePct).toFixed(2)+'%) today');
    head.appendChild(ch);
  }
  if(s.gain!=null)head.appendChild(el('span','fin-sub',finSigned(s.gain,cur)+' since bought'));
  body.appendChild(head);
  // the line: one point a day over 3 months, 6 months or a year (his pick, remembered on this computer)
  const ranges=[['3m','3 months',3],['6m','6 months',6],['1y','1 year',12]];
  let range='6m'; try{ range=localStorage.getItem('finStockRange')||'6m'; }catch(e){}
  const pick=ranges.find(function(r){ return r[0]===range; })||ranges[1];
  const from=new Date(); from.setMonth(from.getMonth()-pick[2]); from.setHours(0,0,0,0);
  const pts=(s.days||[]).filter(function(p){ return p[0]>=from.getTime(); });
  const views=el('div','fin-views');
  ranges.forEach(function(r){
    const b=el('button','ghost mono'+(r===pick?' on':''),r[1]);
    b.addEventListener('click',function(){ try{ localStorage.setItem('finStockRange',r[0]); }catch(e){} finDrawStocks(box,s,cur,load); });
    views.appendChild(b);
  });
  if(pts.length>1){
    const first=pts[0][1], diff=pts[pts.length-1][1]-first;
    views.appendChild(el('span','fin-delta fin-range '+(diff>=0?'up':'down'),(diff>=0?'▲ ':'▼ ')+finSigned(diff,cur)+(first?' ('+(diff>=0?'+':'−')+Math.abs(diff/first*100).toFixed(1)+'%)':'')+' over '+pick[1]));
  }
  body.appendChild(views);
  if(pts.length>1){
    const host=el('div','fin-line'); body.appendChild(host);
    const tip=el('div','fin-tip'); tip.hidden=true; host.appendChild(tip);
    const draw=function(){ const w=host.clientWidth; if(w>0)finStockLine(host,tip,pts,w,cur,false); };
    host._draw=draw; setTimeout(draw,0);
    if(typeof ResizeObserver!=='undefined')new ResizeObserver(draw).observe(host);
  } else body.appendChild(el('p','fin-note','Yahoo Finance didn’t send prices for this yet.'));
  // each holding
  const holdBox=el('div','fin-holdings-fold');
  const table=el('div','fin-holdings');
  const headRow=el('div','fin-hold head');
  ['','Shares','Price','Today','Value','Gain'].forEach(function(h){ headRow.appendChild(el('span','mono fin-label',h)); });
  table.appendChild(headRow);
  s.rows.forEach(function(r){
    const row=el('div','fin-hold');
    const who=el('span','fin-desc'); who.appendChild(el('b',null,r.symbol||r.name)); if(r.symbol&&r.name)who.appendChild(el('span','fin-sub',r.name));
    row.appendChild(who);
    row.appendChild(el('span','fin-amt',String(Math.round(r.shares*1000)/1000)));
    row.appendChild(el('span','fin-amt',finMoney(r.price,cur)));
    row.appendChild(el('span','fin-amt fin-delta '+(!r.live?'':r.changePct>=0?'up':'down'),r.live?(r.changePct>=0?'▲ ':'▼ ')+Math.abs(r.changePct).toFixed(2)+'%':'—'));
    row.appendChild(el('span','fin-amt',finMoney(r.value,cur)));
    row.appendChild(el('span','fin-amt fin-delta '+(r.gain==null?'':r.gain>=0?'up':'down'),r.gain==null?'—':finSigned(r.gain,cur)));
    table.appendChild(row);
  });
  holdBox.appendChild(table);
  body.appendChild(finFoldable(holdBox,'holdings','Holdings',s.rows.length+(s.rows.length===1?' holding':' holdings')));
  body.appendChild(el('p','fin-note','Prices from Yahoo Finance. Only the ticker symbols (like AAPL) are sent to it, never your shares or amounts.'));
}
// one line, its range zoomed to the values (a portfolio moves a little in a day), with a hover readout
function finStockLine(host,tip,pts,width,cur,today){
  const NS='http://www.w3.org/2000/svg', H=160, L=58, R=10, T=10, B=22;
  const old=host.querySelector('svg'); if(old)old.remove();
  const svg=document.createElementNS(NS,'svg'); svg.setAttribute('width',width); svg.setAttribute('height',H); svg.setAttribute('role','img');
  svg.setAttribute('aria-label','Stocks value '+(today?'today':'by day'));
  const mk=function(tag,attrs){ const n=document.createElementNS(NS,tag); Object.keys(attrs).forEach(function(k){ n.setAttribute(k,attrs[k]); }); svg.appendChild(n); return n; };
  const vals=pts.map(function(p){ return p[1]; });
  let lo=Math.min.apply(null,vals), hi=Math.max.apply(null,vals);
  if(hi-lo<1){ hi+=1; lo-=1; }
  const pad=(hi-lo)*0.1; lo-=pad; hi+=pad;
  const t0=pts[0][0], t1=pts[pts.length-1][0];
  const x=function(t){ return L+(width-L-R)*(t1===t0?0:(t-t0)/(t1-t0)); };
  const y=function(v){ return T+(H-T-B)*(1-(v-lo)/(hi-lo)); };
  [lo+pad,(lo+hi)/2,hi-pad].forEach(function(v){
    mk('line',{x1:L,x2:width-R,y1:y(v),y2:y(v),class:'fin-grid'});
    mk('text',{x:L-6,y:y(v)+3,'text-anchor':'end',class:'fin-axis'}).textContent=finCompact(v,cur);
  });
  const lab=function(t){ return today?new Date(t).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}):finDate(t/1000); };
  mk('text',{x:x(t0),y:H-6,'text-anchor':'start',class:'fin-axis'}).textContent=lab(t0);
  mk('text',{x:x(t1),y:H-6,'text-anchor':'end',class:'fin-axis'}).textContent=lab(t1);
  mk('polyline',{points:pts.map(function(p){ return x(p[0])+','+y(p[1]); }).join(' '),fill:'none',stroke:FIN_ASSET,'stroke-width':2,'stroke-linejoin':'round','stroke-linecap':'round'});
  const lastP=pts[pts.length-1];
  mk('circle',{cx:x(lastP[0]),cy:y(lastP[1]),r:4,fill:FIN_ASSET,class:'fin-dot'});
  const cross=mk('line',{y1:T,y2:H-B,class:'fin-cross',visibility:'hidden'});
  const dot=mk('circle',{r:4,fill:FIN_ASSET,class:'fin-dot',visibility:'hidden'});
  const hit=mk('rect',{x:L,y:0,width:Math.max(0,width-L-R),height:H,fill:'transparent'});
  hit.addEventListener('mousemove',function(e){
    const t=t0+(e.clientX-svg.getBoundingClientRect().left-L)/(width-L-R)*(t1-t0);
    let best=pts[0]; pts.forEach(function(p){ if(Math.abs(p[0]-t)<Math.abs(best[0]-t))best=p; });
    const cx=x(best[0]);
    cross.setAttribute('x1',cx); cross.setAttribute('x2',cx); cross.setAttribute('visibility','visible');
    dot.setAttribute('cx',cx); dot.setAttribute('cy',y(best[1])); dot.setAttribute('visibility','visible');
    tip.textContent=''; tip.appendChild(el('b',null,lab(best[0]))); tip.appendChild(el('span',null,finMoney(best[1],cur)));
    tip.hidden=false; tip.style.left=Math.min(Math.max(0,cx+10),width-tip.offsetWidth)+'px';
  });
  hit.addEventListener('mouseleave',function(){ tip.hidden=true; cross.setAttribute('visibility','hidden'); dot.setAttribute('visibility','hidden'); });
  host.insertBefore(svg,tip);
}

/* ── statements (finance-statements.js): an income statement and a balance sheet, accountant-style ── */
// accounting style: negatives in parentheses, nothing as a dash
function finAcct(n,cur){
  if(!n||Math.abs(n)<0.005)return '—';
  const s=finMoney(Math.abs(n),cur);
  return n<0?'('+s+')':s;
}
// onMark: he changed a payee's tag from here (the tab redraws what depends on it)
function finStatements(d,cur,onMark){
  const card=el('div','fin-card fin-statements');
  let which='income'; try{ which=localStorage.getItem('finStmt')||'income'; }catch(e){}
  const views=el('div','fin-views');
  const body=el('div','fin-stmt-wrap');
  const draw=function(){
    views.querySelectorAll('button').forEach(function(b){ b.classList.toggle('on',b.dataset.v===which); });
    body.textContent='';
    if(which==='balance')finBalanceTable(body,balanceSheet(d.accounts),cur);
    else finIncomeTable(body,incomeStatement(d.accounts,d.kinds),cur,d,onMark);
  };
  [['income','Income statement'],['balance','Balance sheet']].forEach(function(p){
    const b=el('button','ghost mono',p[1]); b.dataset.v=p[0];
    b.addEventListener('click',function(){ which=p[0]; try{ localStorage.setItem('finStmt',which); }catch(e){} draw(); });
    views.appendChild(b);
  });
  card.appendChild(views); card.appendChild(body);
  draw();
  // folded: last full month's net income
  const inc=incomeStatement(d.accounts,d.kinds), last=inc.net.length-2;
  return finFoldable(card,'statements','Statements',last>=0?inc.cols[last].label+' net income '+finAcct(inc.net[last],cur):'');
}
// one statement table: [kind, label, values, items] rows. kind: 'head' (a section name), 'line', 'sub' (a subtotal),
// 'total' (underlined twice), 'pct', 'gap'. A line with items opens to list the transactions behind it.
function finStmtTable(host,cols,rows,cur,title,note,itemTools){
  host.appendChild(el('div','fin-stmt-title',title));
  const wrap=el('div','fin-stmt-scroll');
  const t=el('table','fin-stmt');
  const hr=el('tr');
  hr.appendChild(el('th',null,''));
  cols.forEach(function(c){ hr.appendChild(el('th','mono'+(c.partial?' partial':''),c.label+(c.partial?' so far':''))); });
  const thead=el('thead'); thead.appendChild(hr); t.appendChild(thead);
  const tb=el('tbody');
  rows.forEach(function(r){
    const tr=el('tr','st-'+r[0]);
    if(r[0]==='gap'){ const td=el('td'); td.colSpan=cols.length+1; tr.appendChild(td); tb.appendChild(tr); return; }
    const name=el('td','st-name',r[1]); name.title=r[1]; tr.appendChild(name);
    cols.forEach(function(c,i){
      const v=r[2]?r[2][i]:null;
      tr.appendChild(el('td','st-num'+(c.partial?' partial':''),r[0]==='head'||r[0]==='subhead'?'':r[0]==='pct'?(v==null?'—':(v<0?'('+Math.abs(v*100).toFixed(0)+'%)':(v*100).toFixed(0)+'%')):finAcct(v,cur)));
    });
    tb.appendChild(tr);
    if(r[3]&&r[3].length){
      tr.classList.add('st-open'); tr.title='Show the transactions behind this line';
      let detail=null;
      tr.addEventListener('click',function(){
        if(detail){ detail.remove(); detail=null; tr.classList.remove('shown'); return; }
        detail=el('tr','st-detail'); const td=el('td'); td.colSpan=cols.length+1;
        td.appendChild(finStmtItems(r[3],cols,cur,itemTools&&itemTools(r)));
        detail.appendChild(td); tr.after(detail); tr.classList.add('shown');
      });
    }
  });
  t.appendChild(tb); wrap.appendChild(t); host.appendChild(wrap);
  if(note)host.appendChild(el('p','fin-note',note));
}
// the transactions behind a statement line, newest first (tool: an extra button for each, or nothing)
function finStmtItems(items,cols,cur,tool){
  const box=el('div','fin-stmt-items');
  items.slice().sort(function(a,b){ return b.t.posted-a.t.posted; }).slice(0,200).forEach(function(x){
    const row=el('div','fin-stmt-item');
    row.appendChild(el('span','mono fin-date',finDate(x.t.posted)));
    const what=el('span','fin-desc'); what.appendChild(el('span',null,x.t.description||'(no description)'));
    const raw=[x.t.bank,x.t.memo].filter(Boolean).join(' · ');
    what.appendChild(el('span','fin-sub',(raw?raw+' · ':'')+x.account));
    row.appendChild(what);
    if(tool)row.appendChild(tool(x));
    row.appendChild(el('span','fin-amt'+(x.t.amount>0?' pos':''),(x.t.amount>0?'+':'')+finMoney(x.t.amount,cur)));
    box.appendChild(row);
  });
  if(items.length>200)box.appendChild(el('p','fin-note','And '+(items.length-200)+' more.'));
  return box;
}
function finIncomeTable(host,s,cur,d,onMark){
  const rows=[['head','Income']];
  s.income.forEach(function(r){ rows.push(['line',r.name,r.vals,r.items]); });
  if(!s.income.length)rows.push(['line','No income in these months',null]);
  rows.push(['sub','Total income',s.incomeTotal],['gap'],['head','Fixed costs']);
  s.fixed.forEach(function(r){ rows.push(['line',r.name,r.vals,r.items]); });
  rows.push(['sub','Total fixed costs',s.fixedTotal],['gap'],['head','Variable costs']);
  s.variable.forEach(function(r){ rows.push(['line',r.name,r.vals,r.items]); });
  rows.push(['sub','Total variable costs',s.variableTotal],['gap'],['sub','Total expenses',s.expenseTotal],
    ['total','Net income',s.net],['pct','Savings rate',s.savingsRate]);
  finStmtTable(host,s.cols,rows,cur,'Income statement',
    'Tap a line to see the transactions behind it. Transfers between your accounts, card payments, and buying or selling in an investment account aren’t income or spending. Refunds count against spending.',
    // money in: a "not income" button on each, so a transfer counted as income can be taken out
    function(r){ return s.income.indexOf(s.income.find(function(x){ return x.items===r[3]; }))===-1?null:function(x){ return finIncomeTag(x.t,'income',onMark); }; });
}
function finBalanceTable(host,b,cur){
  const rows=[['head','Assets']];
  if(b.cash.length){ rows.push(['subhead','Cash']); b.cash.forEach(function(r){ rows.push(['line',r.name,r.vals]); }); rows.push(['sub','Total cash',b.cashTotal]); }
  if(b.investments.length){ rows.push(['subhead','Investments']); b.investments.forEach(function(r){ rows.push(['line',r.name,r.vals]); }); rows.push(['sub','Total investments',b.investTotal]); }
  rows.push(['sub','Total assets',b.assetTotal],['gap'],['head','Liabilities']);
  b.liabilities.forEach(function(r){ rows.push(['line',r.name,r.vals]); });
  if(!b.liabilities.length)rows.push(['line','Nothing owed',null]);
  rows.push(['sub','Total liabilities',b.liabilityTotal],['gap'],['total','Net worth',b.netWorth]);
  finStmtTable(host,b.cols,rows,cur,'Balance sheet',
    'Earlier balances are worked back from today’s using the transactions in between. Investment accounts also move with the market, so their earlier values are rougher.');
}

/* ── the cost charts ── */
const FIN_KINDS={fixed:'fixed',variable:'variable',skip:'not spending'};
// fixed: each monthly bill as a bar, biggest first; the small ones fold into one
function finFixedChart(c,cur){
  const box=el('div','fin-card fin-chart');
  box.appendChild(el('h3',null,'Fixed costs'));
  box.appendChild(el('p','fin-note',c.fixed.length?'About '+finMoney(c.fixedTotal,cur)+' a month in bills that come back every month.':'No monthly bills found yet. Tag a charge as fixed in the list below.'));
  const rows=c.fixed.slice(0,8);
  if(c.fixed.length>8){ const rest=c.fixed.slice(8); rows.push({name:rest.length+' smaller bills',monthly:rest.reduce(function(s,f){ return s+f.monthly; },0),many:rest}); }
  const top=Math.max.apply(null,rows.map(function(f){ return f.monthly; }).concat([1]));
  rows.forEach(function(f){
    const r=el('div','fin-hbar');
    r.title=f.many?f.many.map(function(x){ return x.name+': '+finMoney(x.monthly,cur); }).join('\n'):f.name+': about '+finMoney(f.monthly,cur)+' a month, last charged '+finDate(f.last/1000);
    r.appendChild(el('span','fin-hbar-name',f.name));
    const track=el('span','fin-hbar-track'), b=el('span','fin-hbar-fill');
    b.style.width=Math.max(2,f.monthly/top*100)+'%'; track.appendChild(b); r.appendChild(track);
    r.appendChild(el('span','fin-amt',finMoney(f.monthly,cur)));
    box.appendChild(r);
  });
  return finFoldable(box,'fixed','Fixed costs',c.fixed.length?finMoney(c.fixedTotal,cur)+'/mo':'');
}
// variable: what everything else came to, month by month; this month is still going
function finVariableChart(c,cur){
  const box=el('div','fin-card fin-chart');
  box.appendChild(el('h3',null,'Variable costs'));
  const full=c.months.filter(function(m){ return !m.partial&&m.total>0; });
  const avg=full.length?full.reduce(function(s,m){ return s+m.total; },0)/full.length:0;
  box.appendChild(el('p','fin-note',avg?'Everything else you bought: about '+finMoney(avg,cur)+' in a usual month.':'Everything else you bought, month by month.'));
  const top=Math.max.apply(null,c.months.map(function(m){ return m.total; }).concat([1]));
  const peak=c.months.reduce(function(p,m){ return m.total>p.total?m:p; },c.months[0]);
  const cols=el('div','fin-cols');
  c.months.forEach(function(m){
    const col=el('div','fin-col'+(m.partial?' partial':''));
    col.title=m.label+(m.partial?' so far':'')+': '+finMoney(m.total,cur);
    const stack=el('div','fin-col-plot');
    if(m.partial||m===peak)stack.appendChild(el('span','fin-col-val',finMoney(Math.round(m.total),cur).replace(/\.00$/,'')+(m.partial?' so far':'')));
    const b=el('span','fin-col-fill'); b.style.height=(m.total?Math.max(2,m.total/top*100):0)+'%'; stack.appendChild(b);
    col.appendChild(stack);
    col.appendChild(el('span','mono fin-col-label',m.label));
    cols.appendChild(col);
  });
  box.appendChild(cols);
  return finFoldable(box,'variable','Variable costs',avg?finMoney(avg,cur)+'/mo':'');
}
// on a charge: how it counts; a tap moves every charge from that payee to the next kind
function finKindTag(t,kind,redraw){
  const b=el('button','mono fin-kind '+kind,FIN_KINDS[kind]);
  const key=costKey(t);
  b.title='Counts as '+FIN_KINDS[kind]+'. Tap to change it for every charge from “'+key+'”.';
  b.addEventListener('click',async function(e){
    e.stopPropagation();
    const next=kind==='fixed'?'variable':kind==='variable'?'skip':'fixed';
    const r=await finApi.financeSetKind(key,next).catch(function(err){ return {ok:false,error:err.message}; });
    if(!r.ok){ if(r.error==='locked'){ fin.data=null; renderFinance(); } return; }
    fin.data.kinds=r.kinds; redraw();
  });
  return b;
}

// on money in: whether it counts as income; a tap changes it for everything in from that payee
function finIncomeTag(t,kind,redraw){
  const b=el('button','mono fin-kind '+(kind==='income'?'fixed':'skip'),kind==='income'?'income':'not income');
  const key='in:'+costKey(t);
  b.title=(kind==='income'?'Counts as income':'Doesn’t count as income (money moving between your accounts)')+'. Tap to change it for everything in from “'+costKey(t)+'”.';
  b.addEventListener('click',async function(e){
    e.stopPropagation();
    const r=await finApi.financeSetKind(key,kind==='income'?'skip':'income').catch(function(err){ return {ok:false,error:err.message}; });
    if(!r.ok){ if(r.error==='locked'){ fin.data=null; renderFinance(); } return; }
    fin.data.kinds=r.kinds; if(redraw)redraw();
  });
  return b;
}

// Windows Hello on or off (on: the key is kept, sealed by Windows, for Hello to open; off: deleted)
function finHelloFold(on){
  const fold=el('details','fin-fold');
  fold.appendChild(el('summary','mono','windows hello: '+(on?'on':'off')));
  fold.appendChild(el('p','fin-note',on?'Finance opens with your Windows PIN, fingerprint or face, and your passphrase still works. Turning this off means only the passphrase opens it.'
    :'Turn this on to open Finance with your Windows PIN, fingerprint or face instead of typing your passphrase.'));
  const b=el('button',on?'ghost mono':'btn-accent',on?'turn off':'Turn on Windows Hello');
  b.addEventListener('click',async function(){
    b.disabled=true;
    const r=await finApi.financeSetHello(!on).catch(function(e){ return {ok:false,error:e.message}; });
    finSay(r.ok?(!on?'Windows Hello will open Finance next time.':'Only your passphrase opens Finance now.'):r.error,!r.ok);
    fin.data.hello=r.hello; renderFinance();
  });
  fold.appendChild(b);
  return fold;
}

// the phone gets its own copy of Finance from a QR code shown here (mobile/finance-phone.js)
function finPairFold(){
  const fold=el('details','fin-fold');
  fold.appendChild(el('summary','mono','pair your phone'));
  fold.appendChild(el('p','fin-note','Open Finance in the Tasks app on your phone, tap Scan, and point it at the code. The phone then gets your accounts from SimpleFIN itself and opens them with your fingerprint. Anyone who scans this code can read your bank accounts, so only show it to your own phone. It hides after 2 minutes.'));
  const go=el('button','btn-accent','Show the code');
  const box=el('div','fin-qr'); box.hidden=true;
  let timer=null;
  const hide=function(){ clearTimeout(timer); box.innerHTML=''; box.hidden=true; go.hidden=false; };
  go.addEventListener('click',async function(){
    go.disabled=true;
    const r=await finApi.financePairCode().catch(function(e){ return {ok:false,error:e.message}; });
    go.disabled=false;
    if(!r.ok){ finSay(r.error,true); return renderFinance(); }
    box.innerHTML=r.svg; // made in the main process by the qrcode package from the payload
    box.hidden=false; go.hidden=true;
    const done=el('button','ghost mono','hide the code'); done.addEventListener('click',hide); box.appendChild(done);
    timer=setTimeout(hide,120000);
  });
  fold.addEventListener('toggle',function(){ if(!fold.open)hide(); });
  fold.appendChild(go); fold.appendChild(box);
  return fold;
}

/* ── unlocked: balances, this month, transactions ── */
function drawFinMain(v){
  const d=fin.data; v.textContent='';
  const bar=el('div','fin-bar');
  bar.appendChild(el('span','mono fin-ago',finAgo(d.fetchedAt)+' · '+finMailWord(d.mail)));
  const refresh=el('button','ghost mono',fin.busy?'refreshing…':'refresh'); refresh.disabled=fin.busy;
  refresh.addEventListener('click',async function(){
    fin.busy=true; drawFinMain(v);
    const r=await finApi.financeRefresh().catch(function(e){ return {ok:false,error:e.message}; });
    fin.busy=false; finSay(r.ok?'':r.error,!r.ok); renderFinance();
  });
  const lockBtn=el('button','ghost mono','lock');
  lockBtn.addEventListener('click',async function(){ finSay(''); await finApi.financeLock(); fin.data=null; renderFinance(); });
  bar.appendChild(refresh); bar.appendChild(lockBtn);
  v.appendChild(bar);
  v.appendChild(finMsgEl());
  (d.errors||[]).forEach(function(m){ v.appendChild(el('p','fin-msg err','From your bank: '+m)); });
  if(!d.accounts.length){ v.appendChild(el('p','empty',d.fetchedAt?'SimpleFIN didn’t send any accounts.':'Nothing downloaded yet. Press refresh.')); return; }

  // totals (in the first account's currency; SimpleFIN gives card debt as a negative balance)
  const cur=d.accounts[0].currency;
  const net=d.accounts.reduce(function(s,a){ return s+a.balance; },0);
  const monthStart=new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  let inM=0,outM=0;
  d.accounts.forEach(function(a){ a.transactions.forEach(function(t){ if(t.pending||t.posted*1000<monthStart)return; if(t.amount>0)inM+=t.amount; else outM-=t.amount; }); });
  const tiles=el('div','fin-tiles');
  [['Net',finMoney(net,cur)],['In this month',finMoney(inM,cur)],['Out this month',finMoney(outM,cur)]].forEach(function(p){
    const t=el('div','fin-tile'); t.appendChild(el('span','mono fin-label',p[0])); t.appendChild(el('b',null,p[1])); tiles.appendChild(t);
  });
  v.appendChild(tiles);

  // accounts by bank
  const accts=el('div','fin-card');
  const byOrg={};
  d.accounts.forEach(function(a){ (byOrg[a.org||'Other']=byOrg[a.org||'Other']||[]).push(a); });
  Object.keys(byOrg).sort().forEach(function(org){
    accts.appendChild(el('div','mono fin-label fin-org',org));
    byOrg[org].forEach(function(a){
      const r=el('div','fin-acct');
      r.appendChild(el('span',null,a.name));
      const amt=el('span','fin-amt'+(a.balance<0?' neg':''),finMoney(a.balance,a.currency));
      if(a.available!=null&&a.available!==a.balance)amt.title='available: '+finMoney(a.available,a.currency);
      r.appendChild(amt); accts.appendChild(r);
    });
  });
  v.appendChild(finFoldable(accts,'accounts','Accounts',d.accounts.length+(d.accounts.length===1?' account':' accounts')));
  v.appendChild(finWorthChart(d.accounts,cur));
  v.appendChild(finStocksCard(cur));

  // fixed and variable costs (finance-costs.js): drawn again when he corrects a payee below
  const costBox=el('div','fin-charts');
  v.appendChild(costBox);
  const allTxs=[];
  d.accounts.forEach(function(a){ a.transactions.forEach(function(t){ allTxs.push(t); }); });
  let costs=null;
  const drawCosts=function(){ costs=costsOf(allTxs,d.kinds); costBox.textContent=''; costBox.appendChild(finFixedChart(costs,cur)); costBox.appendChild(finVariableChart(costs,cur)); };
  drawCosts();

  let stmtCard=null;
  const redrawStatements=function(){ const n=finStatements(d,cur,function(){ redrawAll(); }); if(stmtCard)stmtCard.replaceWith(n); stmtCard=n; };
  const redrawAll=function(){ drawCosts(); drawList(); redrawStatements(); };
  redrawStatements(); v.appendChild(stmtCard);

  // transactions
  let all=[];
  d.accounts.forEach(function(a){ a.transactions.forEach(function(t){ all.push({t:t,a:a}); }); });
  all.sort(function(x,y){ return (y.t.posted||Infinity)-(x.t.posted||Infinity); });
  const filt=el('div','fin-row');
  const q=finInput('search','Search transactions…'); q.value=fin.query;
  const sel=el('select','fin-input fin-select');
  const optAll=el('option',null,'All accounts'); optAll.value=''; sel.appendChild(optAll);
  d.accounts.forEach(function(a){ const o=el('option',null,(a.org?a.org+' · ':'')+a.name); o.value=a.id; sel.appendChild(o); });
  sel.value=fin.account;
  filt.appendChild(q); filt.appendChild(sel);
  const txSection=el('div','fin-section');
  v.appendChild(txSection);
  txSection.appendChild(filt);
  const list=el('div','fin-card fin-txs');
  txSection.appendChild(list);
  const more=el('button','ghost mono','show more');
  txSection.appendChild(more);
  finFoldable(txSection,'transactions','Transactions',all.length+(all.length===1?' transaction':' transactions'));
  // what the Agent bought with it (order-match.js), and everything a search can find in a row
  const agentBought=agentOrders(state.tasks);
  const bought=matchOrders(all.map(function(x){ return x.t; }),agentBought.concat(emailOrders(d.receipts,agentBought)));
  const findable=function(x){
    const m=bought[x.t.id];
    return [x.t.description,x.t.bank,x.t.memo].concat(m?[m.order.title].concat(m.order.items.map(function(it){ return it.name; })):[]).join('\n').toLowerCase();
  };
  const drawList=function(){
    list.textContent='';
    const words=fin.query.toLowerCase();
    const rows=all.filter(function(x){ return (!fin.account||x.a.id===fin.account)&&(!words||findable(x).indexOf(words)!==-1); });
    rows.slice(0,fin.shown).forEach(function(x){
      const r=el('div','fin-tx'+(x.t.pending?' pending':''));
      r.appendChild(el('span','mono fin-date',finDate(x.t.posted)));
      const what=el('span','fin-desc'); what.appendChild(el('span',null,x.t.description||'(no description)'));
      const raw=[x.t.bank,x.t.memo].filter(Boolean).join(' · ');
      if(raw)what.appendChild(el('span','mono fin-bank',raw));
      const sub=el('span','fin-sub',(x.a.org?x.a.org+' · ':'')+x.a.name+(x.t.pending?' · pending':''));
      if(x.t.amount<0)sub.appendChild(finKindTag(x.t,costs.kindOf(x.t),redrawAll));
      else if(x.t.amount>0)sub.appendChild(finIncomeTag(x.t,stmtIncomeKind(x.t,x.a,d.kinds),redrawAll));
      what.appendChild(sub);
      if(bought[x.t.id])what.appendChild(finOrderEl(bought[x.t.id]));
      r.appendChild(what);
      r.appendChild(el('span','fin-amt'+(x.t.amount<0?'':' pos'),(x.t.amount>0?'+':'')+finMoney(x.t.amount,x.a.currency)));
      list.appendChild(r);
    });
    if(!rows.length)list.appendChild(el('p','fin-note','No transactions match.'));
    more.hidden=rows.length<=fin.shown;
  };
  q.addEventListener('input',function(){ fin.query=q.value.trim(); fin.shown=50; drawList(); });
  sel.addEventListener('change',function(){ fin.account=sel.value; fin.shown=50; drawList(); });
  more.addEventListener('click',function(){ fin.shown+=100; drawList(); });
  drawList();

  if(finApi.financeSetHello)v.appendChild(finHelloFold(d.hello));
  if(finApi.financePairCode)v.appendChild(finPairFold());
  v.appendChild(finApi.phone?finForgetFold('remove Finance from this phone','This deletes Finance’s data and fingerprint key on this phone only. Your computer and SimpleFIN keep working, and you can pair again from the computer.')
    :finForgetFold('connection settings','Forgetting deletes the saved bank data and up to a year of history from this computer. To see your accounts again you’d connect with a new SimpleFIN token, starting over at 90 days.'));
}
