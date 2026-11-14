/* Meal ideas from his pantry (the Kitchen tab's Meals view, renderer/js/kitchen.js): one tool-less ask to his
   AIs (Lupa first, then the cloud, main/kitchen-ai.js) with what's in the pantry, his recipes, his usual
   groceries, his preferences (what he avoids, what he's aiming for) and his Food plan (the Health tab's daily
   calories and macros, each meal sized to a third of it). It answers with meals he can make
   mostly from what he has; the app works out what's missing against the pantry itself.
   Shared by the computer (main/kitchen-ai.js requires it) and the phone, which asks with its own copy of his AI
   keys (phone-ai.js). A page script, so no require here, and every top-level name starts with mi or mealIdeas. */
'use strict';

// the same marks agent/helpers.js noEmoji takes out
const MI_EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}\u{2713}-\u{2717}]/gu;
const miClean = (s, n) => String(s == null ? '' : s).replace(MI_EMOJI, '').replace(/\s+/g, ' ').trim().slice(0, n || 120);

function mealIdeasPrompt() {
  return 'You suggest meals for one person to cook at home from the food he already has.\n' +
    '- Suggest 6 different meals. Build each mostly from his pantry; at most 3 ingredients he doesn\'t have, ' +
    'and fewer is better. Salt, pepper, water and oil count as always there.\n' +
    '- Follow his preferences strictly: never use a food he avoids or is allergic to, even a little. ' +
    'If he says what he\'s aiming for (high protein, a calorie or macro target), every meal fits it and ' +
    '`why` says how (e.g. "about 45 g protein").\n' +
    '- If he has a daily Food plan, size each meal to one meal\'s share of it (the share is given) unless ' +
    'what he wants this time says otherwise (a snack, a big dinner). `why` gives the meal\'s rough numbers ' +
    'for what the plan sets, e.g. "about 700 kcal, 55 g protein".\n' +
    '- Use amounts he actually has: never more of a pantry food than the pantry lists.\n' +
    '- Recipes he already has and likes are a guide to his taste; you may suggest one of them, but most ' +
    'ideas should be new to him.\n' +
    '- Ingredients are short shopping-style lines with an amount for one serving where it matters: ' +
    '"8 oz chicken breast", "1 sweet potato", "2 cups spinach". Steps: 3 to 6 short lines.\n' +
    '- Plain words, no emoji, no markdown.\n' +
    'Answer with ONLY a JSON object, no other words and no code fence:\n' +
    '{"meals":[{"name":"...","why":"one short line","ingredients":["..."],"steps":["..."]}]}\n';
}

// his Food plan's per-day targets (agent/grocery.js macroBrief's perDay: {kcal, protein, carbs, fat}) → the
// ask's lines: the day, and one of three meals' share of it; '' when there is no plan
const MI_MACRO_SAY = [['kcal', ' kcal'], ['protein', ' g protein'], ['carbs', ' g carbs'], ['fat', ' g fat']];
function mealIdeasPlanLines(perDay) {
  if (!perDay || typeof perDay !== 'object') return '';
  const round = (k, v) => (k === 'kcal' ? Math.round(v / 10) * 10 : Math.round(v)); // calories to the nearest 10
  const say = (div) => MI_MACRO_SAY.filter(([k]) => Number(perDay[k]) > 0)
    .map(([k, unit]) => round(k, Number(perDay[k]) / div) + unit).join(', ');
  const day = say(1);
  return day ? '## His daily Food plan (for him alone)\n' + day + ' a day. One meal\'s share: about ' + say(3) + '.' : '';
}

// {pantry:[{name, qty, unit}], recipes, usual:[names], prefs: text, aim: text, plan: perDay} → the question's data part
function mealIdeasInput({ pantry, recipes, usual, prefs, aim, plan }) {
  const amt = (x) => (x.qty != null ? x.qty + (x.unit ? ' ' + x.unit : '') + ' ' : '');
  const lines = [];
  if (miClean(aim, 300)) lines.push('## What he wants this time\n' + miClean(aim, 300));
  const pl = mealIdeasPlanLines(plan); if (pl) lines.push(pl);
  lines.push('## His preferences\n' + (String(prefs || '').trim().slice(0, 4000) || '(none saved)'));
  lines.push('## His pantry (what he has now)\n' + ((pantry || []).filter((x) => x && miClean(x.name)).slice(0, 300)
    .map((x) => '- ' + amt(x) + miClean(x.name)).join('\n') || '(empty)'));
  const rs = (recipes || []).filter((r) => r && miClean(r.name)).sort((a, b) => !!b.liked - !!a.liked).slice(0, 40);
  if (rs.length) lines.push('## Recipes he has saved\n' + rs.map((r) => '- ' + miClean(r.name) + (r.liked ? ' (likes it)' : '')).join('\n'));
  const us = (usual || []).map((x) => miClean(x)).filter(Boolean).slice(0, 100);
  if (us.length) lines.push('## What he usually buys\n' + us.join(', '));
  return lines.join('\n\n');
}

// the first {...} in an answer, parsed; null when there's none
function miPickJson(text) {
  const t = String(text || ''), a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const j = JSON.parse(t.slice(a, b + 1)); return j && typeof j === 'object' ? j : null; } catch (e) { return null; }
}

// the AI's text → [{name, why, ingredients:[lines], steps:[lines]}], at most 8, no repeats; [] when unusable
function mealIdeasParse(text) {
  const j = miPickJson(text), seen = new Set();
  const list = j && Array.isArray(j.meals) ? j.meals : [];
  return list.map((m) => m && typeof m === 'object' ? {
    name: miClean(m.name, 80), why: miClean(m.why, 160),
    ingredients: (Array.isArray(m.ingredients) ? m.ingredients : []).map((x) => miClean(x, 80)).filter(Boolean).slice(0, 25),
    steps: (Array.isArray(m.steps) ? m.steps : []).map((x) => miClean(x, 240)).filter(Boolean).slice(0, 10),
  } : null).filter((m) => {
    if (!m || !m.name || !m.ingredients.length) return false;
    const k = m.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true;
  }).slice(0, 8);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { prompt: mealIdeasPrompt, input: mealIdeasInput, parse: mealIdeasParse, planLines: mealIdeasPlanLines };
}
