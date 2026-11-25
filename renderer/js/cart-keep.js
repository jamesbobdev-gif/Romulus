/* What an Agent answer does to a task's cart (agent-results.js applies it). The cart stays on the task
   until the order is really placed, so a follow-up about it ("add more protein"), a question, or another
   AI taking over (ChatGPT, Gemini, Lupa) never wipes his picks or counts as an order.
   One of the page scripts in renderer/js: they share one global scope. */
'use strict';

// a plain go-ahead to the order ("yes", "ok, place it"), not a question or a "yes, but swap the milk"
function orderYesReply(text){
  const s=String(text||'').trim().slice(0,240);
  if(!s||/\?/.test(s))return false;
  return /^(yes|yep|yeah|yup|y|ok(ay)?|sure|go( ahead)?|do it|place (it|the order)|order it|confirm(ed)?)\b/i.test(s)&&
    !/\b(but|wait|don'?t|not yet|hold|instead|without|swap|change|add|remove)\b/i.test(s);
}
/* t: the task before this answer; u: the answer; asked: the note his reply answered; his: that reply.
   placed: the order went through (it marked what was bought, or it finished right after his yes to
   "Reply yes to place this order"). cart: 'new' (the answer brought one), 'clear' (placed), 'keep'. */
function cartOutcome(t,u,asked,his){
  const had=Array.isArray(t.cart)&&t.cart.length>0;
  const bought=!!(u.list&&Array.isArray(u.list.bought)&&u.list.bought.length);
  const placed=bought||(had&&u.status==='done'&&/reply\s*\**\s*yes/i.test(String(asked||''))&&orderYesReply(his));
  const fresh=Array.isArray(u.cart)&&u.cart.length>0;
  return {placed:placed,cart:fresh?'new':placed?'clear':'keep'};
}

if(typeof module!=='undefined'&&module.exports)module.exports={orderYesReply,cartOutcome};
