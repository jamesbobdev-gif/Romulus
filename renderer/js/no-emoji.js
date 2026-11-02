/* No emoji on screen: he doesn't want them. The app's own words have none; this catches the ones that come in
   from elsewhere (an AI's note or reply, a page or product title, a site's name) as they're drawn, on the
   computer, the phone and the screen helper. Text arrows (↗ ↪) and © ® stay; what he's typing isn't touched.
   Loaded first, before the page scripts (it shares their one global scope). */
'use strict';

// a pictograph (with its variation mark, keycap or skin tone) or a flag, and the marks that only make sense with one
const EMOJI_PICTO=/(?:[\u{1F1E6}-\u{1F1FF}]{2}|(?![\u{A9}\u{AE}\u{2197}\u{21AA}])\p{Extended_Pictographic}\u{FE0F}?\u{20E3}?)[\u{1F3FB}-\u{1F3FF}]?/u, EMOJI_MARKS=/[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{200D}\u{FE0F}\u{20E3}]/u;
const NO_EMOJI=new RegExp(EMOJI_PICTO.source+"|"+EMOJI_MARKS.source,"gu");
// a pictograph and one space after it go together, so a sign before "Saved" leaves "Saved", not " Saved"
const unEmoji=function(s){ return String(s).replace(new RegExp('(?:'+EMOJI_PICTO.source+')( (?=\\S))?','gu'),'').replace(new RegExp(EMOJI_MARKS.source,'gu'),''); };
(function(){
  const ATTRS=['title','placeholder','aria-label','alt'];
  const typing=function(n){ const p=n.nodeType===1?n:n.parentElement; return !!(p&&p.closest&&p.closest('textarea,input,[contenteditable=""],[contenteditable="true"],script,style')); };
  const fixText=function(t){ NO_EMOJI.lastIndex=0; if(NO_EMOJI.test(t.data)&&!typing(t))t.data=unEmoji(t.data); };
  const fixAttrs=function(e){ if(e.nodeType!==1||typing(e)&&e.tagName!=='INPUT'&&e.tagName!=='TEXTAREA')return;
    ATTRS.forEach(function(a){ const v=e.getAttribute(a); if(v){ NO_EMOJI.lastIndex=0; if(NO_EMOJI.test(v))e.setAttribute(a,unEmoji(v)); } }); };
  const scrub=function(root){
    if(root.nodeType===3){ fixText(root); return; }
    if(root.nodeType!==1&&root.nodeType!==9)return;
    if(root.nodeType===1)fixAttrs(root);
    const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT|NodeFilter.SHOW_ELEMENT);
    for(let n=w.nextNode();n;n=w.nextNode()){ if(n.nodeType===3)fixText(n); else fixAttrs(n); }
  };
  const start=function(){
    scrub(document.body||document.documentElement);
    if(document.title)document.title=unEmoji(document.title);
    new MutationObserver(function(list){
      list.forEach(function(m){
        if(m.type==='characterData')fixText(m.target);
        else if(m.type==='attributes')fixAttrs(m.target);
        else m.addedNodes.forEach(scrub);
      });
    }).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:ATTRS});
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start); else start();
})();
