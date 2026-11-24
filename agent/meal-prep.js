/* A week of meal prep from his whole pantry (the Kitchen tab's "Plan your week", renderer/js/kitchen-week.js): one
   tool-less ask to his AIs (Lupa first, then the cloud, main/kitchen-ai.js) for one big cook on Sunday that covers
   Monday to Sunday, only the meals he picked (breakfast, lunch, dinner, snack), each day adding up to his Food plan.
   It builds around what the pantry holds, says how each dish keeps (fridge, or freezer for later in the week), and
   lists what to buy for the rest. The ask's data part (pantry, preferences, plan...) is agent/meal-ideas.js input().
   No Electron here, so it can be tested on its own. */
const { noEmoji } = require('./helpers');

const clean = (s, n) => noEmoji(String(s == null ? '' : s)).replace(/\s+/g, ' ').trim().slice(0, n || 120);
const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MACROS = ['kcal', 'protein', 'carbs', 'fat'];

// the meals he picked → the ones the plan covers, in day order; all of them when none are given
function slotsOf(list) {
  const s = SLOTS.filter((x) => (list || []).includes(x));
  return s.length ? s : SLOTS.slice();
}

function prompt(slots) {
  const s = slotsOf(slots);
  return 'You plan one week of meal prep for one person who cooks once, on Sunday, for Monday to Sunday.\n' +
    '- Each day has exactly these meals: ' + s.join(', ') + '. Nothing else.\n' +
    '- Build the week around his whole pantry: use as much of what he has as makes sense, the biggest amounts ' +
    'first, and never more of a food than the pantry lists. Salt, pepper, water, oil and dried spices count as there.\n' +
    '- Keep it to 3 to 5 prep dishes, each cooked in one batch on Sunday and split into portions that cover several ' +
    'days. A meal may also be something with no cooking (yogurt and fruit, a sandwich). Vary it: the same dish ' +
    'at most 3 days in a row, and not twice on one day.\n' +
    '- Cooked food keeps about 4 days in the fridge, so for each dish say where the portions go: the fridge for ' +
    'Monday to Wednesday, the freezer for Thursday on, and when to move them to the fridge to thaw.\n' +
    '- Follow his preferences strictly: never use a food he avoids or is allergic to, even a little.\n' +
    '- If he has a daily Food plan, each day\'s meals add up close to it. Give every portion\'s kcal and protein, ' +
    'and carbs and fat when the plan sets them. A no-cook meal gives its own numbers.\n' +
    '- `buy` is what the week needs that he doesn\'t have, as short shopping lines with the amount for the whole ' +
    'week ("2 lb chicken breast", "1 dozen eggs"), each food once. Empty when the pantry covers it.\n' +
    '- Ingredients are for the whole batch, shopping-style with amounts. Steps: 3 to 8 short lines.\n' +
    '- Plain words, no emoji, no markdown.\n' +
    'Answer with ONLY a JSON object, no other words and no code fence:\n' +
    '{"prep":[{"name":"...","portions":6,"portion":"1 container, about 1.5 cups","kcal":0,"protein":0,"carbs":0,"fat":0,' +
    '"ingredients":["..."],"steps":["..."],"store":"..."}],' +
    '"days":[{"day":"Mon","meals":[{"slot":"' + s[0] + '","dish":"a prep dish\'s name, or a no-cook meal","kcal":0,"protein":0}]}],' +
    '"buy":["..."],"notes":["one short tip"]}\n';
}

const num = (v) => { const n = Math.round(Number(v)); return n > 0 && n < 20000 ? n : null; };
function macrosOf(o) { const m = {}; MACROS.forEach((k) => { const n = num(o[k]); if (n != null) m[k] = n; }); return m; }

// the first {...} in an answer, parsed; null when there's none
function pickJson(text) {
  const t = String(text || ''), a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const j = JSON.parse(t.slice(a, b + 1)); return j && typeof j === 'object' ? j : null; } catch (e) { return null; }
}
const lines = (a, max, n) => (Array.isArray(a) ? a : []).map((x) => clean(x, n)).filter(Boolean).slice(0, max);

/* the AI's text, plus the meals he picked → {prep:[{name, portions, portion, kcal..., ingredients, steps, store}],
   days:[{day, meals:[{slot, dish, kcal...}], total:{kcal...}}] (Mon to Sun, each once), buy:[lines], notes:[lines]},
   or null when it isn't a usable week (no dish, or no day with a meal) */
function parse(text, slots) {
  const j = pickJson(text), want = slotsOf(slots);
  if (!j) return null;
  const seen = new Set();
  const prep = (Array.isArray(j.prep) ? j.prep : []).map((d) => {
    if (!d || typeof d !== 'object') return null;
    const name = clean(d.name, 80), ingredients = lines(d.ingredients, 30, 80);
    if (!name || !ingredients.length || seen.has(name.toLowerCase())) return null;
    seen.add(name.toLowerCase());
    return Object.assign({ name, portions: num(d.portions) && num(d.portions) <= 40 ? num(d.portions) : null, portion: clean(d.portion, 80) },
      macrosOf(d), { ingredients, steps: lines(d.steps, 12, 240), store: clean(d.store, 240) });
  }).filter(Boolean).slice(0, 8);
  const byDay = {};
  (Array.isArray(j.days) ? j.days : []).forEach((d) => {
    if (!d || typeof d !== 'object') return;
    const day = DAYS.find((x) => String(d.day || '').toLowerCase().startsWith(x.toLowerCase()));
    if (!day || byDay[day]) return;
    const meals = (Array.isArray(d.meals) ? d.meals : []).map((m) => {
      if (!m || typeof m !== 'object') return null;
      const slot = String(m.slot || '').toLowerCase(), dish = clean(m.dish, 100);
      if (!want.includes(slot) || !dish) return null;
      return Object.assign({ slot, dish }, macrosOf(m));
    }).filter(Boolean)
      .sort((a, b) => want.indexOf(a.slot) - want.indexOf(b.slot));
    if (meals.length) byDay[day] = meals;
  });
  const days = DAYS.filter((d) => byDay[d]).map((d) => ({ day: d, meals: byDay[d] }));
  if (!prep.length || !days.length) return null;
  days.forEach((d) => { d.total = dayTotals(d, prep); });
  const buySeen = new Set();
  const buy = lines(j.buy, 40, 80).filter((b) => { const k = b.toLowerCase(); if (buySeen.has(k)) return false; buySeen.add(k); return true; });
  return { prep, days, buy, notes: lines(j.notes, 5, 200) };
}

// one day's meals → their numbers added up, a prep dish's portion counting for a meal that names it; a number
// only when every meal that day has it (a half-counted total would read as falling short)
function dayTotals(day, prep) {
  const meals = day && day.meals || [], out = {};
  MACROS.forEach((k) => {
    let sum = 0;
    const all = meals.length && meals.every((m) => {
      const d = (prep || []).find((p) => p.name.toLowerCase() === String(m.dish).toLowerCase());
      const v = d && d[k] != null ? d[k] : m[k];
      if (v == null) return false;
      sum += v; return true;
    });
    if (all) out[k] = sum;
  });
  return out;
}

module.exports = { prompt, parse, dayTotals, slotsOf, SLOTS, DAYS };
