/* His grocery list on an Agent task (renderer/js/grocery-list.js keeps it): what the run is shown, and
   what it may send back. Items: {name, every (weeks), last ('YYYY-MM-DD' bought), out (ran out)}.
   No Electron here, so it can be tested on its own. */
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);

// due = on the next order: ran out, never bought, or its weeks are up (2 days' slack for the weekly run)
function itemDue(it, now) {
  if (it.out || !it.last) return true;
  const next = new Date(it.last + 'T00:00:00'); next.setDate(next.getDate() + 7 * it.every - 2);
  return next.getTime() <= now;
}
// → the list as the run sees it, or undefined when there is none
function groceryBrief(list, now = Date.now()) {
  if (!Array.isArray(list) || !list.length) return undefined;
  const items = list.map((x) => typeof x === 'string' ? { name: x, every: 1, last: null, out: false } : x)
    .filter((x) => x && clean(x.name)).slice(0, 200)
    .map((x) => {
      const it = { name: clean(x.name), every: Math.max(1, Math.round(Number(x.every) || 1)), last: x.last || null, out: !!x.out };
      return { name: it.name, every: it.every === 1 ? 'weekly' : 'every ' + it.every + ' weeks', lastBought: it.last || undefined,
        ranOut: it.out || undefined, due: itemDue(it, now) };
    });
  return items.length ? items : undefined;
}
// the run's answer → {add, bought, remove} (names only), or undefined. It never sends a whole list:
// what he changed while it worked stays as he left it
function groceryChanges(ch) {
  if (!ch || typeof ch !== 'object' || Array.isArray(ch)) return undefined;
  const names = (a) => (Array.isArray(a) ? a : []).map((x) => clean(x && typeof x === 'object' ? x.name : x)).filter(Boolean).slice(0, 100);
  const add = (Array.isArray(ch.add) ? ch.add : []).map((x) => x && typeof x === 'object'
    ? { name: clean(x.name), every: Math.max(1, Math.min(52, Math.round(Number(x.every) || 1))) } : { name: clean(x), every: 1 })
    .filter((x) => x.name).slice(0, 100);
  const out = { add, bought: names(ch.bought), remove: names(ch.remove) };
  return out.add.length || out.bought.length || out.remove.length ? out : undefined;
}

// a new grocery task ("order groceries" said on his phone) has no list of its own yet: his list is the one
// on the newest grocery task that has one (the app opens a new task for each order)
const GROCERY_WORDS = /\b(grocer(y|ies)|ebt|food stamps)\b/i;
function groceryListFor(t, tasks) {
  if (Array.isArray(t.list) && t.list.length) return t.list;
  if (t.ws !== 'agent' || !GROCERY_WORDS.test(String(t.title || ''))) return undefined;
  return newestGroceryList(tasks);
}
function newestGroceryList(tasks) {
  const keep = (Array.isArray(tasks) ? tasks : []).filter((x) => x && x.ws === 'agent' && Array.isArray(x.list) && x.list.length)
    .sort((a, b) => (b.created || 0) - (a.created || 0))[0];
  return keep ? keep.list : undefined;
}

// his most recent order, with its pictures: the newest one he bought (lastOrder, kept when it went through),
// else the cart waiting on an open order (what he kept on it). For "what's on my list?" answered as cards
function lastOrderFor(tasks) {
  // grocery orders only: an Amazon order (a cart too) isn't his last grocery run
  const ag = (Array.isArray(tasks) ? tasks : []).filter((x) => x && x.ws === 'agent'
    && ((Array.isArray(x.list) && x.list.length) || GROCERY_WORDS.test(String(x.title || ''))));
  const items = (list) => list.slice(0, 40).map((it) => ({ name: it.name, qty: it.qty, price: it.price, image: it.image, url: it.url }));
  const bought = ag.filter((x) => x.lastOrder && Array.isArray(x.lastOrder.items) && x.lastOrder.items.length)
    .sort((a, b) => (b.lastOrder.at || 0) - (a.lastOrder.at || 0))[0];
  if (bought) return { on: new Date(bought.lastOrder.at || Date.now()).toISOString().slice(0, 10), items: items(bought.lastOrder.items) };
  const open = ag.filter((x) => !x.done && Array.isArray(x.cart) && x.cart.length).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (!open) return undefined;
  const off = Array.isArray(open.cartOff) ? open.cartOff : [];
  const kept = open.cart.filter((it) => !it.suggested && !off.includes(it.name));
  return kept.length ? { notPlacedYet: true, items: items(kept) } : undefined;
}

/* his EBT wallet (renderer/js/finance-ebt.js) as a grocery run sees it, or undefined when he hasn't set one
   up: about what's left, as of when, and the next deposit. Only these; never anything else from Finance.
   He chose to let grocery runs have it (2026-11-06), so the cart fits from the start */
