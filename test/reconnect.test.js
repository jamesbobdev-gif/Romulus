'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { reconnectTitle, CLAUDE_AUTH_RE } = require('../agent/reconnect');

test('a dead key asks for a new key, each AI by name', () => {
  assert.match(reconnectTitle('gemini', 'Gemini’s API key isn’t valid'), /^Reconnect Gemini: .*API key/);
  assert.match(reconnectTitle('claude'), /^Reconnect Claude: .*\/login/);
  assert.match(reconnectTitle('openai'), /^Reconnect ChatGPT: .*Sign in with ChatGPT/);
  assert.match(reconnectTitle('openrouter', ''), /^Reconnect OpenRouter: .*signing in again/);
});

test('Claude login errors count, words like "author" do not', () => {
  assert.ok(CLAUDE_AUTH_RE.test('Invalid API key · Please run /login'));
  assert.ok(CLAUDE_AUTH_RE.test('OAuth token has expired'));
  assert.ok(!CLAUDE_AUTH_RE.test('The author of the recipe says bake 20 minutes'));
});
