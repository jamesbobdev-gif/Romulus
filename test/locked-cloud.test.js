/* The Locked profile reaches a cloud AI only while his switch for it is on (Settings → About you → Locked:
   "Let the Agent's cloud AIs read it too"). The switch is the row's own `cloud: true`, kept plain next to the
   ciphertext (renderer/js/settings.js lockedSave). agent/supabase.js lockedCloudText reads the flag, and
   agent/task-context.js lockedForCloud hands agent/runner.js the text or ''. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const supabase = require('../agent/supabase');
const ctx = require('../agent/task-context');

const KEY = 'tk_agent_6f1d2c3b-4a5e-4f60-9b7c-8d9e0f1a2b3c';
const TEXT = '## Contact for forms\n- Phone: 555-0100\n- Address: 1 Main St, Springfield IL 62701';
// a row as the renderer saves it (test/locked-crypto.test.js proves the renderer's WebCrypto and this agree)
function encrypt(syncKey, text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', supabase.lockedKey(syncKey), iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final(), c.getAuthTag()]);
  return { v: 2, iv: iv.toString('base64'), ct: ct.toString('base64') };
}

test('lockedCloudText: the text only with the row\'s own cloud flag, whichever version the row is', () => {
  const doc = encrypt(KEY, TEXT);
  assert.strictEqual(supabase.lockedCloudText(KEY, doc), '', 'no flag: nothing for the cloud');
  assert.strictEqual(supabase.lockedCloudText(KEY, Object.assign({}, doc, { cloud: true })), TEXT);
  assert.strictEqual(supabase.lockedCloudText(KEY, Object.assign({}, doc, { cloud: 'yes' })), '', 'only the real flag counts');
  assert.strictEqual(supabase.lockedCloudText(KEY, Object.assign({}, doc, { cloud: 1 })), '');
  assert.strictEqual(supabase.lockedCloudText(KEY, { v: 1, text: 'plain' }), '');
  assert.strictEqual(supabase.lockedCloudText(KEY, { v: 1, text: 'plain', cloud: true }), 'plain');
  assert.strictEqual(supabase.lockedCloudText(KEY, null), '');
  assert.strictEqual(supabase.lockedCloudText(KEY, undefined), '');
  assert.strictEqual(supabase.lockedCloudText(KEY, 'text'), '');
  // the flag opens nothing to the wrong key
  assert.throws(() => supabase.lockedCloudText('tk_agent_someone-elses-key-0000000000', Object.assign({}, doc, { cloud: true })));
  // the local lane's reader is unchanged: it gets the text with or without the flag
  assert.strictEqual(supabase.docText(KEY, doc), TEXT);
  assert.strictEqual(supabase.docText(KEY, Object.assign({}, doc, { cloud: true })), TEXT);
});

test('lockedForCloud: the runner gets the text only while the switch is on; nothing offline or without a channel', async () => {
  const cfg = { sync: { agent: { url: 'https://x.supabase.co', key: 'k', syncKey: KEY } } };
  ctx.init({ userData: () => require('os').tmpdir(), readConfig: () => cfg, agentLog: () => {} });
  let n = 0;
  const serve = (doc) => async () => ({ ok: true, status: 200, json: async () => [{ doc, updated_at: 't' + (++n), topic: 'x' }] });
  assert.strictEqual(await ctx.lockedForCloud({ fetch: serve(encrypt(KEY, TEXT)) }), '');
  assert.strictEqual(await ctx.lockedForCloud({ fetch: serve(Object.assign(encrypt(KEY, TEXT), { cloud: true })) }), TEXT);
  assert.strictEqual(await ctx.lockedForCloud({ fetch: serve(encrypt(KEY, TEXT)) }), '', 'switched off again: gone from the next run');
  assert.strictEqual(await ctx.lockedForCloud({ fetch: async () => { throw new Error('offline'); } }), '');
  assert.strictEqual(await ctx.lockedForCloud({ fetch: serve(Object.assign(encrypt('tk_agent_other-key-00000000000000000', TEXT), { cloud: true })) }), '', 'unreadable: nothing, not a throw');
  ctx.init({ userData: () => require('os').tmpdir(), readConfig: () => ({}), agentLog: () => {} });
  assert.strictEqual(await ctx.lockedForCloud({ fetch: serve(Object.assign(encrypt(KEY, TEXT), { cloud: true })) }), '', 'no sync set up: nothing');
});

test('the runner reads the row only through lockedForCloud, and the page has the switch that sets the flag', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'agent', 'runner.js'), 'utf8');
  assert.ok(/const locked = await lockedForCloud\(\)/.test(runner), 'the runner asks lockedForCloud');
  assert.ok(!/agentRow\(':locked'\)/.test(runner), 'the runner never reads the row straight');
  assert.ok(/standing\.show\(standingText\) \+ lockedPart/.test(runner), 'the profile goes into every cloud AI\'s prompt when it is there');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.ok(/<input type="checkbox" id="lockedCloud">/.test(html), 'the switch');
  assert.ok(/id="lockedHead"/.test(html), 'the heading the switch rewrites');
  const settings = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'settings.js'), 'utf8');
  assert.ok(/if\(\$\('lockedCloud'\)\.checked\)doc\.cloud=true;/.test(settings), 'the flag is written from the switch alone');
  assert.ok(/\$\('lockedCloud'\)\.checked=!!\(d&&d\.cloud===true\)/.test(settings), 'and read back from the row');
  assert.ok(/if\(!lockedLoaded\)\{ this\.checked=!this\.checked;/.test(settings), 'the switch cannot save over a row that never loaded');
});