function ebtBrief(settings, tasks, now = Date.now()) {
  const { ebtWallet, ebtYmd } = require('../renderer/js/finance-ebt');
  const { agentOrders } = require('../renderer/js/order-match');
  const w = ebtWallet(settings, agentOrders(tasks), now);
  if (!w.known) return undefined;
  return { aboutLeft: w.balance, asOf: ebtYmd(w.asOf), nextDeposit: w.nextDeposit ? ebtYmd(w.nextDeposit) : undefined,
    note: 'Worked out by the app from his last known balance minus your EBT orders since; checkout shows the real one.' };
}
const isGroceryRun = (t, tasks) => !!groceryListFor(t, tasks) || (t && t.ws === 'agent' && GROCERY_WORDS.test(String(t.title || '')));
/* the store orders the app already knows (placed by the Agent or found in his account before), newest first:
   [{store, id, date}]. A run looking at his order history reports only orders not on this
   (the groceries skill's "Orders he placed himself"); the app skips repeats anyway */
function knownOrders(tasks) {
  const out = [];
  (Array.isArray(tasks) ? tasks : []).forEach((x) => {
    if (!x || x.ws !== 'agent') return;
    (Array.isArray(x.orders) ? x.orders : []).forEach((o) => {
      if (!o || !o.store) return;
      const at = Number(o.at) || 0;
      out.push({ store: String(o.store).slice(0, 40), id: o.id ? String(o.id).slice(0, 60) : undefined, date: /^\d{4}-\d{2}-\d{2}$/.test(String(o.date || '')) ? o.date : new Date(at).toISOString().slice(0, 10), at });
    });
  });
  return out.sort((a, b) => b.at - a.at).slice(0, 20).map((o) => ({ store: o.store, id: o.id, date: o.date }));
}
/* he asked, in his own words, for an order to go into his pantry ("check my Instacart orders for the pantry",
   "put it into the pantry"): the run gets knownOrders and sends what it finds in `ordered`, the same as an
   orderLook the app started. His title, his reply and his own lines in the task's conversation count */
const PANTRY_WORD = /\bpantry\b/i;
const ORDER_WORDS = /\b(orders?|ordered|deliver(y|ies|ed)|bought|instacart|walmart|aldi|kroger|costco|target|receipt)\b/i;
function asksPantryFill(t) {
  if (!t || t.ws !== 'agent') return false;
  const his = [t.title, t.reply].concat((Array.isArray(t.history) ? t.history : []).filter((h) => h && h.who === 'you').map((h) => h.text));
  const text = his.map((s) => String(s || '')).join('\n');
  return PANTRY_WORD.test(text) && (ORDER_WORDS.test(text) || /\b(put|add)\b[^.\n]{0,40}\b(in|into|to)\b[^.\n]{0,12}\bpantry\b/i.test(text));
}
/* an answer that says food went into his pantry but sends nothing that puts it there (`ordered` with food,
   a placed cart, or `list.bought`): the words alone change nothing, so the app says so instead of letting it stand */
const PANTRY_CLAIM = /\b(added|put|went|moved|stocked|placed)\b[^.\n]{0,80}\b(to|in|into)\b[^.\n]{0,15}\bpantry\b/i;
function emptyPantryClaim(u) {
  if (!u || !PANTRY_CLAIM.test(String(u.note || ''))) return false;
  const food = Array.isArray(u.ordered) && u.ordered.some((o) => o && Array.isArray(o.items) && o.items.some((it) => it && it.food !== false));
  const bought = u.list && Array.isArray(u.list.bought) && u.list.bought.length;
  return !food && !bought && !(Array.isArray(u.cart) && u.cart.length);
}

/* his macro plan (the Health tab's Food plan, renderer/js/health.js: the agent list's ':macros' row holds it
   as JSON text) as a grocery run sees it, or undefined when there is none or it has run out. Per day, for him
   alone: {kcal, protein, carbs, fat} in grams, with when it ends. The run buys food that adds up to it. */
const MACRO_KEYS = ['kcal', 'protein', 'carbs', 'fat'];
function macroBrief(text, now = Date.now()) {
  let p; try { p = JSON.parse(String(text || '')); } catch (e) { return undefined; }
  if (!p || typeof p !== 'object') return undefined;
  const perDay = {};
  MACRO_KEYS.forEach((k) => { const n = Math.round(Number(p[k])); if (n > 0 && n < 20000) perDay[k] = n; });
  if (!Object.keys(perDay).length) return undefined;
  const today = new Date(now); today.setHours(12, 0, 0, 0);
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const out = { perDay, forWhom: 'him alone (the rest of the household eats as usual)' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(p.until)) {
    const end = new Date(p.until + 'T12:00:00');
    const daysLeft = Math.round((end - today) / 864e5) + 1; // the last day counts
    if (daysLeft <= 0) return undefined; // the plan ran out: no macros on this order
    out.until = p.until; out.daysLeft = daysLeft;
  }
  if (p.note && String(p.note).trim()) out.note = String(p.note).replace(/\s+/g, ' ').trim().slice(0, 200);
  out.today = ymd(today);
  return out;
}

