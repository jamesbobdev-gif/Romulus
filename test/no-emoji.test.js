const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

// renderer/js/no-emoji.js is a page script: run it with just enough of a page to hand back its unEmoji
const code = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'no-emoji.js'), 'utf8');
const unEmoji = vm.runInNewContext(code + ';unEmoji', { document: { readyState: 'loading', addEventListener() {} } });

test('what comes in from an AI or a page loses its emoji on screen', () => {
  // written as escapes, so nothing in the repo shows one: page, magnifier, swords with its variation mark, a flag, thumbs with a skin tone
  assert.strictEqual(unEmoji('\u{1F4C4} Saved: Report.docx'), 'Saved: Report.docx');
  assert.strictEqual(unEmoji('Great pick \u{1F50E}! \u{2694}\u{FE0F} Legion'), 'Great pick ! Legion');
  assert.strictEqual(unEmoji('Trip to \u{1F1EB}\u{1F1F7} Paris \u{1F44D}\u{1F3FD}'), 'Trip to Paris ');
  assert.strictEqual(unEmoji('Step 1\u{FE0F}\u{20E3} done'), 'Step 1 done');
});

test('text arrows, the copyright sign and ordinary marks stay', () => {
  assert.strictEqual(unEmoji('Open ↗ · Settings → About you · © OpenStreetMap · \u{2713} done · ○ to do · ▸ now'),
    'Open ↗ · Settings → About you · © OpenStreetMap · \u{2713} done · ○ to do · ▸ now');
});

test('the app\'s own source has no emoji', () => {
  const EP = /(?![\u{A9}\u{AE}\u{2197}\u{21AA}])\p{Extended_Pictographic}/u;
  const files = execSync('git ls-files', { cwd: path.join(__dirname, '..') }).toString().split('\n')
    .filter((f) => /\.(js|ts|html|css|md|java|json)$/.test(f) && !/^(docs|site|node_modules)\//.test(f) && !/package-lock/.test(f));
  const found = [];
  for (const f of files) {
    let s; try { s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); } catch (e) { continue; }
    s.split('\n').forEach((l, i) => { if (EP.test(l)) found.push(f + ':' + (i + 1)); });
  }
  assert.deepStrictEqual(found, []);
});
