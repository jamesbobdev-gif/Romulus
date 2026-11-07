const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const r = require('../renderer/js/ai-report');

test('a report carries only the one reply, which AI wrote it and the reason', () => {
  const h = { who: 'claude', via: 'gemini', model: 'models/gemini-2.5-flash', text: 'x'.repeat(7000), at: 1, images: ['u'], thoughts: 'secret' };
  const b = r.aiReportBody(h, 'offensive');
  assert.deepStrictEqual(Object.keys(b).sort(), ['p_model', 'p_reason', 'p_reply', 'p_via']);
  assert.strictEqual(b.p_via, 'gemini');
  assert.strictEqual(b.p_model, 'gemini-2.5-flash');
  assert.strictEqual(b.p_reply.length, 6000);
  assert.strictEqual(b.p_reason, 'offensive');
});

test('an unknown reason becomes "other", and a local answer says so', () => {
  const b = r.aiReportBody({ who: 'claude', lane: 'local', text: 'hi' }, 'nonsense');
  assert.strictEqual(b.p_reason, 'other');
  assert.strictEqual(b.p_via, 'local');
  assert.strictEqual(r.aiReportBody({ text: 'hi' }).p_via, 'claude');
});

test('the reasons the app offers are the ones the database takes', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261114_ai_reports.sql'), 'utf8');
  const m = sql.match(/p_reason in \(([^)]*)\)/);
  const allowed = m[1].split(',').map(s => s.trim().replace(/'/g, ''));
  assert.deepStrictEqual(r.AI_REPORT_REASONS.map(x => x[0]), allowed);
});

test('the page loads ai-report.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.ok(html.includes('<script src="js/ai-report.js"></script>'));
});
