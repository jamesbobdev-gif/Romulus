/* The line under an answer when the AI that answered was not the first one asked (agent/ai-connections.js handoverNote). */
const test = require('node:test');
const assert = require('node:assert');
const { handoverNote } = require('../agent/ai-connections');

test('out of usage: the next AI carries the conversation on, and the note says so', () => {
  assert.strictEqual(handoverNote({ out: ['Claude'], cant: [], via: 'Gemini' }), 'Claude was out of usage, so Gemini took over.');
  assert.strictEqual(handoverNote({ out: ['Claude', 'Gemini'], cant: [], via: 'ChatGPT' }), 'Claude and Gemini were out of usage, so ChatGPT took over.');
});

test('couldn’t do it, or both reasons at once', () => {
  assert.strictEqual(handoverNote({ out: [], cant: ['Claude'], via: 'Gemini' }), 'Claude couldn’t do this, so Gemini took over.');
  assert.strictEqual(handoverNote({ out: ['Claude'], cant: ['Gemini'], via: 'ChatGPT' }), 'Claude was out of usage, and Gemini couldn’t do this, so ChatGPT took over.');
});

test('the last AI’s own "couldn’t": also tried, with why each was passed', () => {
  assert.strictEqual(handoverNote({ out: ['Claude'], cant: ['Gemini'], via: 'ChatGPT', last: true }), 'Also tried: Gemini, Claude (out of usage).');
});

test('nothing to say when it answered first, or only it was named', () => {
  assert.strictEqual(handoverNote({ out: [], cant: [], via: 'Claude' }), '');
  assert.strictEqual(handoverNote({ out: ['Gemini', 'Gemini'], cant: ['Gemini'], via: 'Gemini' }), '');
  assert.strictEqual(handoverNote({ out: ['Claude', 'Claude'], via: 'Gemini' }), 'Claude was out of usage, so Gemini took over.', 'named twice counts once');
});
