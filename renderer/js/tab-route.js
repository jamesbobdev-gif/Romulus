/* What he says about his health or his kitchen goes to that tab and changes it, instead of becoming a to-do.
   The add box (typed or said) asks tabRoute first (task-actions.js addTask):
     Health
       "I want to walk 10k steps a day" / "my goal is 8 hours of sleep" / "run 30 min every day"
           → a daily goal to-do ("Walk 10,000 steps") that ticks itself off, or the one he has gets the new number
       "160 g of protein a day" / "my calorie goal is 2,200"      → those numbers in the Food plan, the rest kept
       "1 g of protein per pound"                                  → the Agent works it out (meal-plan skill), then
                                                                     it lands in the Food plan
       "I want to bench 225 by March" / "run a half marathon"     → a training goal on the Health tab
     Kitchen
       "I have 2 lb of chicken and rice" / "bought a dozen eggs"  → into the pantry
       "I used the last of the milk" / "the bread is gone"        → out of the pantry (and onto the grocery list)
       "I made the chili" / "made tacos for dinner"               → Made it: what it used comes out of the pantry
       "I loved the chili" / "the tacos were bad"                 → liked, or not
       "I want to make lasagna this week"                         → on the meal plan (its shopping list)
   A question or a request ("make me a running plan", "what can I make with rice?") isn't one of these: it stays
   a task, so the Agent can answer it.
   One of the page scripts in renderer/js (they share one global scope; this loads after health.js and kitchen.js).
   The top half has no DOM in it, so test/tab-route.test.js can load it in Node. */
'use strict';

const TR_H=typeof module!=='undefined'&&module.exports&&typeof healthGoalWords==='undefined'?require('./health'):null;
const TR_K=typeof module!=='undefined'&&module.exports&&typeof parseIngredient==='undefined'?require('./kitchen'):null;
const trGoalWords=function(s){ return (TR_H?TR_H.healthGoalWords:healthGoalWords)(s); };
const trParse=function(s){ return (TR_K?TR_K.parseIngredient:parseIngredient)(s); };
const trSame=function(a,b){ return (TR_K?TR_K.sameFood:sameFood)(a,b); };
const trFmt=function(q,u){ return (TR_K?TR_K.kFmtQty:kFmtQty)(q,u); };

