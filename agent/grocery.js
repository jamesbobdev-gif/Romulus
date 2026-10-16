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
  const keep = (Array.isArray(tasks) ? tasks : []).filter((x) => x && x.ws === 'agent' && Array.isArray(x.list) && x.list.length)
    .sort((a, b) => (b.created || 0) - (a.created || 0))[0];
  return keep ? keep.list : undefined;
}

module.exports = { itemDue, groceryBrief, groceryChanges, groceryListFor };
