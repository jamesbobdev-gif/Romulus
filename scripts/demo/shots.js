/* Takes the two still pictures on the website and in the README, from the same demo page as the walkthrough
   (scripts/demo/build, from build.js, with scripts/demo/demo-bridge.js's made-up data):
     human.png  the To do tab, the whole list
     agent.png  the Agent tab, one task opened to the Agent's question
   Each is the full page at the app's width, saved to docs/images/ and site/img/.
   `node scripts/demo/build.js && npx electron scripts/demo/shots.js` (npm run demo:shots). */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
// a fresh profile every run: the page keeps a copy of its lists in the profile, and last run's tasks would be back
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'romulus-demo-')));
app.setPath('sessionData', app.getPath('userData'));
const BUILD = path.join(__dirname, 'build');
const OUTS = [path.join(ROOT, 'docs', 'images'), path.join(ROOT, 'site', 'img')];
const W = 660, MAX_H = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const win = new BrowserWindow({ width: W, height: 900, useContentSize: true, resizable: false, show: true, backgroundColor: '#FBFBFA', title: 'Romulus shots', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false /* keeps painting behind other windows */ } });
  await win.loadFile(path.join(BUILD, 'index.html'));
  win.moveTop(); win.focus();
  win.webContents.on('console-message', (_e, level, msg, line, src) => { if (level >= 2) console.error('[page] ' + msg + ' (' + path.basename(src || '') + ':' + line + ')'); });
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => { throw new Error('in the page: ' + code.slice(0, 120) + ' → ' + e.message); });
  const waitFor = async (expr, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await js(expr)) return true; await sleep(100); }
    throw new Error('timed out waiting for ' + expr);
  };
  // a capture before the window has painted is empty (and a 0-byte PNG breaks the GIF): wait and try again
  const capture = async () => {
    for (let i = 0; i < 20; i++) { const img = await win.webContents.capturePage(); if (!img.isEmpty()) return img; await sleep(150); }
    throw new Error('the window never painted');
  };
  // the window grows to the page, so one capture holds all of it
  const shot = async (name) => {
    await js('window.scrollTo(0, 0)');
    win.setContentSize(W, 400); await sleep(250); // measured short, or a page shorter than the window reads as the window's height
    const h = Math.min(MAX_H, await js('document.documentElement.scrollHeight'));
    win.setContentSize(W, h);
    await sleep(400);
    const img = await capture();
    for (const dir of OUTS) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), img.toPNG()); }
    console.log(name + ': ' + W + 'x' + h + ' → ' + OUTS.join(', '));
  };

  await js('document.fonts.ready.then(function(){ return true; })');
  await waitFor('state.tasks.length > 0', 15000); // init.js applies the lists after its start-up checks
  await sleep(800);
  await shot('human.png');

  await js('switchTab("agent")');
  await sleep(300);
  await js('openTaskById(state.tasks.find(function(t){ return /Denver/.test(t.title); }).id)');
  await sleep(500);
  await shot('agent.png');

  win.close();
}

app.whenReady().then(main).then(() => app.exit(0)).catch((e) => { console.error(e); app.exit(1); });
