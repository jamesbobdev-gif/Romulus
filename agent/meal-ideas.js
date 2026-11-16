/* Meal ideas from his pantry (the Kitchen tab's Meals view, renderer/js/kitchen.js): one tool-less ask to his
   AIs (Lupa first, then the cloud, main/kitchen-ai.js) with what's in the pantry, his recipes, his usual
   groceries and his preferences (what he avoids, what he's aiming for). It answers with meals he can make
   only from what he has (plus salt, pepper, water); the app drops any that still need something else
   (kitchen.js kIdeasCanMake).
   No Electron here, so it can be tested on its own. */
const { noEmoji } = require('./helpers');

const clean = (s, n) => noEmoji(String(s == null ? '' : s)).replace(/\s+/g, ' ').trim().slice(0, n || 120);

function prompt() {
  return 'You suggest meals for one person to cook at home from the food he already has.\n' +
    '- Suggest 8 different meals. Use ONLY foods listed in his pantry, in amounts he has. The only things ' +
    'you may add that aren\'t listed are salt, pepper and water. No oil, butter, spices, sauces or anything ' +
    'else unless it\'s in the pantry. A meal that needs one thing he doesn\'t have is no use to him.\n' +
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

/* A follow-up on one idea: he asks about it ("how long does it take?") or asks for a change ("add rice", "make
   it spicier"). The answer is a short reply, and when he asked for a change, the meal rewritten. It still leans on
   his pantry; something he asks to add that he doesn't have is fine (the card then says what he'd need). */
function followPrompt() {
  return 'You are helping one person with a meal idea you suggested from the food he has at home.\n' +
    '- Answer his question or make the change he asks for. Keep the reply short and plain: 1 to 4 sentences.\n' +
    '- Keep using ONLY foods in his pantry (plus salt, pepper, water) unless he asks to add something; ' +
    'if he does, add it, and say in the reply if it isn\'t in his pantry.\n' +
    '- Follow his preferences strictly: never use a food he avoids or is allergic to.\n' +
    '- If he only asked a question, "meal" is null. If he asked for any change to the meal, "meal" is the whole ' +
    'meal rewritten: name, why, ingredients (short lines with amounts), steps (3 to 8 short lines).\n' +
    '- Plain words, no emoji, no markdown.\n' +
    'Answer with ONLY a JSON object, no other words and no code fence:\n' +
    '{"reply":"...","meal":null}\n';
}

// {meal:{name, why, ingredients, steps}, talk:[{q, a}], said, pantry, prefs} → the question's data part
function followInput({ meal, talk, said, pantry, prefs }) {
  const m = meal || {};
  const amt = (x) => (x.qty != null ? x.qty + (x.unit ? ' ' + x.unit : '') + ' ' : '');
  const lines = [];
  lines.push('## The meal\n' + clean(m.name, 80) + (clean(m.why, 160) ? '\n' + clean(m.why, 160) : '') +
    '\nIngredients:\n' + (m.ingredients || []).map((x) => '- ' + clean(x, 80)).join('\n') +
    '\nSteps:\n' + (m.steps || []).map((x, i) => (i + 1) + '. ' + clean(x, 240)).join('\n'));
  const t = (talk || []).filter((x) => x && clean(x.q)).slice(-6);
  if (t.length) lines.push('## What he asked before\n' + t.map((x) => 'He: ' + clean(x.q, 300) + '\nYou: ' + clean(x.a, 600)).join('\n'));
  lines.push('## His preferences\n' + (String(prefs || '').trim().slice(0, 4000) || '(none saved)'));
  lines.push('## His pantry (what he has now)\n' + ((pantry || []).filter((x) => x && clean(x.name)).slice(0, 300)
    .map((x) => '- ' + amt(x) + clean(x.name)).join('\n') || '(empty)'));
  lines.push('## What he says now\n' + clean(said, 300));
  return lines.join('\n\n');
}

// the AI's text → {reply, meal|null}; null when there's no reply
function parseFollow(text) {
  const j = pickJson(text);
  if (!j) { const r = clean(text, 1200); return r ? { reply: r, meal: null } : null; } // a plain-words answer still answers
  const reply = clean(j.reply, 1200);
  const meal = j.meal && typeof j.meal === 'object' ? parse(JSON.stringify({ meals: [j.meal] }))[0] || null : null;
  return reply || meal ? { reply: reply || 'Changed it.', meal } : null;
}

module.exports = { prompt, input, parse, followPrompt, followInput, parseFollow };
