/* Which bank charge paid for which Agent order, so the Finance tab can show what a purchase was for.
   Orders are what the Agent placed (t.orders, kept by grocery-list.js keepLastOrder: items, total, store),
   and the receipts in his email (main/finance-mail.js, kept in the finance vault).
   A charge matches an order from the same store, charged from a day before it to two weeks after (Amazon
   charges when it ships), for about its total. One charge, one order. A charge from that store for less
   than the total (an EBT split, one of Amazon's shipments) still matches, as a "maybe".
   Everything happens on this page: the bank data never goes to the Agent, and orders never go to the bank.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them.
   Also loaded by test/order-match.test.js, so it uses no page globals. */
'use strict';

const ORDER_STORES=[['amazon',/amzn|amazon/i],['walmart',/wal-?mart|\bwm\s?super/i],['instacart',/instacart/i],['target',/\btarget\b/i],['costco',/costco/i],['kroger',/kroger/i],['aldi',/\baldi\b/i]];
const ORDER_DAY=86400000;

function orderMoney(v){
  if(typeof v==='number')return Number.isFinite(v)?v:0;
  const m=String(v==null?'':v).replace(/,/g,'').match(/(\d+(?:\.\d+)?)/);
  return m?Number(m[1]):0;
}
// "Total with tax and shipping: $54.21", "total $80.10 ($60 EBT…)", "about $41": the first one in the note
function orderTotalFrom(note){
  const s=String(note||'').replace(/,/g,'');
  const m=s.match(/total[^$\n]{0,40}?\$\s?(\d+(?:\.\d{1,2})?)/i)||s.match(/\babout \$\s?(\d+(?:\.\d{1,2})?)/i);
  return m?Number(m[1]):undefined;
}
/* the EBT part of an order, from the Agent's note, for the Finance tab's EBT wallet (finance-ebt.js):
   {ebt: what went on EBT, left: the EBT balance after it}, either one maybe missing.
   "Total $80.10 ($60.00 EBT, $20.10 Visa). EBT balance $143.20" → {ebt: 60, left: 83.2}. A balance checkout
   shows is from before the order, unless the note says it's what's left ("EBT left: $83.20", "$83.20 left on EBT") */
