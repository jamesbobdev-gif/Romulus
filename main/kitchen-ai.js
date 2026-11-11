/* kitchen:ideas — the Kitchen tab's "Suggest meals" (renderer/js/kitchen.js): his pantry and recipes come from the
   page, his preferences from the synced ':prefs' row and his usual groceries from his grocery orders. One ask,
   Lupa first so it stays home when it can, then his cloud AIs in his order (main/overlay.js readPicture with no
   picture). The prompt and the answer's clean-up are in agent/meal-ideas.js.
   kitchen:photo — the Kitchen tab's pantry photos: groceries to add, or a meal that used some of the pantry.
   Same order (readPicture with the picture); the prompt and clean-up are in renderer/js/pantry-photo.js.
   kitchen:week — the Kitchen tab's "Plan your week": the same data, one Sunday cook for Monday to Sunday
   (agent/meal-prep.js), with room for a longer answer. */
const fs = require('fs');
const mealIdeas = require('../agent/meal-ideas');
const pantryPhoto = require('../renderer/js/pantry-photo');
const mealPrep = require('../agent/meal-prep');
const { agentRow } = require('../agent/task-context');
const { newestGroceryList, macroBrief } = require('../agent/grocery');

let ctx = null; // { dataFile, readPicture, agentLog }
let asking = false, reading = false, planning = false;
function init(c) { ctx = c; }

function usualGroceries() {
  let tasks = [];
  try { tasks = JSON.parse(fs.readFileSync(ctx.dataFile(), 'utf8')).tasks || []; } catch (e) {}
  return (newestGroceryList(tasks) || []).map((x) => (x && typeof x === 'object' ? x.name : x));
}

// what both asks send along: his pantry, recipes, usual groceries, preferences, aim and Food plan (meal-ideas input)
async function askData(req, pantry) {
  const prefs = await agentRow(':prefs').catch(() => '');
  // his Food plan: this computer's copy from the page, else the synced ':macros' row; none once it has run out
  let brief = req.plan && typeof req.plan === 'object' ? macroBrief(JSON.stringify(req.plan)) : undefined;
  if (!brief) brief = macroBrief(await agentRow(':macros').catch(() => ''));
  return mealIdeas.input({ pantry, recipes: req.recipes, usual: usualGroceries(), prefs, aim: req.aim, plan: brief && brief.perDay });
}

// {pantry, recipes, aim, plan} → {meals, via} or {why}
async function ideas(_e, req) {
  if (asking) return { why: 'Still working on the last ones.' };
  req = req || {};
  const pantry = Array.isArray(req.pantry) ? req.pantry : [];
  if (!pantry.length) return { why: 'Add some food to the Pantry first.' };
  asking = true;
  try {
    const question = mealIdeas.prompt() + '\n' + await askData(req, pantry);
    const r = await ctx.readPicture(question, null);
    if (!r || !r.text) { ctx.agentLog('meal ideas: ' + ((r && r.why) || 'no answer')); return { why: (r && r.why) || 'No answer.' }; }
    const meals = mealIdeas.parse(r.text);
    ctx.agentLog('meal ideas: ' + meals.length + ' from ' + r.via);
    return meals.length ? { meals, via: r.via } : { why: r.via + ' answered, but not with meals. Try again.' };
  } catch (e) {
    return { why: String(e && e.message || e).slice(0, 200) };
  } finally { asking = false; }
}

// {mode: 'food'|'shop'|'meal', image: {mime, b64}, pantry} → food: {items, via}; meal: {meal, used, via}; or {why}
async function photo(_e, req) {
  if (reading) return { why: 'Still reading the last picture.' };
  req = req || {};
  const mode = req.mode === 'meal' || req.mode === 'shop' ? req.mode : 'food', pic = req.image || {};
  const mime = /^image\/(jpeg|png|webp)$/.test(pic.mime) ? pic.mime : null;
  const b64 = typeof pic.b64 === 'string' && /^[A-Za-z0-9+/=]+$/.test(pic.b64) ? pic.b64 : null;
  if (!mime || !b64 || b64.length > 8 * 1024 * 1024) return { why: 'That picture can’t be read.' };
  const pantry = Array.isArray(req.pantry) ? req.pantry : [];
  if (mode === 'meal' && !pantry.length) return { why: 'The pantry is empty, so there is nothing to take out.' };
  reading = true;
  try {
    const r = await ctx.readPicture(pantryPhoto.prompt(mode, pantry), { mime, b64 });
    if (!r || !r.text) { ctx.agentLog('pantry photo: ' + ((r && r.why) || 'no answer')); return { why: (r && r.why) || 'No answer.' }; }
    const out = pantryPhoto.parse(mode, r.text);
    const n = mode === 'meal' ? out.used.length : out.items.length;
    ctx.agentLog('pantry photo (' + mode + '): ' + n + ' from ' + r.via);
    if (!n) return { why: mode === 'meal' ? r.via + ' couldn’t match that meal to anything in the pantry.' : mode === 'shop' ? r.via + ' didn’t see anything to buy in that picture.' : r.via + ' didn’t see any food in that picture or receipt.' };
    return Object.assign(out, { via: r.via });
  } catch (e) {
    return { why: String(e && e.message || e).slice(0, 200) };
  } finally { reading = false; }
}

// {pantry, recipes, aim, plan, slots:['lunch', ...]} → {week, via} (agent/meal-prep.js parse) or {why}
async function week(_e, req) {
  if (planning) return { why: 'Still planning the last week.' };
  req = req || {};
  const pantry = Array.isArray(req.pantry) ? req.pantry : [];
  if (!pantry.length) return { why: 'Add some food to the Pantry first.' };
  planning = true;
  try {
    const slots = mealPrep.slotsOf(Array.isArray(req.slots) ? req.slots : []);
    const question = mealPrep.prompt(slots) + '\n' + await askData(req, pantry);
    const r = await ctx.readPicture(question, null, 8000);
    if (!r || !r.text) { ctx.agentLog('week plan: ' + ((r && r.why) || 'no answer')); return { why: (r && r.why) || 'No answer.' }; }
    const w = mealPrep.parse(r.text, slots);
    ctx.agentLog('week plan: ' + (w ? w.prep.length + ' dishes, ' + w.days.length + ' days' : 'unusable') + ' from ' + r.via);
    return w ? { week: w, via: r.via } : { why: r.via + ' answered, but not with a week plan. Try again.' };
  } catch (e) {
    return { why: String(e && e.message || e).slice(0, 200) };
  } finally { planning = false; }
}

module.exports = { init, handlers: { 'kitchen:ideas': ideas, 'kitchen:photo': photo, 'kitchen:week': week } };