// his weight from the same ':macros' row (the Health tab's Weight: typed, or the phone's newest weigh-in)
// → {lb, kg, asOf: 'YYYY-MM-DD', daysAgo, from}, or undefined
function weightBrief(text, now = Date.now()) {
  let p; try { p = JSON.parse(String(text || '')); } catch (e) { return undefined; }
  const w = p && typeof p === 'object' && p.weight;
  const lb = w && Math.round(Number(w.lb) * 10) / 10;
  if (!(lb >= 50 && lb <= 900)) return undefined;
  const out = { lb, kg: Math.round(lb / 2.20462 * 10) / 10 };
  const at = Number(w.at);
  if (at > 0) {
    const d = new Date(at);
    out.asOf = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    out.daysAgo = Math.max(0, Math.floor((now - at) / 864e5));
  }
  if (w.from && String(w.from).trim()) out.from = String(w.from).replace(/\s+/g, ' ').trim().slice(0, 40);
  return out;
}

// a run's `macros` (the meal-plan skill: the plan's per-day targets) → what the app sets as his Food plan, or
// undefined. {kcal, protein, carbs, fat} per day (at least one), span = how long it runs.
// keep: true = only these numbers change ("1 g of protein per pound"); the rest of his plan, and its dates, stay
const MACRO_SPANS = ['week', '2weeks', 'month', 'open'];
function macroChanges(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return undefined;
  const out = {};
  MACRO_KEYS.forEach((k) => { const n = Math.round(Number(m[k])); if (n > 0 && n < 20000) out[k] = n; });
  if (!Object.keys(out).length) return undefined;
  if (m.keep === true) { out.keep = true; if (MACRO_SPANS.includes(m.span)) out.span = m.span; }
  else out.span = MACRO_SPANS.includes(m.span) ? m.span : 'week';
  return out;
}

/* A food task that isn't an order ("1 g of protein per pound", "plan my meals", "what can I cook"): it
   sees what he eats so it doesn't ask. His usual groceries (names only: this run doesn't change the
   list) and the Kitchen tab (renderer/js/kitchen.js): what's in the pantry and his recipes, liked first. */
const FOOD_WORDS = /\b(food|foods|meals?|eat|eating|diet|protein|macros?|calories|nutrition|recipes?|cook|cooking|breakfast|lunch|dinner|snacks?|pantry|kitchen|meal ?prep|grocer(y|ies))\b/i;
const isFoodTask = (t) => !!t && FOOD_WORDS.test(String(t.title || '') + ' ' + String(t.note || '').slice(0, 300));
function foodBrief(t, tasks, kitchen) {
  if (!isFoodTask(t)) return undefined;
  const list = groceryListFor(t, tasks) ? undefined : newestGroceryList(tasks); // an order already has it as groceryList
  const usual = (Array.isArray(list) ? list : []).map((x) => clean(x && typeof x === 'object' ? x.name : x)).filter(Boolean).slice(0, 200);
  const k = kitchen && typeof kitchen === 'object' ? kitchen : {};
  const amount = (x) => (x.qty != null ? x.qty + (x.unit ? ' ' + x.unit : '') : undefined);
  const pantry = (Array.isArray(k.items) ? k.items : []).filter((x) => x && clean(x.name)).slice(0, 300)
    .map((x) => ({ name: clean(x.name), amount: amount(x) }));
  const recipes = (Array.isArray(k.recipes) ? k.recipes : []).filter((r) => r && clean(r.name))
    .sort((a, b) => (!!b.liked - !!a.liked) || ((b.made || []).length - (a.made || []).length)).slice(0, 60)
    .map((r) => ({ name: clean(r.name), liked: r.liked ? true : undefined, timesMade: (r.made || []).length || undefined,
      ingredients: (Array.isArray(r.ingredients) ? r.ingredients : []).map((i) => clean(i && typeof i === 'object' ? i.name : i)).filter(Boolean).slice(0, 40) }));
  if (!usual.length && !pantry.length && !recipes.length) return undefined;
  return { usualGroceries: usual.length ? usual : undefined, pantry: pantry.length ? pantry : undefined, recipes: recipes.length ? recipes : undefined };
}

module.exports = { itemDue, groceryBrief, groceryChanges, groceryListFor, newestGroceryList, lastOrderFor, ebtBrief, isGroceryRun, macroBrief, macroChanges, knownOrders, asksPantryFill, emptyPantryClaim, isFoodTask, foodBrief, weightBrief };
