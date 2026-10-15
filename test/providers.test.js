const test = require('node:test');
const assert = require('node:assert');
const providers = require('../agent/providers');

test('settings defaults: Claude on, the rest off', () => {
  const s = providers.settings({});
  assert.deepStrictEqual(s.order, [{ id: 'claude', on: true }, { id: 'gemini', on: false }, { id: 'openrouter', on: false }]);
  assert.strictEqual(s.openrouterModel, providers.OPENROUTER_DEFAULT_MODEL);
  assert.strictEqual(s.openrouterWeb, true);
});

test('settings keeps the saved order, drops unknown and duplicate ids', () => {
  const s = providers.settings({ ai: { order: [{ id: 'gemini' }, { id: 'bogus' }, { id: 'gemini', on: false }, { id: 'claude', on: false }] } });
  assert.deepStrictEqual(s.order, [{ id: 'gemini', on: true }, { id: 'claude', on: false }, { id: 'openrouter', on: false }]);
});
