/* Meal ideas from his pantry (the Kitchen tab's Meals view, renderer/js/kitchen.js): one tool-less ask to his
   AIs (Lupa first, then the cloud, main/kitchen-ai.js) with what's in the pantry, his recipes, his usual
   groceries and his preferences (what he avoids, what he's aiming for). It answers with meals he can make
   mostly from what he has; the app works out what's missing against the pantry itself.
   No Electron here, so it can be tested on its own. */
const { noEmoji } = require('./helpers');

const clean = (s, n) => noEmoji(String(s == null ? '' : s)).replace(/\s+/g, ' ').trim().slice(0, n || 120);

function prompt() {
  return 'You suggest meals for one person to cook at home from the food he already has.\n' +
    '- Suggest 6 different meals. Build each mostly from his pantry; at most 3 ingredients he doesn\'t have, ' +
    'and fewer is better. Salt, pepper, water and oil count as always there.\n' +
    '- Follow his preferences strictly: never use a food he avoids or is allergic to, even a little. ' +
    'If he says what he\'s aiming for (high protein, a calorie or macro target), every meal fits it and ' +
    '`why` says how (e.g. "about 45 g protein").\n' +
    '- Recipes he already has and likes are a guide to his taste; you may suggest one of them, but most ' +
    'ideas should be new to him.\n' +
    '- Ingredients are short shopping-style lines with an amount for one serving where it matters: ' +
    '"8 oz chicken breast", "1 sweet potato", "2 cups spinach". Steps: 3 to 6 short lines.\n' +
    '- Plain words, no emoji, no markdown.\n' +
    'Answer with ONLY a JSON object, no other words and no code fence:\n' +
    '{"meals":[{"name":"...","why":"one short line","ingredients":["..."],"steps":["..."]}]}\n';
}

// {pantry:[{name, qty, unit}], recipes, usual:[names], prefs: text, aim: text} → the question's data part
function input({ pantry, recipes, usual, prefs, aim }) {
  const amt = (x) => (x.qty != null ? x.qty + (x.unit ? ' ' + x.unit : '') + ' ' : '');
  const lines = [];
  if (clean(aim, 300)) lines.push('## What he wants this time\n' + clean(aim, 300));
  lines.push('## His preferences\n' + (String(prefs || '').trim().slice(0, 4000) || '(none saved)'));
  lines.push('## His pantry (what he has now)\n' + ((pantry || []).filter((x) => x && clean(x.name)).slice(0, 300)
    .map((x) => '- ' + amt(x) + clean(x.name)).join('\n') || '(empty)'));
  const rs = (recipes || []).filter((r) => r && clean(r.name)).sort((a, b) => !!b.liked - !!a.liked).slice(0, 40);
  if (rs.length) lines.push('## Recipes he has saved\n' + rs.map((r) => '- ' + clean(r.name) + (r.liked ? ' (likes it)' : '')).join('\n'));
  const us = (usual || []).map((x) => clean(x)).filter(Boolean).slice(0, 100);
  if (us.length) lines.push('## What he usually buys\n' + us.join(', '));
  return lines.join('\n\n');
}

// the first {...} in an answer, parsed; null when there's none
function pickJson(text) {
  const t = String(text || ''), a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const j = JSON.parse(t.slice(a, b + 1)); return j && typeof j === 'object' ? j : null; } catch (e) { return null; }
}

// the AI's text → [{name, why, ingredients:[lines], steps:[lines]}], at most 8, no repeats; [] when unusable
function parse(text) {
  const j = pickJson(text), seen = new Set();
  const list = j && Array.isArray(j.meals) ? j.meals : [];
  return list.map((m) => m && typeof m === 'object' ? {
    name: clean(m.name, 80), why: clean(m.why, 160),
    ingredients: (Array.isArray(m.ingredients) ? m.ingredients : []).map((x) => clean(x, 80)).filter(Boolean).slice(0, 25),
    steps: (Array.isArray(m.steps) ? m.steps : []).map((x) => clean(x, 240)).filter(Boolean).slice(0, 10),
  } : null).filter((m) => {
    if (!m || !m.name || !m.ingredients.length) return false;
    const k = m.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true;
  }).slice(0, 8);
}

module.exports = { prompt, input, parse };