const TR_ASK=/\?\s*$|^\s*(?:what|how|which|why|when|where|who|can|could|should|would|will you|is|are)\b|\b(?:help me|make me|give me|build me|write me|plan me|find|search|look up|suggest|recommend|can you|could you|tell me|show me|order|buy me|book)\b/i;
const TR_INTENT=/\b(?:i want to|i wanna|i(?:'|’)?d like to|i(?:'|’)?m going to|i(?:'|’)?m gonna|i(?:'|’)?ll|i will|i need to|i plan to|i(?:'|’)?m trying to|trying to|try to|my goal|goal is|goal of|goal:|aim(?:ing)? (?:for|to)|shooting for|target|every ?day|each day|a day|per day|daily|a night|every night|each night|nightly)\b/i;
const TR_LEAD=/^\s*(?:(?:so|ok|okay|also|and)\s+)?(?:i want to|i wanna|i(?:'|’)?d like to|i(?:'|’)?m going to|i(?:'|’)?m gonna|i(?:'|’)?ll|i will|i need to|i plan to|i(?:'|’)?m trying to|trying to|my goal is to|my goal is|my goal:|goal:|goal is to|i(?:'|’)?m aiming to|aiming to)\s+/i;
// lifting, running and the rest: a goal he can't track from the phone's numbers
const TR_FIT=/\b(?:bench(?: press)?|squat|deadlift|overhead press|clean and jerk|pull ?-?ups?|chin ?-?ups?|push ?-?ups?|sit ?-?ups?|lift(?:ing)?(?: weights)?|powerlift\w*|1rm|personal (?:best|record)|5 ?k|10 ?k|half ?-?marathon|marathon|ultramarathon|triathlon|(?:go |start |keep )?running|jog(?:ging)?|swimming|swim laps|cycling|gym|work ?out|workouts?|cardio|yoga|pilates|stretch(?:ing)?|mobility|abs|six ?pack|lose \d+ ?(?:lbs?|pounds|kg|kilos)|gain \d+ ?(?:lbs?|pounds|kg|kilos)|body ?fat|muscle|stronger|fitter|in shape)\b|\brun\s+(?:a\s+|an\s+)?(?:\d|mile|marathon|half|more|every|daily|faster|longer|farther|further|two|three|four|five)/i;
// a real goal, not "I need to train the new hire" or "I'll run errands"
const TR_GOAL_LEAD=/\b(?:i want to|i wanna|i(?:'|’)?d like to|i(?:'|’)?m going to|i(?:'|’)?m gonna|i plan to|i(?:'|’)?m trying to|trying to|my goal|goal is|goal of|goal:|aim(?:ing)? (?:for|to)|shooting for)\b/i;
const TR_NOT_FIT=/\b(?:buy|order|purchase|sell|fix|repair|rent|book|watch|cancel|return|clean)\b/i;
const TR_EX_WORD=[['run','Run'],['jog','Jog'],['walk','Walk'],['hike','Hike'],['yoga','Yoga'],['swim','Swim'],['bike','Bike'],['cycle','Cycle'],['lift','Lift'],['gym','Gym'],['pilates','Pilates'],['stretch','Stretch'],['cardio','Cardio']];

const trTidy=function(s){ return String(s||'').replace(/\s+/g,' ').replace(/[\s,.;:!]+$/,'').trim(); };
const trCap=function(s){ return s?s.charAt(0).toUpperCase()+s.slice(1):s; };
const trNum=function(s){ return Number(String(s).replace(/,/g,'')); };

/* ── Health ── */
// a daily goal in his words → {kind, target, title}, the to-do it becomes ("Walk 10,000 steps")
function trDailyGoal(text){
  if(!TR_INTENT.test(text))return null;
  const g=trGoalWords(text); if(!g)return null;
  const s=text.toLowerCase();
  let title;
  if(g.kind==='steps')title='Walk '+g.target.toLocaleString('en-US')+' steps';
  else if(g.kind==='sleep'){ const h=g.target/60; title='Sleep '+(Number.isInteger(h)?h:Math.round(h*10)/10)+' hours'; }
  else {
    const w=TR_EX_WORD.find(function(x){ return new RegExp('\\b'+x[0]).test(s); });
    title=(w?w[1]:'Work out')+' '+g.target+' min';
  }
  return {kind:g.kind,target:g.target,title:title};
}
// numbers for the Food plan → {kcal?, protein?, carbs?, fat?, keep:true}, 'rule' for a per-pound rule, or null
function trMacros(text){
  const s=text.toLowerCase().replace(/[’']/g,'');
  if(/\b(?:per|for every|for each|each|a) (?:pound|lb|kilo|kg)s?\b/.test(s)&&/\b(?:protein|carbs?|fat)\b/.test(s))return 'rule';
  const daily=/\b(?:a day|per day|each day|every day|daily|goal|target|intake|aim|want|eat|eating|hit|get to|budget)\b/.test(s);
  if(!daily||/\b(?:buy|order|get me|pick up|bought)\b/.test(s))return null;
  const out={};
  const key=function(w){ return /^prot/.test(w)?'protein':/^carb/.test(w)?'carbs':/^fat/.test(w)?'fat':'kcal'; };
  let m; const a=/(\d[\d,]*)\s*(?:g|grams?)\s+(?:of\s+)?(protein|carbs?|carbohydrates|fat)\b/g;
  while((m=a.exec(s)))out[key(m[2])]=trNum(m[1]);
  const b=/(\d[\d,]*)\s*(?:calories|kcal|cals?)\b/g;
  while((m=b.exec(s)))out.kcal=trNum(m[1]);
  const c=/\b(protein|carbs?|fat|calories?|calorie|kcal)\s+(?:goal|target|intake|budget)?\s*(?:is|of|to|at|=|:)?\s*(\d[\d,]*)\s*(?:g|grams?|kcal|calories)?\b/g;
  while((m=c.exec(s)))if(out[key(m[1])]==null)out[key(m[1])]=trNum(m[2]);
  const ok={};
  Object.keys(out).forEach(function(k){ const n=Math.round(out[k]); if(k==='kcal'?n>=800&&n<=10000:n>=5&&n<=1000)ok[k]=n; });
  return Object.keys(ok).length?Object.assign(ok,{keep:true}):null;
}
// a training goal → the to-do's title ("Bench 225 by March"), or null
function trTraining(text){
  if(!TR_GOAL_LEAD.test(text)||!TR_FIT.test(text)||TR_NOT_FIT.test(text))return null;
  const title=trCap(trTidy(text.replace(TR_LEAD,'')));
  return title&&title.length<=120?title:null;
}

/* ── Kitchen ── */
const TR_PLACE=/\s+(?:in|into|to|on)\s+(?:the|my|our)\s+(?:pantry|fridge|freezer|kitchen|cupboards?|cabinets?)\s*$/i;
// everyday foods, so "I have eggs" counts without an amount; anything already in the pantry, a recipe or the grocery list does too
const TR_FOODS='egg eggs milk bread butter cheese yogurt cream rice pasta noodles flour sugar oats oatmeal cereal beans lentils chicken beef pork turkey ham bacon sausage steak fish salmon tuna shrimp tofu apple apples banana bananas orange oranges grapes berries strawberries blueberries lemon lemons lime limes avocado avocados tomato tomatoes potato potatoes onion onions garlic carrot carrots celery lettuce spinach broccoli peppers pepper cucumber corn peas mushrooms squash zucchini salsa tortillas chips crackers peanut butter jelly jam honey coffee tea juice soda water oil olive oil vinegar ketchup mustard mayo sauce soup broth stock spices salt cinnamon nuts almonds walnuts popcorn ice cream frozen pizza pizza hot dogs buns bagels muffins cookies chocolate granola protein powder sour cream cream cheese ground beef chicken breast chicken thighs';
const trKnownFood=function(name,known){
  const n=String(name||'').toLowerCase();
  if((known||[]).some(function(k){ return trSame(k,n); }))return true;
  return (' '+TR_FOODS+' ').indexOf(' '+n+' ')!==-1||TR_FOODS.split(' ').some(function(w){ return w.length>3&&trSame(w,n); });
};
// "a dozen eggs" / "a bag of rice": the "a" is one of them
const TR_ONE=/^(?:a|an|one)\s+(?=(?:dozen|bag|box|can|jar|bottle|bunch|loaf|pound|lb|gallon|half gallon|quart|pack|package|head|stick|carton|block|tub)\b)/i;
const trSplit=function(s){ return s.split(/\s*(?:,|\band\b|&|\bplus\b)\s*/i).map(function(x){ return x.trim().replace(TR_ONE,'1 ').replace(/^(?:some|more|the|a|an|any|my|our|of)\s+/i,'').trim(); }).filter(Boolean).slice(0,15); };
// what he has → [{name, qty, unit}], every one a food (else null: "I have a meeting")
function trStock(text,known){
  let m=text.match(/^\s*(?:i|we)\s+(?:just\s+)?(?:have|got|bought|picked up|grabbed|now have|still have|have got|(?:i|we)(?:'|’)?ve got)\s+(?!to\b)(.+?)\s*[.!]?\s*$/i)
    ||text.match(/^\s*(?:i|we)(?:'|’)?ve\s+(?:got|bought|picked up)\s+(.+?)\s*[.!]?\s*$/i)
    ||text.match(/^\s*(?:just\s+)?(?:bought|picked up|grabbed)\s+(.+?)\s*[.!]?\s*$/i) // said without the "I"
    ||text.match(/^\s*there(?:'|’)?s\s+(.+?)\s*[.!]?\s*$/i)
    ||text.match(/^\s*(?:add|put)\s+(.+?)\s+(?:to|in|into)\s+(?:the|my|our)\s+(?:pantry|fridge|freezer|kitchen)\s*[.!]?\s*$/i);
  if(!m)return null;
  let body=m[1]; const placed=TR_PLACE.test(body)||/^\s*(?:add|put)\b/i.test(text);
  body=body.replace(TR_PLACE,'');
  if(/^\s*there/i.test(text)&&!placed)return null; // "there's a game tonight"
  const items=trSplit(body).map(function(x){ return trParse(x); }).filter(Boolean);
  if(!items.length)return null;
  const ok=items.every(function(i){ return i.name.split(' ').length<=4&&(placed||(i.qty!=null&&i.unit)||trKnownFood(i.name,known)); });
  return ok?items:null;
}
// what ran out → [names] (only foods)
function trUsed(text,known){
  const m=text.match(/^\s*(?:i|we)\s+(?:just\s+)?(?:used up|used|finished|ate|drank|threw out|tossed)\s+(?:up\s+|all(?:\s+of)?\s+|the last(?:\s+of)?\s+)*(.+?)\s*[.!]?\s*$/i)
    ||text.match(/^\s*(?:the\s+)?(.+?)\s+(?:is|are|went|has gone|have gone)\s+(?:all\s+)?(?:gone|used up|bad|off|moldy|expired|finished)\s*[.!]?\s*$/i)
    ||text.match(/^\s*no more\s+(.+?)\s*[.!]?\s*$/i);
  if(!m)return null;
  const names=trSplit(m[1].replace(/^(?:the\s+)?last(?:\s+of)?\s+(?:the\s+)?/i,''));
  return names.length&&names.every(function(n){ return n.split(' ').length<=4&&trKnownFood(n,known); })?names:null;
}
const TR_MEAL=/\s+(?:for|at)\s+(?:dinner|lunch|breakfast|supper|brunch)|\s+(?:tonight|today|last night|this morning|yesterday)/gi;
const TR_MEAL1=new RegExp(TR_MEAL.source,'i');
// "I made a reservation for dinner" isn't a recipe
const TR_NOT_DISH=/\b(?:reservation|appointment|call|payment|plans?|list|decision|mistake|deal|friends?|bed|it|that|this|time|money|progress|dinner|lunch|breakfast|food|mess|sure|room|space|copy|copies|changes?)\b/i;
const trRecipe=function(name,recipes){
  const n=String(name||'').toLowerCase().replace(/^(?:the|some|a|an|my|our)\s+/,'').trim();
  return (recipes||[]).find(function(r){ const k=r.name.toLowerCase(); return k===n||trSame(k,n); })||null;
};
// "I made the chili (and loved it)" / "I loved the tacos" / "the tacos were bad" / "I want to make lasagna this week"
function trCooking(text,recipes){
  const s=text.trim();
  let m=s.match(/^\s*(?:i|we)\s+(?:just\s+)?(made|cooked|baked|had)\s+(.+?)(?:\s*(?:,|and)\s+(?:i\s+|we\s+|it\s+)?(?:it\s+)?(loved|liked|enjoyed|hated|didn(?:'|’)?t like|was (?:good|great|amazing|delicious|bad|gross|meh))(?:\s+it)?)?\s*[.!]?\s*$/i);
  if(m){
    const meal=TR_MEAL1.test(m[2]);
    const name=trTidy(m[2].replace(TR_MEAL,'').replace(/^(?:the|some|a|an|my|our)\s+/i,''));
    const r=trRecipe(name,recipes);
    if(!name||name.split(' ').length>6)return null;
    // a new recipe only from "I made tacos for dinner", never "I had a meeting" or "I made a reservation for dinner"
    if(!r&&(!meal||/^had$/i.test(m[1])||TR_NOT_DISH.test(name)))return null;
    const like=m[3]?!/hated|didn|bad|gross|meh/i.test(m[3]):undefined;
    return {kind:'made',name:r?r.name:trCap(name),recipe:r,liked:like};
  }
  m=s.match(/^\s*(?:i|we)\s+(?:really\s+)?(loved|liked|enjoyed|hated|didn(?:'|’)?t like)\s+(?:the\s+|that\s+|my\s+)?(.+?)\s*[.!]?\s*$/i);
  if(m){ const r=trRecipe(trTidy(m[2].replace(TR_MEAL,'')),recipes); return r?{kind:'liked',name:r.name,recipe:r,liked:!/hated|didn/i.test(m[1])}:null; }
  m=s.match(/^\s*(?:the\s+|that\s+|my\s+)?(.+?)\s+(?:was|were|is)\s+(?:so\s+|really\s+)?(good|great|amazing|delicious|tasty|bad|gross|meh|not good|terrible)\s*[.!]?\s*$/i);
  if(m){ const r=trRecipe(trTidy(m[1]),recipes); return r?{kind:'liked',name:r.name,recipe:r,liked:!/bad|gross|meh|not good|terrible/i.test(m[2])}:null; }
  m=s.match(/^\s*(?:i\s+want\s+to|i(?:'|’)?m\s+(?:going|gonna)\s+(?:to\s+)?|i(?:'|’)?ll|let(?:'|’)?s|we(?:'|’)?ll|plan(?:\s+to)?)\s*(?:make|cook|have)\s+(.+?)(?:\s+(?:this|next)\s+week|\s+tomorrow|\s+(?:on\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))?(?:\s+for\s+(?:dinner|lunch|breakfast))?\s*[.!]?\s*$/i);
  if(m){ const r=trRecipe(trTidy(m[1]),recipes); return r?{kind:'plan',name:r.name,recipe:r}:null; }
  return null;
}

/* text + what's known → what to do, or null (it's an ordinary task).
   ctx: {foods: names in the pantry and grocery list, recipes: [{id, name}], agent: on the Agent tab} */
function tabRoute(text,ctx){
  const s=String(text||'').replace(/\s+/g,' ').trim();
  ctx=ctx||{};
  if(!s||s.length>200||/(^|\s)#\w/.test(s))return null; // a #tag or #goal: he's writing it the long way on purpose
  const asks=TR_ASK.test(s);
  if(!asks){
    const g=trDailyGoal(s); if(g)return {tab:'health',kind:'goal',goal:g};
  }
  const mac=trMacros(s);
  if(mac==='rule')return ctx.agent?null:{tab:'health',kind:'plan-ask'}; // on the Agent tab it's just an Agent task, as before
  if(mac&&!asks)return {tab:'health',kind:'plan',macros:mac};
  if(asks)return null;
  const known=(ctx.foods||[]).concat((ctx.recipes||[]).map(function(r){ return r.name; }));
  const st=trStock(s,known); if(st)return {tab:'kitchen',kind:'stock',items:st};
  const used=trUsed(s,known); if(used)return {tab:'kitchen',kind:'used',names:used};
  const ck=trCooking(s,ctx.recipes); if(ck)return Object.assign({tab:'kitchen'},ck);
  const tr=trTraining(s); if(tr)return {tab:'health',kind:'training',title:tr};
  return null;
}
// the pantry's line for an item ("Chicken, 2 lb"), as stockPantry reads it
function trStockName(i){ return trCap(i.name)+(i.qty!=null?', '+trFmt(i.qty,i.unit):''); }

if(typeof module!=='undefined'&&module.exports){
  module.exports={tabRoute:tabRoute,trDailyGoal:trDailyGoal,trMacros:trMacros,trTraining:trTraining,trStock:trStock,trUsed:trUsed,trCooking:trCooking,trStockName:trStockName};
}

/* ══ the page: do it, and show the tab ══ */
if(typeof document!=='undefined'&&typeof window!=='undefined'){

// a tab he can see (not switched off in Settings > Tabs, not hidden by the app)
const trTabShown=function(tab){ const b=$(tab==='health'?'tabHealth':'tabKitchen'); return !!b&&!b.hidden&&!b.classList.contains('tab-off'); };
const trWord=function(tab){ return tab==='health'?'Health':'Kitchen'; };
const trToday=function(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };

function trCtx(){
  const k=state.kitchen||{items:[],recipes:[]};
  const g=typeof groceryTask==='function'?groceryTask():null;
  const list=g&&typeof normList==='function'?normList(g.list).map(function(x){ return x.name.split(',')[0]; }):[];
  return {foods:k.items.map(function(i){ return i.name; }).concat(list),recipes:k.recipes,agent:state.activeTab==='agent'};
}
// the daily goal he has for this kind (an open, repeating to-do), so a new number replaces it
function trGoalTask(kind){
  return state.tasks.filter(function(t){
    if(t.done||taskWs(t)==='agent'||!t.recur)return false;
    const g=healthGoal(t.title); return g&&g.kind===kind;
  }).sort(function(a,b){ return (b.created||0)-(a.created||0); })[0]||null;
}
function trNewTask(title,extra){
  const t=Object.assign({id:uid(),title:title,done:false,due:null,dueTime:null,tag:null,ws:'personal',subs:[],googleEventId:null,created:Date.now()},extra||{});
  state.tasks.push(t); return t;
}

/* do what tabRoute said → {tab, say}, or null when it couldn't (then it's added as a task) */
function tabRouteApply(r,text,dueBox){
  if(!r)return null;
  if(r.tab==='health'&&!document.getElementById('healthView'))return null;
  if(r.tab==='kitchen'&&!state.kitchen)return null;
  const now=Date.now();
  if(r.kind==='goal'){
    const old=trGoalTask(r.goal.kind);
    if(old){ const was=old.title; old.title=r.goal.title; old.updatedAt=now; return {tab:'health',say:'Health goal changed: '+was+' → '+r.goal.title+', every day'}; }
    const due=trToday();
    const t=trNewTask(r.goal.title,{due:due}); t.recur={every:'day',dom:Number(due.slice(8)),series:t.id};
    return {tab:'health',say:'Health goal: '+r.goal.title+', every day. It ticks itself off from your phone.'};
  }
  if(r.kind==='plan'){
    if(typeof healthSetPlan!=='function')return null;
    const line=healthSetPlan(r.macros,text);
    return line?{tab:'health',say:'Food plan: '+line}:null;
  }
  if(r.kind==='plan-ask'){
    // a rule needs his weight and some arithmetic: the Agent's meal-plan skill does it, and its answer sets the Food plan
    if(typeof agentAvailable!=='function'||!agentAvailable())return null;
    trNewTask(trCap(text),{ws:'agent',status:'queued',note:null});
    return {tab:'health',say:'Sent to the Agent to work out. The number goes on your Food plan (Health tab).',stay:true};
  }
  if(r.kind==='training'){
    let title=r.title, due=dueBox||null, recur=null;
    if(typeof recurFromWords==='function'){ const x=recurFromWords(title); if(x){ recur=x; title=x.title; if(!due||x.onDay)due=x.due; } }
    if(!due&&typeof parseSpokenTask==='function'){ const p=parseSpokenTask(title); if(p.due&&p.title){ title=p.title; due=p.due; } }
    const t=trNewTask(trCap(title),{due:due,tag:'health'});
    if(recur)t.recur={every:recur.every,dom:Number(due.slice(8)),series:t.id};
    return {tab:'health',say:'Training goal on the Health tab: '+t.title+(due?' ('+due+')':'')};
  }
  const k=state.kitchen;
  if(r.kind==='stock'){
    const added=stockPantry(k,r.items.map(trStockName),now,uid);
    return added.length?{tab:'kitchen',say:'In your pantry: '+r.items.map(function(i){ return (i.qty!=null?trFmt(i.qty,i.unit)+' ':'')+i.name; }).join(', ')}:null;
  }
  if(r.kind==='used'){
    const gone=[];
    r.names.forEach(function(n){
      const p=k.items.find(function(i){ return trSame(i.name,n); }); if(!p)return;
      k.items=k.items.filter(function(i){ return i!==p; }); k.tombstones.push({id:p.id,deletedAt:now}); gone.push(p.name);
    });
    // and on the next grocery order, the way "we're out of eggs" does
    const g=typeof addToGroceries==='function'?addToGroceries('we’re out of '+r.names.join(', ')):null;
    if(!gone.length&&!g)return null;
    return {tab:'kitchen',say:(gone.length?'Out of the pantry: '+gone.join(', '):'Not in the pantry')+(g?'. On the next grocery order: '+g.names.join(', '):'')};
  }
  if(r.kind==='made'||r.kind==='liked'||r.kind==='plan'){
    let rec=r.recipe&&k.recipes.find(function(x){ return x.id===r.recipe.id; });
    if(!rec){ rec={id:uid(),name:r.name,ingredients:[],liked:false,planned:false,made:[],updatedAt:now}; k.recipes.push(rec); }
    const bits=[];
    if(r.kind==='made'){
      const c=cookRecipe(k,rec.id,now);
      bits.push('Made '+rec.name+(c.ranOut.length?'. Ran out: '+c.ranOut.join(', '):c.used.length?'. Took out of the pantry: '+c.used.join(', '):''));
    }
    if(r.kind==='plan'){ rec.planned=true; bits.push(rec.name+' is on your meal plan; its shopping list is under Shop'); }
    if(typeof r.liked==='boolean'){ rec.liked=r.liked; bits.push(r.liked?'Liked':'Not liked'); }
    rec.updatedAt=now;
    return {tab:'kitchen',say:bits.join('. ')};
  }
  return null;
}
// "we're out of eggs" went onto the grocery list (task-actions.js addTask): out of the pantry too
window.kitchenUsedUp=function(names){
  const k=state.kitchen; if(!k||!Array.isArray(names))return;
  const now=Date.now(); let n=0;
  names.forEach(function(x){ const p=k.items.find(function(i){ return trSame(i.name,x); }); if(p){ k.items=k.items.filter(function(i){ return i!==p; }); k.tombstones.push({id:p.id,deletedAt:now}); n++; } });
  if(n)persist();
};
// addTask's question: was this about health or the kitchen? Then it's done there, and he sees it. → true when it was
window.tabRouteTry=function(text,dueBox){
  let r=null; try{ r=tabRoute(text,trCtx()); }catch(e){ r=null; }
  const done=r?tabRouteApply(r,text,dueBox):null;
  if(!done)return false;
  persist();
  if(!done.stay&&state.activeTab!==done.tab&&trTabShown(done.tab))switchTab(done.tab); else renderActive();
  if(done.tab==='health'&&typeof renderHealth==='function'&&state.activeTab==='health')renderHealth();
  voiceToast(done.say+(trTabShown(done.tab)||done.stay?'':' (the '+trWord(done.tab)+' tab is switched off in Settings > Tabs)'));
  return true;
};
}
