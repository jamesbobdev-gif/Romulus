const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const accounts = require('../agent/ai-accounts');
const providers = require('../agent/providers');
const { runOrder } = require('../agent/ai-connections');
const { claudeEnv } = require('../agent/platform');
const { reconnectTitle } = require('../agent/reconnect');

const known = providers.PROVIDERS, compatIds = providers.COMPAT_IDS;

test('an extra account gets the next number and goes right after its AI in the order', () => {
  const ai = { order: [{ id: 'claude', on: true }, { id: 'gemini', on: true }, { id: 'openai', on: false }] };
  const r = accounts.add(ai, 'claude', { known });
  assert.strictEqual(r.id, 'claude~2');
  assert.deepStrictEqual(r.ai.order.map((p) => p.id), ['claude', 'claude~2', 'gemini', 'openai']);
  assert.strictEqual(r.ai.order[1].on, true);
  const r2 = accounts.add(r.ai, 'claude', { known });
  assert.strictEqual(r2.id, 'claude~3');
  assert.deepStrictEqual(r2.ai.order.map((p) => p.id), ['claude', 'claude~2', 'claude~3', 'gemini', 'openai']);
  // the number of a removed one is used again
  const back = accounts.add(accounts.remove(r2.ai, 'claude~2'), 'claude', { known });
  assert.strictEqual(back.id, 'claude~2');
  assert.ok(ai.order.length === 3 && !ai.accounts, 'the old config is left as it was');
});

test('only a known AI can have extra accounts', () => {
  assert.ok(accounts.add({}, 'nope', { known }).error);
  assert.deepStrictEqual(accounts.list({ ai: { accounts: [{ id: 'nope~2' }, { id: 'claude~2' }, { id: 'claude~2' }, { id: 'bad' }] } }, known).map((a) => a.id), ['claude~2']);
});

test('an account keeps only its own key and name', () => {
  let ai = accounts.add({}, 'gemini', { known }).ai;
  ai = accounts.update(ai, 'gemini~2', { geminiKey: '  key-two  ', geminiModel: 'x', openaiKey: 'nope', label: 'Work' }, compatIds);
  assert.deepStrictEqual(accounts.find({ ai }, 'gemini~2'), { id: 'gemini~2', label: 'Work', geminiKey: 'key-two' });
  ai = accounts.add(ai, 'groq', { known }).ai;
  ai = accounts.update(ai, 'groq~2', { groqKey: 'g2', geminiKey: 'no' }, compatIds);
  assert.strictEqual(accounts.find({ ai }, 'groq~2').groqKey, 'g2');
  assert.strictEqual(accounts.find({ ai }, 'groq~2').geminiKey, undefined);
});

test('names: "Claude 2", or the name he gave it', () => {
  const cfg = { ai: { accounts: [{ id: 'claude~2' }, { id: 'openai~3', label: 'Work' }] } };
  assert.strictEqual(accounts.nameOf('claude~2', cfg, providers.NAMES), 'Claude 2');
  assert.strictEqual(accounts.nameOf('openai~3', cfg, providers.NAMES), 'ChatGPT (Work)');
  assert.strictEqual(accounts.nameOf('claude', cfg, providers.NAMES), 'Claude');
});

test('a run on an account uses its key, never the main one, and its own sign-in folder', () => {
  const cfg = { ai: { geminiKey: 'main', geminiModel: 'gemini-pro', anthropicKey: 'main-ant', openaiVia: 'key', openaiKey: 'main-oa',
    accounts: [{ id: 'gemini~2', geminiKey: 'second' }, { id: 'claude~2' }, { id: 'openai~2' }] } };
  const g = providers.settings(accounts.cfgFor(cfg, 'gemini~2', { userData: '/data', compatIds }));
  assert.strictEqual(g.geminiKey, 'second');
  assert.strictEqual(g.geminiModel, 'gemini-pro', 'the model follows the main account');
  const c = accounts.cfgFor(cfg, 'claude~2', { userData: '/data', compatIds });
  assert.strictEqual(c.ai.anthropicKey, '', 'no key of its own: its own sign-in, not the main key');
  assert.strictEqual(c.ai.claudeConfigDir, path.join('/data', 'ai-accounts', 'claude-2'));
  const env = claudeEnv(c, {});
  assert.strictEqual(env.CLAUDE_CONFIG_DIR, path.join('/data', 'ai-accounts', 'claude-2'));
  assert.strictEqual(env.ANTHROPIC_API_KEY, undefined);
  const o = providers.settings(accounts.cfgFor(cfg, 'openai~2', { userData: '/data', compatIds }));
  assert.strictEqual(o.openaiVia, 'chatgpt', 'no key: its own ChatGPT plan');
  assert.strictEqual(o.openaiKey, '');
  assert.strictEqual(o.codexHome, path.join('/data', 'ai-accounts', 'openai-2'));
  // the main account is untouched
  assert.strictEqual(accounts.cfgFor(cfg, 'gemini', { userData: '/data' }), cfg);
  assert.strictEqual(claudeEnv(cfg, {}).CLAUDE_CONFIG_DIR, undefined);
});

test('the order keeps extra accounts, and lists one missing from it', () => {
  const s = providers.settings({ ai: { order: [{ id: 'claude', on: true }, { id: 'claude~2', on: false }, { id: 'ghost~2', on: true }],
    accounts: [{ id: 'claude~2' }, { id: 'gemini~2' }] } });
  const ids = s.order.map((p) => p.id);
  assert.deepStrictEqual(ids.slice(0, 2), ['claude', 'claude~2']);
  assert.strictEqual(s.order[1].on, false);
  assert.ok(ids.includes('gemini~2'));
  assert.ok(!ids.includes('ghost~2'), 'an account that was removed drops out');
});

test('a task on an AI tries that AI, then its other accounts, then the rest', () => {
  const order = ['gemini', 'claude', 'openai', 'claude~2'];
  assert.deepStrictEqual(runOrder({ order, pinned: 'claude', ready: () => true }), ['claude', 'claude~2', 'gemini', 'openai']);
  assert.deepStrictEqual(runOrder({ order, pinned: 'claude', ready: (id) => id !== 'claude' }), ['claude~2', 'gemini', 'openai']);
  assert.deepStrictEqual(runOrder({ order, ready: () => true }), order);
});

test('an account out of usage sits out until it resets', () => {
  const now = 1000;
  accounts.hold('claude~9', now + 5000, now);
  assert.strictEqual(accounts.heldUntil('claude~9', now + 1), now + 5000);
  assert.strictEqual(accounts.heldUntil('claude~9', now + 6000), 0);
  accounts.hold('gemini~9', null, now); // no reset time given: an hour
  assert.strictEqual(accounts.heldUntil('gemini~9', now), now + 60 * 60 * 1000);
  accounts.clearHold('gemini~9');
  assert.strictEqual(accounts.heldUntil('gemini~9', now), 0);
});

test('a reconnect to-do names the account and where to sign it in again', () => {
  assert.match(reconnectTitle('claude', 'expired', 'Claude 2'), /^Reconnect Claude 2: .*Sign in on it in Settings/);
  assert.match(reconnectTitle('claude', 'expired'), /^Reconnect Claude: .*claude \/login/);
  assert.match(reconnectTitle('gemini', 'bad key', 'Gemini (Work)'), /^Reconnect Gemini \(Work\): .*API key/);
});
