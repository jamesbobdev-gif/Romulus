/* Finance tab (desktop only): his bank accounts through SimpleFIN, read-only (main/finance.js keeps them
   encrypted behind his passphrase). Bank text is shown with textContent only, never as HTML, and this page
   drops its copy of the data when he leaves the tab or it locks.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

const fin={ data:null, query:'', account:'', shown:50, busy:false, msg:'', msgErr:false };
const finApi=window.desktop&&window.desktop.financeStatus?window.desktop:null;
if(finApi){
  $('tabFinance').hidden=false;
  finApi.onFinanceLocked(function(){ fin.data=null; if(state.activeTab==='finance')renderFinance(); });
}
function financeLeave(){ fin.data=null; fin.query=''; fin.account=''; fin.shown=50; fin.msg=''; const v=$('financeView'); if(v)v.textContent=''; }

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

/* ── first time: SimpleFIN setup token + a passphrase ── */
function drawFinSetup(v,st){
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
  box.appendChild(el('p','fin-note','The passphrase isn’t saved anywhere and nobody can reset it. If you forget it, choose Forget and connect again with a new token. SimpleFIN can only read your accounts. It can’t move money.'));
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

/* ── locked ── */
function drawFinLocked(v,st){
  v.textContent='';
  const box=el('div','fin-card fin-lock');
  box.appendChild(el('h3',null,'Finance is locked'));
  box.appendChild(el('p','fin-note','It locks after 10 minutes without use, when the screen locks, and when the computer sleeps.'));
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
  const row=el('div','fin-row'); row.appendChild(pass); row.appendChild(go); box.appendChild(row);
  if(st.waitSeconds&&!fin.msg)finSay('Too many wrong tries. Wait '+st.waitSeconds+' seconds.',true);
  box.appendChild(finMsgEl());
  const forget=el('button','ghost mono danger','forgot it? forget this connection');
  forget.addEventListener('click',finForget);
  box.appendChild(forget);
  v.appendChild(box);
  pass.focus();
}
async function finForget(){
  if(!confirm('Delete the saved bank data and SimpleFIN link from this computer?\n\nAlso disable the connection on bridge.simplefin.org.'))return;
  await finApi.financeForget(); finSay('Forgotten. Remember to disable it on bridge.simplefin.org too.'); renderFinance();
}

/* ── unlocked: balances, this month, transactions ── */
function drawFinMain(v){
  const d=fin.data; v.textContent='';
  const bar=el('div','fin-bar');
  bar.appendChild(el('span','mono fin-ago',finAgo(d.fetchedAt)));
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
  v.appendChild(accts);

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
  v.appendChild(filt);
  const list=el('div','fin-card fin-txs');
  v.appendChild(list);
  const more=el('button','ghost mono','show more');
  v.appendChild(more);
  const drawList=function(){
    list.textContent='';
    const words=fin.query.toLowerCase();
    const rows=all.filter(function(x){ return (!fin.account||x.a.id===fin.account)&&(!words||x.t.description.toLowerCase().indexOf(words)!==-1); });
    rows.slice(0,fin.shown).forEach(function(x){
      const r=el('div','fin-tx'+(x.t.pending?' pending':''));
      r.appendChild(el('span','mono fin-date',finDate(x.t.posted)));
      const what=el('span','fin-desc'); what.appendChild(el('span',null,x.t.description||'(no description)'));
      what.appendChild(el('span','fin-sub',(x.a.org?x.a.org+' · ':'')+x.a.name+(x.t.pending?' · pending':'')));
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

  const forget=el('button','ghost mono danger fin-forget','forget this connection');
  forget.addEventListener('click',finForget);
  v.appendChild(forget);
}
