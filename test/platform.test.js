const test = require('node:test');
const assert = require('node:assert');
const platform = require('../agent/platform');

test('the agent browser says plain Chrome on the OS it runs on', () => {
  assert.match(platform.chromeUA('141', false), /\(X11; Linux x86_64\).*Chrome\/141\.0\.0\.0 /);
  assert.match(platform.chromeUA('141', true), /\(Windows NT 10\.0; Win64; x64\)/);
  assert.doesNotMatch(platform.chromeUA('141', false), /Headless/);
});

test('Linux looks for Google Chrome first, and npm -g folders without sudo', () => {
  assert.strictEqual(platform.chromeCandidates({}, false)[0], '/opt/google/chrome/chrome');
  assert.ok(platform.chromeCandidates({ ProgramFiles: 'C:\PF' }, true)[0].endsWith('chrome.exe'));
  assert.ok(platform.npmGlobalRoots({}, false).some((p) => p.includes('.npm-global')));
});

test('the user’s own claude command wins; otherwise claude is looked for, and the installer’s path is the fallback', () => {
  assert.strictEqual(platform.claudeExe({ agentRunner: { command: '/x/claude' } }), '/x/claude');
  assert.strictEqual(platform.claudeInstalled({ agentRunner: { command: '/x/nope/claude' } }), false);
  const found = platform.claudeExe({});
  assert.ok(/claude(\.exe|\.cmd)?$/i.test(found) || found.includes('claude-code'), found);
});