function orderEbtFrom(note){
  let s=String(note||'').replace(/,/g,'');
  const out={}; let before=null;
  const bal=s.match(/\bEBT(?:\s*card)?\s*(balance|left|remaining)\s*(after|left|remaining|now)?\s*(?:is|of)?\s*:?\s*\$\s?(\d+(?:\.\d{1,2})?)/i);
  const left=!bal&&s.match(/\$\s?(\d+(?:\.\d{1,2})?)\s*(?:left|remaining)\s*on\s*(?:your\s*|his\s*|the\s*)?EBT/i);
  if(bal){ const n=Number(bal[3]); if(/left|remaining/i.test(bal[1])||bal[2])out.left=n; else before=n; s=s.replace(bal[0],' '); }
  else if(left){ out.left=Number(left[1]); s=s.replace(left[0],' '); }
  // "$60.00 EBT", "$60 on EBT", "$60 paid with EBT", "EBT: $60", "EBT pays $60" (not an item's "$3.98 EBT eligible")
  const paid=s.match(/\$\s?(\d+(?:\.\d{1,2})?)\s*(?:(?:paid\s*)?(?:on|with|by|from|to)\s*)?(?:your\s*|his\s*|the\s*)?(?:EBT|SNAP)\b(?![\s-]*eligible)/i)
    ||s.match(/\b(?:EBT|SNAP)(?:\s*card)?\s*(?:pays|paid|covers|covered|part|portion)?\s*:?\s*\$\s?(\d+(?:\.\d{1,2})?)/i);
  if(paid)out.ebt=Number(paid[1]);
  if(before!=null)out.left=Math.round((before-(out.ebt||0))*100)/100;
  return out;
}
// the store, from the items' links (amazon.com, walmart.com, instacart.com…), else the task's title
function orderStore(items,title){
  const hosts=(items||[]).map(function(it){ try{ return new URL(it.url).hostname; }catch(e){ return ''; } }).join(' ');
  const hit=ORDER_STORES.find(function(s){ return s[1].test(hosts); })||ORDER_STORES.find(function(s){ return s[1].test(title||''); });
  if(hit)return hit[0];
  const h=hosts.split(' ').filter(Boolean)[0];
  return h?h.replace(/^www\./,'').split('.').slice(-2)[0]:'';
}
function orderStoreTest(store){
  const s=ORDER_STORES.find(function(x){ return x[0]===store; });
  return s?s[1]:store?new RegExp('\\b'+store.replace(/[^a-z0-9]/gi,'')+'\\b','i'):null;
}
// every order the Agent kept, newest first: t.orders, plus an older task's single lastOrder
function agentOrders(tasks){
  const out=[];
  (tasks||[]).forEach(function(t){
    if(!t||t.ws!=='agent')return;
    const list=Array.isArray(t.orders)?t.orders.slice():[];
    if(t.lastOrder&&!list.some(function(o){ return o.at===t.lastOrder.at; }))list.push(t.lastOrder);
    list.forEach(function(o){
      if(!o||!Array.isArray(o.items)||!o.items.length)return;
      out.push({key:t.id+':'+(o.at||0),task:t.id,title:t.title||'',at:o.at||0,items:o.items,
        total:o.total||undefined,store:o.store||orderStore(o.items,t.title),
        ebt:o.ebt>0?o.ebt:undefined,ebtLeft:typeof o.ebtLeft==='number'&&o.ebtLeft>=0?o.ebtLeft:undefined});
    });
  });
  return out.sort(function(a,b){ return b.at-a.at; });
}
// purchase emails (main/finance-mail.js) as orders too, except one the Agent's own order already covers
// (Amazon emails about the order the Agent placed): same store, about the same total, within 3 days
function emailOrders(receipts,agent){
  return (receipts||[]).filter(function(r){
    return r&&r.store&&!(agent||[]).some(function(o){ return o.store===r.store&&Math.abs(o.at-r.at)<3*ORDER_DAY&&(!o.total||!r.total||Math.abs(o.total-r.total)<1); });
  }).map(function(r){
    return {key:'mail:'+r.id,task:null,email:true,title:r.merchant||r.store,at:r.at,items:Array.isArray(r.items)?r.items:[],total:r.total||undefined,store:r.store};
  });
}
// txs: [{id, posted (seconds, 0 = pending), amount, description, bank, memo}] → {txId: {order, sure}}
function matchOrders(txs,orders,now){
  now=now||Date.now();
  const pairs=[];
  (orders||[]).forEach(function(o){
    const re=orderStoreTest(o.store); if(!re)return;
    const want=o.total||o.items.reduce(function(s,it){ return s+orderMoney(it.price); },0);
    const tol=o.total?Math.max(1,want*0.03):Math.max(3,want*0.25);
    (txs||[]).forEach(function(t){
      if(!(t.amount<0))return;
      const when=t.posted?t.posted*1000:now;
      if(when<o.at-ORDER_DAY||when>o.at+14*ORDER_DAY)return;
      if(!re.test([t.description,t.bank,t.memo].join(' ')))return;
      const paid=-t.amount, days=Math.abs(when-o.at)/ORDER_DAY;
      if(want&&Math.abs(paid-want)<=tol)pairs.push({t:t.id,o:o,sure:true,score:Math.abs(paid-want)+days/100});
      else if(!want||paid<want)pairs.push({t:t.id,o:o,sure:false,score:500+days});
    });
  });
  pairs.sort(function(a,b){ return a.score-b.score; });
  const out={}, used={};
  pairs.forEach(function(p){ if(out[p.t]||used[p.o.key])return; out[p.t]={order:p.o,sure:p.sure}; used[p.o.key]=true; });
  return out;
}

if(typeof module!=='undefined'&&module.exports){ module.exports={orderTotalFrom:orderTotalFrom,orderEbtFrom:orderEbtFrom,orderStore:orderStore,agentOrders:agentOrders,emailOrders:emailOrders,matchOrders:matchOrders}; }
