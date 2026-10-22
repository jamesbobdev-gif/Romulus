const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const meter = require('../agent/usage-meter');

const fresh = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'meter-')); meter.init({ userData: () => d }); return d; };

test('Claude: the stream answer comes back and its 5-hour and weekly use are kept', () => {
  const d = fresh();
  const now = Date.now(), reset = Math.floor(now / 1000) + 3600;
  const out = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: reset,
      unifiedWindows: { five_hour: { utilization: 0.82, resetsAt: reset }, seven_day: { utilization: 0.25, resetsAt: reset + 86400 } } } }),
    JSON.stringify({ type: 'result', result: '{"updates": []}' }),
  ].join('\n');
  assert.strictEqual(meter.readClaudeStream(out), '{"updates": []}');
  const s = meter.snapshot();
  assert.strictEqual(s.claude.pct, 0.82);
  assert.strictEqual(s.claude.week, 0.25);
  assert.strictEqual(s.claude.out, false);
  assert.ok(fs.existsSync(path.join(d, 'ai-usage.json')));
  // a window that has reset since reads as empty
  assert.strictEqual(meter.snapshot(reset * 1000 + 1000).claude.pct, 0);
});

test('Claude: plain json output still gives the answer', () => {
  fresh();
  assert.strictEqual(meter.readClaudeStream(JSON.stringify({ result: 'hi' })), 'hi');
});

test('Claude: a rejected status shows as out', () => {
  fresh();
  const reset = Math.floor(Date.now() / 1000) + 600;
  meter.noteClaude({ status: 'rejected', resetsAt: reset, unifiedWindows: { five_hour: { utilization: 1, resetsAt: reset } } });
  assert.strictEqual(meter.snapshot().claude.out, reset * 1000);
});

test('Gemini: counts today, learns the daily limit from the 429, and is out until midnight Pacific', () => {
  fresh();
  meter.noteCall('gemini', { tokens: 100 });
  meter.noteCall('gemini', { tokens: 50 });
  let s = meter.snapshot();
  assert.strictEqual(s.gemini.calls, 2);
  assert.strictEqual(s.gemini.pct, null); // no limit known yet
  const err = { code: 429, details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
    violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '20' }] }] };
  meter.noteCall('gemini', { limited: true, perDay: meter.geminiDailyLimit(err) });
  s = meter.snapshot();
  assert.strictEqual(s.gemini.perDay, 20);
  assert.strictEqual(s.gemini.calls, 2); // the refused call isn't counted
  assert.strictEqual(s.gemini.pct, 0.1);
  assert.ok(s.gemini.out > Date.now() && s.gemini.out <= Date.now() + 86400000);
});

test('Gemini: a per-minute 429 is not a daily limit', () => {
  fresh();
  assert.strictEqual(meter.geminiDailyLimit({ details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel', quotaValue: '10' }] }] }), null);
});

test('next Pacific midnight is a whole Pacific day boundary', () => {
  const now = Date.UTC(2026, 9, 15, 16, 24, 0); // 09:24 PDT
  assert.strictEqual(meter.nextPacificMidnight(now), Date.UTC(2026, 9, 16, 7, 0, 0));
});

test('ChatGPT and OpenRouter: calls and tokens this month; OpenRouter credit gives a bar when the key has a limit', () => {
  fresh();
  meter.noteCall('openai', { tokens: 1500 });
  meter.noteCall('openrouter', { tokens: 10 });
  meter.noteCredit(2.5, 10);
  const s = meter.snapshot();
  assert.strictEqual(s.openai.calls, 1);
  assert.strictEqual(s.openai.tokensText, '2k');
  assert.strictEqual(s.openai.pct, null);
  assert.strictEqual(s.openrouter.calls, 1);
  assert.strictEqual(s.openrouter.pct, 0.25);
});
