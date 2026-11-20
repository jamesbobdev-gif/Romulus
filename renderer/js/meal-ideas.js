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
    '- Suggest 8 different meals. Use ONLY foods listed in his pantry, in amounts he has. The only things ' +
    'you may add that aren\'t listed are salt, pepper and water. No oil, butter, spices, sauces or anything ' +
    'else unless it\'s in the pantry. A meal that needs one thing he doesn\'t have is no use to him.\n' +
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

/* Reading the answer. AIs don't always send the bare JSON asked for: a model's <think> notes, a code fence, words
   after it with braces of their own, a trailing comma, or an answer cut off at its length limit. Each of those
   used to come back as no meals at all, so this keeps every whole meal it can find. */
// the answer without thinking notes or code fences
function miStrip(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, ' ').replace(/^[\s\S]*<\/think>/i, ' ').replace(/```[a-z]*/gi, ' ');
}
// t[i] is { or [: the index of its closing bracket (strings skipped), or -1 when the answer stops first
function miSpan(t, i) {
  let depth = 0, inStr = false;
  for (let k = i; k < t.length; k++) {
    const c = t[k];
    if (inStr) { if (c === '\\') k++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) return k;
  }
  return -1;
}
// one piece of JSON, forgiving a trailing comma or curly quotes; undefined when it won't read
function miJson(s) {
  const tries = [s, s.replace(/,(\s*[}\]])/g, '$1'), s.replace(/,(\s*[}\]])/g, '$1').replace(/[“”]/g, '"')];
  for (const x of tries) { try { return JSON.parse(x); } catch (e) {} }
  return undefined;
}
// an ingredient or step as the AI wrote it: a line, or {amount, unit, item} → one line
function miLine(x) {
  if (x && typeof x === 'object') {
    const name = x.item || x.name || x.ingredient || x.food || '';
    return [x.amount != null ? x.amount : x.quantity != null ? x.quantity : x.qty, x.unit, name].filter((p) => p != null && p !== '').join(' ');
  }
  return x;
}
function miLines(v, n, max, split) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(split) : [];
  return list.map(miLine).map((x) => miClean(x, n).replace(/^(step\s*)?\d+\s*[.):]\s*/i, '')).filter(Boolean).slice(0, max);
}
// one meal as the AI wrote it → {name, why, ingredients, steps}, or null when it has no name or no ingredients
function miMeal(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const out = {
    name: miClean(m.name || m.title || m.dish || m.meal, 80), why: miClean(m.why || m.reason || m.note, 160),
    ingredients: miLines(m.ingredients, 80, 25, /\n|;|,(?![^(]*\))/),
    steps: miLines(m.steps || m.instructions || m.method, 240, 10, /\n+|(?<=\.)\s+(?=\d+[.)]\s)/),
  };
  return out.name && out.ingredients.length ? out : null;
}
// a parsed answer → its list of meals: {"meals": [...]}, another name for the list, a bare list, or one meal
function miList(j) {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== 'object') return [];
  for (const k of ['meals', 'recipes', 'ideas', 'dishes', 'suggestions']) if (Array.isArray(j[k])) return j[k];
  if (miMeal(j)) return [j];
  const any = Object.keys(j).map((k) => j[k]).find((v) => Array.isArray(v) && v.some(miMeal));
  return any || [];
}

// the AI's text → [{name, why, ingredients:[lines], steps:[lines]}], at most 8, no repeats; [] when unusable
function mealIdeasParse(text) {
  const t = miStrip(text);
  let found = [];
  // the whole answer first: the first piece of JSON in it that holds meals
  for (let i = 0; i < t.length && !found.length; i++) {
    if (t[i] !== '{' && t[i] !== '[') continue;
    const end = miSpan(t, i);
    if (end < 0) continue;
    const j = miJson(t.slice(i, end + 1));
    if (j !== undefined) { found = miList(j).map(miMeal).filter(Boolean); if (found.length) break; }
  }
  // cut off, or not one piece: every whole meal object in it, when that finds more
  const loose = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== '{') continue;
    const end = miSpan(t, i);
    if (end < 0) continue;
    const m = miMeal(miJson(t.slice(i, end + 1)));
    if (m) { loose.push(m); i = end; }
  }
  if (loose.length > found.length) found = loose;
  const seen = new Set();
  return found.filter((m) => {
    const k = m.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true;
  }).slice(0, 8);
}

/* A follow-up on one idea: he asks about it ("how long does it take?") or asks for a change ("add rice", "make
   it spicier"). The answer is a short reply, and when he asked for a change, the meal rewritten. It still leans on
   his pantry; something he asks to add that he doesn't have is fine (the card then says what he'd need). */
function mealIdeasFollowPrompt() {
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
function mealIdeasFollowInput({ meal, talk, said, pantry, prefs }) {
  const m = meal || {};
  const amt = (x) => (x.qty != null ? x.qty + (x.unit ? ' ' + x.unit : '') + ' ' : '');
  const lines = [];
  lines.push('## The meal\n' + miClean(m.name, 80) + (miClean(m.why, 160) ? '\n' + miClean(m.why, 160) : '') +
    '\nIngredients:\n' + (m.ingredients || []).map((x) => '- ' + miClean(x, 80)).join('\n') +
    '\nSteps:\n' + (m.steps || []).map((x, i) => (i + 1) + '. ' + miClean(x, 240)).join('\n'));
  const t = (talk || []).filter((x) => x && miClean(x.q)).slice(-6);
  if (t.length) lines.push('## What he asked before\n' + t.map((x) => 'He: ' + miClean(x.q, 300) + '\nYou: ' + miClean(x.a, 600)).join('\n'));
  lines.push('## His preferences\n' + (String(prefs || '').trim().slice(0, 4000) || '(none saved)'));
  lines.push('## His pantry (what he has now)\n' + ((pantry || []).filter((x) => x && miClean(x.name)).slice(0, 300)
    .map((x) => '- ' + amt(x) + miClean(x.name)).join('\n') || '(empty)'));
  lines.push('## What he says now\n' + miClean(said, 300));
  return lines.join('\n\n');
}

// the AI's text → {reply, meal|null}; null when there's nothing to show. A plain-words answer still answers
function mealIdeasParseFollow(text) {
  const t = miStrip(text);
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== '{') continue;
    const end = miSpan(t, i);
    if (end < 0) break;
    const j = miJson(t.slice(i, end + 1));
    if (!j || typeof j !== 'object' || !('reply' in j || 'meal' in j)) continue;
    const reply = miClean(j.reply, 1200), meal = miMeal(j.meal);
    return reply || meal ? { reply: reply || 'Changed it.', meal } : null;
  }
  const said = miClean(t, 1200);
  return said ? { reply: said, meal: null } : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { prompt: mealIdeasPrompt, input: mealIdeasInput, parse: mealIdeasParse, planLines: mealIdeasPlanLines,
    followPrompt: mealIdeasFollowPrompt, followInput: mealIdeasFollowInput, parseFollow: mealIdeasParseFollow };
}
