/* Makes the demo page: a copy of renderer/ with scripts/demo/demo-bridge.js loaded ahead of the app's own scripts,
   in scripts/demo/build/ (git-ignored). `node scripts/demo/build.js`, then `npm run demo` records it. */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'build');
fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'renderer'), OUT, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'demo-bridge.js'), path.join(OUT, 'js', 'demo-bridge.js'));
const page = path.join(OUT, 'index.html');
const html = fs.readFileSync(page, 'utf8');
const at = html.indexOf('<script src=');
if (at === -1) throw new Error('renderer/index.html has no script tags');
fs.writeFileSync(page, html.slice(0, at) + '<script src="js/demo-bridge.js"></script>\n' + html.slice(at));
console.log('demo page in', OUT);
