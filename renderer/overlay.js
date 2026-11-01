/* The screen helper's page (main/overlay.js): his question, the picture of his screen, the answers.
   A chat lasts until he starts a new one; nothing is saved. Answers are drawn as DOM nodes (markdown.js),
   never through innerHTML. */
'use strict';
function el(tag,cls,text){ const n=document.createElement(tag); if(cls)n.className=cls; if(text!==undefined)n.textContent=text; return n; }
function openExternal(url){ window.open(url); } // main/overlay.js sends web links to the browser
const $=function(id){ return document.getElementById(id); };
let history=[], busy=false, st=null;

function draw(s){
  st=s;
  $('laneCloud').classList.toggle('on',s.lane==='cloud');
  $('laneLocal').classList.toggle('on',s.lane==='local');
  $('laneCloud').disabled=!s.cloud&&s.lane!=='cloud';
  $('laneLocal').disabled=!s.local&&s.lane!=='local';
  $('hidden').checked=!!s.hidden;
  $('shotImg').hidden=!s.shot;
  if(s.shot)$('shotImg').src=s.shot;
  $('shotLabel').hidden=!s.shot;
  $('shotNote').textContent=s.shotNote||'';
  $('keyHint').textContent=s.shortcut;
}

// an answer: ``` blocks as code (with Copy), the rest as markdown
function answerNode(text){
  const box=el('div','a');
  String(text).split(/```[^\n]*\n?/).forEach(function(part,i){
    if(i%2){
      const pre=el('pre'), code=el('code',null,part.replace(/\n$/,'')), copy=el('button',null,'Copy');
      copy.type='button';
      copy.addEventListener('click',function(){ navigator.clipboard.writeText(code.textContent).then(function(){ copy.textContent='Copied'; setTimeout(function(){ copy.textContent='Copy'; },1200); }); });
      pre.appendChild(code); pre.appendChild(copy); box.appendChild(pre);
    } else if(part.trim()) box.appendChild(richText(part.trim()));
  });
  return box;
}
function add(node){ $('empty').hidden=true; $('chat').appendChild(node); $('chat').scrollTop=$('chat').scrollHeight; return node; }

async function ask(){
  const question=$('q').value.trim();
  if(busy||(!question&&history.length))return;
  busy=true; $('send').disabled=true;
  add(el('div','q',question||'What’s on my screen?'));
  $('q').value='';
  const wait=add(el('div','a wait',st&&st.lane==='local'?'Lupa is looking…':'Thinking…'));
  // the picture goes with the first question of a chat, and again after a Retake
  const withShot=$('withShot').checked&&!!(st&&st.shot)&&!shotSent;
  let r;
  try { r=await window.helper.ask({question:question,withShot:withShot,history:history}); }
  catch(e){ r={why:String(e&&e.message||e)}; }
  wait.remove();
  if(r.text){
    if(withShot)shotSent=true;
    const a=add(answerNode(r.text));
    a.appendChild(el('div','via',r.via+(withShot?' · saw your screen':'')));
    history.push({q:question,a:r.text});
  } else add(el('div','a bad',r.why||'No answer.'));
  busy=false; $('send').disabled=false; $('q').focus();
}
let shotSent=false;

function newChat(){
  history=[]; shotSent=false;
  $('chat').querySelectorAll('.q,.a').forEach(function(n){ n.remove(); });
  $('empty').hidden=false;
}

$('form').addEventListener('submit',function(e){ e.preventDefault(); ask(); });
$('q').addEventListener('keydown',function(e){ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); ask(); } });
$('q').addEventListener('input',function(){ this.style.height='38px'; this.style.height=Math.min(120,this.scrollHeight)+'px'; });
document.addEventListener('keydown',function(e){ if(e.key==='Escape')window.helper.close(); });
$('close').addEventListener('click',function(){ window.helper.close(); });
$('laneCloud').addEventListener('click',function(){ window.helper.set({lane:'cloud'}).then(draw); });
$('laneLocal').addEventListener('click',function(){ window.helper.set({lane:'local'}).then(draw); });
$('hidden').addEventListener('change',function(){ window.helper.set({hidden:this.checked}).then(draw); });
$('retake').addEventListener('click',function(){ window.helper.retake().then(function(s){ shotSent=false; $('withShot').checked=true; draw(s); }); });
$('shotImg').addEventListener('click',function(){ $('withShot').checked=!$('withShot').checked; });
$('newChat').addEventListener('click',newChat);
$('openApp').addEventListener('click',function(){ window.helper.openApp(); });
// each time it opens: a fresh picture, so a fresh chat about it
window.helper.onOpened(function(s){ newChat(); $('withShot').checked=true; draw(s); $('q').focus(); });
window.helper.state().then(draw);
