/* App state, dates, icons, DOM helpers and sort order.
   One of the page scripts in renderer/js: they share one global scope and load in the order index.html lists them. */
'use strict';

/* ── state ── */
const state={ tasks:[], tombstones:[], ideas:{inbox:{name:'Unsorted',color:'plain',order:-1,updatedAt:0},groups:[],cards:[],tombstones:[]}, hours:{entries:[],tombstones:[]}, health:{days:{}}, kitchen:{items:[],recipes:[],tombstones:[]}, filter:null, wsFilter:null, search:'', selectedId:null, showDone:false, confirmClear:false, expanded:new Set(), activeTab:'list', calYear:new Date().getFullYear(), calMonth:new Date().getMonth() };
let navOrder=[]; // ids of open tasks in rendered order, for arrow-key navigation
// unsent answers to Claude, by task id — kept on disk so a restart or a lost task never eats them
const DRAFTS_KEY='tasks.replyDrafts';
const replyDrafts=(function(){ try{ return JSON.parse(localStorage.getItem(DRAFTS_KEY))||{}; }catch(e){ return {}; } })();
function saveDrafts(){ try{ localStorage.setItem(DRAFTS_KEY,JSON.stringify(replyDrafts)); }catch(e){} }
const prefersReduced=window.matchMedia('(prefers-reduced-motion:reduce)').matches;
let saveTimer=null;

/* change stamping: compare each task against its last-saved snapshot (minus
   updatedAt) and bump updatedAt only for tasks that actually changed — this is
   what device sync uses to decide which copy of a task wins a merge */
let lastSnap={};
function snapKey(t){ const c=Object.assign({},t); delete c.updatedAt; return JSON.stringify(c); }
function rebuildSnap(){ lastSnap={}; state.tasks.forEach(function(t){ lastSnap[t.id]=snapKey(t); }); }
function stampChanges(){
  const now=Date.now(); const seen={};
  state.tasks.forEach(function(t){
    const k=snapKey(t);
    if(lastSnap[t.id]!==k){ t.updatedAt=now; lastSnap[t.id]=k; }
    seen[t.id]=1;
  });
  Object.keys(lastSnap).forEach(function(id){ if(!seen[id])delete lastSnap[id]; });
}
function currentDoc(){ return {v:1,tasks:state.tasks,tombstones:state.tombstones,ideas:state.ideas,hours:state.hours,health:state.health,kitchen:state.kitchen}; }
function persist(){
  if(state.loadFailed){ voiceToast('Not saved: your tasks file couldn’t be read at start-up. Restart Romulus.',true); return; }
  clearTimeout(saveTimer);
  saveTimer=setTimeout(function(){ stampChanges(); store.save(currentDoc()); schedulePush(); if(typeof billAlerts==='function')billAlerts(); },200);
}
function touch(){ persist(); renderActive(); }
// a phone or tablet: fingers, and a keyboard that comes and goes on screen
function touchDevice(){ return !!window.Capacitor||matchMedia('(pointer:coarse)').matches; }
function renderActive(){ if(state.activeTab==='calendar') renderCal(); else if(state.activeTab==='ideas') renderIdeas(); else if(state.activeTab==='hours') renderHours(); else if(state.activeTab==='health') renderHealth(); else if(state.activeTab==='kitchen') renderKitchen(); else if(state.activeTab==='family') renderFamily(); else if(state.activeTab==='finance') return; else render(); }
/* tabs that aren't lists (no composer, no list view) */
function isViewTab(tab){ return tab==='ideas'||tab==='hours'||tab==='kitchen'||tab==='finance'||tab==='health'||tab==='family'; }
function uid(){ return (window.crypto&&crypto.randomUUID)?crypto.randomUUID():'t'+Date.now().toString(36)+Math.random().toString(36).slice(2,8); }

