/* His yes, for any AI (agent/browser-proxy.js with TASKS_BROWSER_SPENT): ChatGPT's browser ("block" mode) gets
   the yes like Claude's, and once one AI's browser has placed the order, the next AI's browser in the same run
   (a fresh launcher) can't place it again. A module of its own: the launcher reads its settings when it loads. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-guard-spent-'));
const spentFile = path.join(tmp, 'yes-spent');
delete process.env.TASKS_BROWSER_LOCK;
delete process.env.TASKS_BROWSER_HOSTS;
process.env.TASKS_BROWSER_MAIL = 'block'; // how ChatGPT, Gemini and the others get the browser
process.env.TASKS_BROWSER_APPROVED = '1';
process.env.TASKS_BROWSER_APPROVED_HOSTS = JSON.stringify(['amazon.com']);
process.env.TASKS_BROWSER_ACTIONS = path.join(tmp, 'actions.log');
process.env.TASKS_BROWSER_FILES = '[]';
process.env.TASKS_BROWSER_SPENT = spentFile;
const load = () => { delete require.cache[require.resolve('../agent/browser-proxy')]; return require('../agent/browser-proxy'); };

const call = (name, args) => ({ id: 1, params: { name, arguments: args } });
const CHECKOUT = 'https://www.amazon.com/gp/buy/spc/handlers/display.html';
const refs = '- button "Place your order" [ref=e6]';

test('ChatGPT\'s browser places the order after his yes', () => {
  const chatgpt = load();
  chatgpt.learnRefs(refs);
  assert.strictEqual(chatgpt.buyRefusal(call('browser_click', { target: 'e6', element: 'Place your order button' }), CHECKOUT), null);
  chatgpt.noteAction(call('browser_click', { target: 'e6', element: 'Place your order button' }), CHECKOUT);
  assert.ok(fs.existsSync(spentFile));
});

test('the next AI in the same run can\'t order again with the same yes', () => {
  const next = load();
  next.learnRefs(refs);
  assert.match(next.buyRefusal(call('browser_click', { target: 'e6' }), CHECKOUT), /fresh yes/);
  assert.match(next.buyRefusal(call('browser_press_key', { key: 'Enter' }), CHECKOUT), /fresh yes/);
});

test('an order click that didn\'t take (same checkout page after) leaves his yes standing, once', () => {
  fs.rmSync(spentFile, { force: true });
  const ai = load();
  ai.learnRefs(refs);
  const place = call('browser_click', { target: 'e6', element: 'Place your order button' });
  assert.strictEqual(ai.noteAction(place, CHECKOUT), true); // this click spends it
  assert.match(ai.buyRefusal(place, CHECKOUT), /fresh yes/);
  // a thank-you page or any other page: the order went through (or might have), so it stays spent
  assert.strictEqual(ai.unspendIfStayed(CHECKOUT, 'https://www.amazon.com/gp/buy/thankyou/handlers/display.html'), false);
  assert.strictEqual(ai.unspendIfStayed(CHECKOUT, null), false);
  assert.ok(fs.existsSync(spentFile));
  // still on the same checkout page (the query may change): nothing was bought, the click may be tried again
  assert.strictEqual(ai.unspendIfStayed(CHECKOUT, CHECKOUT + '?referrer=spc'), true);
  assert.ok(!fs.existsSync(spentFile));
  assert.strictEqual(ai.buyRefusal(place, CHECKOUT), null);
  // but only once: a second click that also stays put waits for a fresh yes
  assert.strictEqual(ai.noteAction(place, CHECKOUT), true);
  assert.strictEqual(ai.unspendIfStayed(CHECKOUT, CHECKOUT), false);
  assert.match(ai.buyRefusal(place, CHECKOUT), /fresh yes/);
  assert.strictEqual(ai.noteAction(place, CHECKOUT), false); // already spent: not a new spend
});

test('a new run (the file removed) takes his new yes', () => {
  fs.rmSync(spentFile, { force: true });
  const fresh = load();
  fresh.learnRefs(refs);
  assert.strictEqual(fresh.buyRefusal(call('browser_click', { target: 'e6' }), CHECKOUT), null);
});
