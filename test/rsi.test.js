const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { syntaxError, pageScriptsError } = require('../agent/rsi');

const repo = path.join(__dirname, '..');
function tmpRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-rsi-'));
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  return dir;
}

test('the real page scripts compile together', () => {
  assert.strictEqual(pageScriptsError(repo), null);
});

test('every main-process and page .js file parses', () => {
  for (const dir of ['main', 'agent', 'renderer/js']) {
    for (const f of fs.readdirSync(path.join(repo, dir)).filter((x) => x.endsWith('.js'))) assert.strictEqual(syntaxError(repo, dir + '/' + f), null, dir + '/' + f);
  }
  assert.strictEqual(syntaxError(repo, 'main.js'), null);
});

test('a name declared at the top of two page scripts is caught', () => {
  const dir = tmpRepo({
    'renderer/index.html': '<script src="js/a.js"></script>\n<script src="js/b.js"></script>',
    'renderer/js/a.js': "'use strict';\nconst shared = 1;\n",
    'renderer/js/b.js': "'use strict';\nlet shared = 2;\n",
  });
  assert.match(pageScriptsError(dir), /renderer\/js \(together\).*shared/);
  assert.strictEqual(syntaxError(dir, 'renderer/js/b.js'), null); // each file alone is fine
});

test('syntaxError: broken .js and broken inline html script', () => {
  const dir = tmpRepo({ 'x.js': 'function (', 'p.html': '<script>let = ;</script>', 'ok.html': '<script src="a.js"></script>' });
  assert.match(syntaxError(dir, 'x.js'), /^x\.js: /);
  assert.match(syntaxError(dir, 'p.html'), /^p\.html: /);
  assert.strictEqual(syntaxError(dir, 'ok.html'), null);
  assert.strictEqual(syntaxError(dir, 'gone.js'), null); // deleted files are fine
});
