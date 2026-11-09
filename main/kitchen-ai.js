/* kitchen:ideas — the Kitchen tab's "Suggest meals" (renderer/js/kitchen.js): his pantry and recipes come from the
   page, his preferences from the synced ':prefs' row and his usual groceries from his grocery orders. One ask,
   Lupa first so it stays home when it can, then his cloud AIs in his order (main/overlay.js readPicture with no
   picture). The prompt and the answer's clean-up are in agent/meal-ideas.js. */
const fs = require('fs');
const mealIdeas = require('../agent/meal-ideas');
const { agentRow } = require('../agent/task-context');
const { newestGroceryList } = require('../agent/grocery');

let ctx = null; // { dataFile, readPicture, agentLog }
let asking = false;
function init(c) { ctx = c; }

function usualGroceries() {
  let tasks = [];
  try { tasks = JSON.parse(fs.readFileSync(ctx.dataFile(), 'utf8')).tasks || []; } catch (e) {}
  return (newestGroceryList(tasks) || []).map((x) => (x && typeof x === 'object' ? x.name : x));
}

// {pantry, recipes, aim} → {meals, via} or {why}
async function ideas(_e, req) {
  if (asking) return { why: 'Still working on the last ones.' };
  req = req || {};
  const pantry = Array.isArray(req.pantry) ? req.pantry : [];
  if (!pantry.length) return { why: 'Add some food to the Pantry first.' };
  asking = true;
  try {
    const prefs = await agentRow(':prefs').catch(() => '');
    const question = mealIdeas.prompt() + '\n' + mealIdeas.input({ pantry, recipes: req.recipes, usual: usualGroceries(), prefs, aim: req.aim });
    const r = await ctx.readPicture(question, null);
    if (!r || !r.text) { ctx.agentLog('meal ideas: ' + ((r && r.why) || 'no answer')); return { why: (r && r.why) || 'No answer.' }; }
    const meals = mealIdeas.parse(r.text);
    ctx.agentLog('meal ideas: ' + meals.length + ' from ' + r.via);
    return meals.length ? { meals, via: r.via } : { why: r.via + ' answered, but not with meals. Try again.' };
  } catch (e) {
    return { why: String(e && e.message || e).slice(0, 200) };
  } finally { asking = false; }
}

module.exports = { init, handlers: { 'kitchen:ideas': ideas } };
