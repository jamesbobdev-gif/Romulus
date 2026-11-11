/* The Agent's one "it's going" line, the way Claude Code shows it: a turning star, what it's doing right now
   in a moving shimmer, and how long it's been at it. lists.js builds it into the task's status card; the one
   timer here keeps every line on screen current (the clock, the words, the newest step from the live log)
   without a re-render. The star is drawn, not a character: the emoji filter (no-emoji.js) would eat one. */
'use strict';

const busySince={}; // task id + phase → when it went into that phase (first seen on this screen, or its claim time)
// said in turn while there's nothing newer to show; {who} is the model's name
const BUSY_WORDS={
  routing:['Routing to {who}','Handing it to {who}','Waiting for {who} to pick it up'],
  picking:['Picking a model','Routing it','Working out who does it'],
  working:['{who} is on it','{who} is thinking','{who} is working through it'],
};
const BUSY_SWAP_S=4; // seconds per phrase

function busyStar(){
  const ns='http://www.w3.org/2000/svg';
  const s=document.createElementNS(ns,'svg');
  s.setAttribute('viewBox','-10 -10 20 20'); s.setAttribute('class','busy-star'); s.setAttribute('aria-hidden','true');
  for(let i=0;i<6;i++){
    const l=document.createElementNS(ns,'line');
    l.setAttribute('x1','0'); l.setAttribute('y1','-2.2'); l.setAttribute('x2','0'); l.setAttribute('y2','-8');
    l.setAttribute('transform','rotate('+(i*60)+')');
    s.appendChild(l);
  }
  return s;
}

// phase: 'routing' (queued, has a lane), 'picking' (queued, no lane yet) or 'working'
function busyLine(t,phase,who){
  const key=t.id+':'+phase;
  if(phase==='working'&&t.claimedAt&&t.claimedAt<=Date.now())busySince[key]=t.claimedAt;
  else if(!busySince[key])busySince[key]=Date.now();
  const d=el('div','busy-line');
  d.setAttribute('data-id',t.id); d.dataset.phase=phase; d.dataset.who=who||''; d.dataset.since=String(busySince[key]);
  d.setAttribute('role','status');
  d.setAttribute('aria-label',phase==='working'?(who+' is on it'):phase==='routing'?'Routing to '+who:'Picking a model');
  d.appendChild(busyStar());
  const v=el('span','busy-verb'); v.setAttribute('aria-hidden','true'); d.appendChild(v);
  const m=el('span','busy-meta'); m.setAttribute('aria-hidden','true'); d.appendChild(m);
  busyPaint(d);
  busyTick();
  return d;
}

function busyClock(ms){
  const s=Math.max(0,Math.floor(ms/1000));
  if(s<60)return s+'s';
  const m=Math.floor(s/60);
  if(m<60)return m+'m '+String(s%60).padStart(2,'0')+'s';
  return Math.floor(m/60)+'h '+String(m%60).padStart(2,'0')+'m';
}

// the newest line of what it's doing (agent-results.js streams it into liveText), cleaned up for one line
function busyLatestStep(id){
  if(typeof liveText==='undefined'||!liveText[id])return '';
  const text=typeof liveShown==='function'?liveShown(liveText[id]):String(liveText[id]);
  const lines=text.split('\n').map(function(l){ return l.replace(/^[\s\-–—>*•]+/,'').trim(); }).filter(Boolean);
  let last=lines[lines.length-1]||'';
  last=last.charAt(0).toUpperCase()+last.slice(1);
  return last.length>90?last.slice(0,88).trim()+'…':last;
}

function busyPaint(d){
  const since=Number(d.dataset.since)||Date.now();
  const elapsed=Date.now()-since;
  const phase=d.dataset.phase, who=d.dataset.who||'It';
  let words=phase==='working'?busyLatestStep(d.getAttribute('data-id')):'';
  if(!words){
    const set=BUSY_WORDS[phase]||BUSY_WORDS.working;
    words=set[Math.floor(elapsed/1000/BUSY_SWAP_S)%set.length].replace('{who}',who);
  }
  words+='…';
  const v=d.querySelector('.busy-verb'), m=d.querySelector('.busy-meta');
  if(v&&v.textContent!==words){
    const first=!v.textContent;
    v.textContent=words;
    if(!first){ v.classList.remove('swap'); void v.offsetWidth; v.classList.add('swap'); } // fade the new words in
  }
  const clock=busyClock(elapsed);
  if(m&&m.textContent!==clock)m.textContent=clock;
}

let busyTimer=null;
function busyTick(){
  if(busyTimer)return;
  busyTimer=setInterval(function(){
    const lines=document.querySelectorAll('.busy-line');
    if(!lines.length){ clearInterval(busyTimer); busyTimer=null; return; }
    lines.forEach(busyPaint);
  },1000);
}
