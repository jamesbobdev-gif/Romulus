/* Fourth security review pass (SECURITY-FINDINGS.md): the fixes that can only be checked against the source */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('a Claude run cannot Read the local model\'s Research and Coach reports in its work folder', () => {
  // Claude Code lets Read open anything under its working folder without asking, so the allow list
  // (attachments, skills) does not keep it out of what the local lane writes there: only a deny rule does
  const src = read('agent', 'runner.js');
  const denied = src.match(/const denied = \[([\s\S]*?)\];/);
  assert.ok(denied, 'the denied list is there');
  assert.match(denied[1], /'Read\(\.\/Research\/\*\*\)'/);
  assert.match(denied[1], /'Read\(\.\/Coach\/\*\*\)'/);
  // and those are the folders the local lane writes to (agent/local-lane.js)
  const lane = read('agent', 'local-lane.js');
  assert.match(lane, /'Claude Agent', 'Research'/);
  assert.match(lane, /'Claude Agent', 'Coach'/);
});

test('every in-app sender of a page hook carries the install\'s nonce (MainActivity drops the rest)', () => {
  const dir = path.join('mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'jartro', 'tasks');
  const main = read(dir, 'MainActivity.java');
  assert.match(main, /hookNonce/, 'MainActivity checks the nonce');
  for (const f of fs.readdirSync(path.join(__dirname, '..', dir)).filter((n) => n.endsWith('.java') && n !== 'MainActivity.java')) {
    const src = read(dir, f);
    const sends = (src.match(/putExtra\("hookKind"/g) || []).length;
    const nonces = (src.match(/putExtra\("hookNonce"/g) || []).length;
    assert.strictEqual(nonces, sends, f + ': every hookKind intent has a hookNonce');
  }
});
