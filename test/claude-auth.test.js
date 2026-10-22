const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('../agent/claude-auth');
const platform = require('../agent/platform');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-auth-'));

test('a sign-in shows in the CLI’s own files', () => {
  const home = tmp();
  assert.strictEqual(auth.filesSayLoggedIn(home), false);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ numStartups: 3 }));
  assert.strictEqual(auth.filesSayLoggedIn(home), false);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } }));
  assert.strictEqual(auth.filesSayLoggedIn(home), true);
  const home2 = tmp();
  fs.mkdirSync(path.join(home2, '.claude'));
  fs.writeFileSync(path.join(home2, '.claude', '.credentials.json'), '{"claudeAiOauth":{}}');
  assert.strictEqual(auth.filesSayLoggedIn(home2), true);
});

test('status: not installed → not ready; a saved key counts as ready once installed', () => {
  const none = auth.status({ agentRunner: { command: path.join(tmp(), 'nope', 'claude') } });
  assert.strictEqual(none.installed, false);
  assert.strictEqual(none.ready, false);
  assert.strictEqual(none.via, null);
  const dir = tmp(), exe = path.join(dir, 'claude');
  fs.writeFileSync(exe, '');
  const withKey = auth.status({ agentRunner: { command: exe }, ai: { anthropicKey: 'sk-ant-x' } });
  assert.strictEqual(withKey.installed, true);
  assert.strictEqual(withKey.hasKey, true);
  assert.strictEqual(withKey.via, 'key');
  assert.strictEqual(withKey.ready, true);
});

test('an API key goes to every Claude run through the environment, and only then', () => {
  assert.strictEqual(platform.claudeEnv({}, { PATH: 'x' }).ANTHROPIC_API_KEY, undefined);
  assert.strictEqual(platform.claudeEnv({ ai: { anthropicKey: '  ' } }, { PATH: 'x' }).ANTHROPIC_API_KEY, undefined);
  const env = platform.claudeEnv({ ai: { anthropicKey: 'sk-ant-1' } }, { PATH: 'x' });
  assert.strictEqual(env.ANTHROPIC_API_KEY, 'sk-ant-1');
  assert.strictEqual(env.PATH, 'x');
});

test('the installer’s URLs are Anthropic’s', () => {
  assert.match(auth.INSTALL_URL.win, /^https:\/\/claude\.ai\/install\.ps1$/);
  assert.match(auth.INSTALL_URL.unix, /^https:\/\/claude\.ai\/install\.sh$/);
});