/* ── dates ── */
function todayStart(){ const d=new Date(); d.setHours(0,0,0,0); return d; }
function fmtTime(time){
  const p=time.split(':').map(Number);
  const d=new Date(); d.setHours(p[0],p[1],0,0);
  return d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}).replace(/\s/,' '); // "5:30 PM" (a plain space, not the narrow one some locales give)
}
function dateInfo(due,time){
  const p=due.split('-').map(Number);
  const dt=new Date(p[0],p[1]-1,p[2]);
  const diff=Math.round((dt-todayStart())/864e5);
  const suffix=time?' '+fmtTime(time):'';
  if(diff<0)  return{text:'Overdue '+(-diff)+'d'+suffix,cls:'late',diff:diff};
  if(diff===0)return{text:'Today'+suffix,cls:'today',diff:diff};
  if(diff===1)return{text:'Tomorrow'+suffix,cls:'soon',diff:diff};
  if(diff<7)  return{text:dt.toLocaleDateString('en-GB',{weekday:'short'})+suffix,cls:'',diff:diff};
  return{text:dt.toLocaleDateString('en-GB',{day:'numeric',month:'short'})+suffix,cls:'',diff:diff};
}

/* ── icons ── */
const I={
  coach:'<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1.2" y="3.4" width="6.6" height="5.2" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M7.8 5.4l3-1.6v4.4l-3-1.6" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  legion:'<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1.5 1.5l7 7M10.5 1.5l-7 7M7.5 9.5l2 -2M4.5 9.5l-2-2M8.6 8.6l1.9 1.9M3.4 8.6l-1.9 1.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  check:'<svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 6.5L4.8 9.2 10 3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  x:    '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  pen:  '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M8.5 1.8l1.7 1.7L4 9.7l-2.3.6.6-2.3 6.2-6.2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  chev: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cal:  '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><rect x="1" y="2" width="10" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M1 5h10" stroke="currentColor" stroke-width="1.3"/><path d="M4 1v2M8 1v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  snooze:'<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="4.7" stroke="currentColor" stroke-width="1.3"/><path d="M6 3.8V6l1.8 1.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bot:  '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><rect x="1.8" y="3.8" width="8.4" height="6.4" rx="1.6" stroke="currentColor" stroke-width="1.3"/><path d="M6 1.4v2.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="4.4" cy="7" r=".9" fill="currentColor"/><circle cx="7.6" cy="7" r=".9" fill="currentColor"/></svg>',
  mic:  '<svg width="13" height="13" viewBox="0 0 12 12" fill="none"><rect x="4.1" y="1" width="3.8" height="6.4" rx="1.9" stroke="currentColor" stroke-width="1.3"/><path d="M2.4 5.8a3.6 3.6 0 0 0 7.2 0M6 9.4V11M4.2 11h3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  stop: '<svg width="11" height="11" viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7" rx="1.2" fill="currentColor"/></svg>',
  human:'<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="3.8" r="2.1" stroke="currentColor" stroke-width="1.3"/><path d="M2 10.8c.5-2.1 2.1-3.3 4-3.3s3.5 1.2 4 3.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'
};

/* ── dom helpers ── */
const $=function(id){ return document.getElementById(id); };
function el(tag,cls,text){ const n=document.createElement(tag); if(cls)n.className=cls; if(text!==undefined)n.textContent=text; return n; }
function iconBtn(svg,label,extraCls){ const b=el('button','icon'+(extraCls?' '+extraCls:'')); b.innerHTML=svg; b.setAttribute('aria-label',label); return b; }

/* ── sort key: overdue, then today, then undated, then tomorrow onward.
   A 'pin' (a place set by hand, from the drag-to-reorder of older versions) still wins, so a task someone moved stays put. ── */
function getSortKey(t){
  if(t.pin!=null) return t.pin;
  if(t.due){
    const p=t.due.split('-').map(Number); const dt=new Date(p[0],p[1]-1,p[2]);
    if(t.dueTime){ const tm=t.dueTime.split(':').map(Number); dt.setHours(tm[0],tm[1],0,0); }
    return dt.getTime();
  }
  // undated: in the last minute of today — after today's tasks (latest time 23:59), before
  // tomorrow's — oldest first (creation time squeezed into that minute, ~1s apart still distinct)
  const tomorrow=todayStart(); tomorrow.setDate(tomorrow.getDate()+1);
  const slot=Math.min(58000,Math.max(0,((t.created||0)-1.7e12)/4e11*58000));
  return tomorrow.getTime()-59000+slot;
}

