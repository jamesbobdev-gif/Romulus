/* Records the demo walkthrough: opens the demo page (scripts/demo/build, from build.js) in an Electron window the
   size of the app's, plays the story (a grocery order handed to the Agent, its yes, then the Finance tab), saves a
   frame at each beat into scripts/demo/frames/, and joins them with ImageMagick into docs/images/demo.gif and
   site/img/demo.gif (and demo.mp4 next to them when ImageMagick has ffmpeg).
   `npm run demo` (needs `magick` on the PATH). The page's data is all made up: scripts/demo/demo-bridge.js. */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
// a fresh profile every run: the page keeps a copy of its lists in the profile, and last run's tasks would be back
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'romulus-demo-')));
app.setPath('sessionData', app.getPath('userData'));
const BUILD = path.join(__dirname, 'build');
const FRAMES = path.join(__dirname, 'frames');
const OUTS = [path.join(ROOT, 'docs', 'images'), path.join(ROOT, 'site', 'img')];
const W = 680, H = 940;
const TASK = 'Order this week’s groceries from Walmart: milk, eggs, bananas, chicken thighs, rice, spinach and coffee';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = []; // {file, ms}: each picture and how long it stays up

async function main() {
  fs.rmSync(FRAMES, { recursive: true, force: true });
  fs.mkdirSync(FRAMES, { recursive: true });
  const win = new BrowserWindow({ width: W, height: H, useContentSize: true, resizable: false, show: true, backgroundColor: '#FBFBFA', title: 'Romulus demo', webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false /* keeps painting behind other windows */ } });
  await win.loadFile(path.join(BUILD, 'index.html'));
  win.moveTop(); win.focus();
  win.webContents.on('console-message', (_e, level, msg, line, src) => { if (level >= 2) console.error('[page] ' + msg + ' (' + path.basename(src || '') + ':' + line + ')'); });
  const js = (code) => win.webContents.executeJavaScript(code, true).catch((e) => { throw new Error('in the page: ' + code.slice(0, 120) + ' → ' + e.message); });
  // a capture before the window has painted is empty (and a 0-byte PNG breaks the GIF): wait and try again
  const capture = async () => {
    for (let i = 0; i < 20; i++) { const img = await win.webContents.capturePage(); if (!img.isEmpty()) return img; await sleep(150); }
    throw new Error('the window never painted');
  };
  const shot = async (ms) => {
    const img = await capture();
    const file = path.join(FRAMES, String(frames.length).padStart(3, '0') + '.png');
    fs.writeFileSync(file, img.toPNG());
    frames.push({ file, ms });
  };
  const caption = async (t) => { await js('demoCaption(' + JSON.stringify(t || '') + ')'); await sleep(120); }; // painted before the next capture
  // a scroll in a few frames, so it reads as movement rather than a jump
  const scrollTo = async (expr, steps) => {
    const from = await js('window.scrollY');
    const to = await js('Math.max(0, Math.min(document.documentElement.scrollHeight - innerHeight, ' + expr + '))');
    for (let i = 1; i <= steps; i++) {
      const k = 1 - Math.pow(1 - i / steps, 2);
      await js('window.scrollTo(0, ' + Math.round(from + (to - from) * k) + ')');
      await sleep(40);
      await shot(i === steps ? 400 : 70);
    }
  };
  const waitFor = async (expr, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await js(expr)) return true; await sleep(100); }
    throw new Error('timed out waiting for ' + expr);
  };
  let taskId = null; // the task typed below, once it exists
  const task = () => 'state.tasks.find(function(t){ return t.id===' + JSON.stringify(taskId) + '; })';

  await js('document.fonts.ready.then(function(){ return true; })');
  await waitFor('state.tasks.length > 0', 15000); // init.js applies the lists after its start-up checks; typing before that is lost
  await sleep(1200);

  // 1. the To do tab
  await caption('A to-do list, written the way you’d say it.');
  await shot(2200);

  // 2. the Agent tab, and a task typed in
  await js('switchTab("agent")');
  await sleep(300);
  await caption('Hand a task to the Agent, in plain words.');
  await shot(1300);
  await js('(function(){ var box=document.getElementById("newTitle"); box.focus(); box.value=""; })()');
  const words = TASK.split(' ');
  let typed = '';
  for (let i = 0; i < words.length; i++) {
    typed += (i ? ' ' : '') + words[i];
    await js('document.getElementById("newTitle").value=' + JSON.stringify(typed));
    await shot(i === words.length - 1 ? 800 : 110);
  }
  await js('document.getElementById("addBtn").click()');
  await sleep(250);
  taskId = await js('state.tasks.filter(function(t){ return t.ws==="agent"&&/grocer/i.test(t.title); }).sort(function(a,b){ return b.created-a.created; })[0].id');
  await shot(900);

  // 3. it works, then comes back with the cart
  await waitFor(task() + '.status==="working"', 5000);
  await sleep(200);
  await caption('It searches, compares and builds the cart itself.');
  await shot(2000);
  await waitFor(task() + '.status==="needs-you"', 8000);
  await sleep(200);
  await caption('');
  await shot(1100);
  await js('openTaskById(' + task() + '.id)');
  await sleep(350);
  await caption('It never buys until you say yes.');
  await shot(1600);
  await scrollTo('document.querySelector(".cart-box").getBoundingClientRect().top + scrollY - 150', 5);
  await shot(2600);
  await scrollTo('document.querySelector(".agent-yes").getBoundingClientRect().top + scrollY - innerHeight + 120', 4);
  await shot(1400);

  // 4. the yes, and the order placed
  await js('document.querySelector(".agent-yes").click()');
  await sleep(300);
  await caption('');
  await shot(900);
  await waitFor(task() + '.status==="working"', 5000);
  await sleep(200);
  await scrollTo('document.querySelector(".agent-note").getBoundingClientRect().top + scrollY - 260', 4);
  await shot(1400);
  await waitFor(task() + '.status==="done"', 8000);
  await sleep(300);
  await js('window.scrollTo(0, Math.max(0, document.querySelector(".agent-note").getBoundingClientRect().top + scrollY - 260))');
  await sleep(100);
  await caption('Done. The confirmation is in your inbox.');
  await shot(2800);

  // 5. Finance
  await js('switchTab("finance")');
  await sleep(1200);
  await js('window.scrollTo(0, 0)');
  await sleep(100);
  await caption('Finance: every account in one place. No subscription.');
  await shot(2600);
  await scrollTo('(function(){ var h=[].slice.call(document.querySelectorAll("#financeView h3")).find(function(e){ return /^Assets and debts/.test(e.textContent); }); return (h.closest(".fin-card")||h).getBoundingClientRect().top + scrollY - 20; })()', 5);
  await caption('Net worth over time, debts and what they cost.');
  await shot(2600);
  await scrollTo('(function(){ var h=[].slice.call(document.querySelectorAll("#financeView h3")).find(function(e){ return /^Subscriptions/.test(e.textContent); }); return (h.closest(".fin-card")||h).getBoundingClientRect().top + scrollY - 20; })()', 6);
  await caption('Subscriptions found on their own. Price rises flagged.');
  await shot(2800);
  await scrollTo('document.querySelector(".fin-stocks").getBoundingClientRect().top + scrollY - 20', 6);
  await caption('Live stock prices. The data never leaves your computer.');
  await shot(2800);

  // 6. the end
  await js('switchTab("agent")');
  await sleep(300);
  await js('window.scrollTo(0, 0)');
  await sleep(100);
  await caption('Romulus. Free, open source, bring your own AI.');
  await shot(3200);

  win.close();
  assemble();
}

function assemble() {
  // run inside the frames folder with bare file names: 60 frames under a long folder path overflow the Windows command line
  const timing = frames.map((f) => ['-delay', String(Math.max(2, Math.round(f.ms / 10))), path.basename(f.file)]).flat();
  const gif = path.join(FRAMES, 'demo.gif'), mp4 = path.join(FRAMES, 'demo.mp4');
  const opts = { cwd: FRAMES, stdio: 'inherit', shell: process.platform === 'win32' };
  let r = spawnSync('magick', ['-loop', '0'].concat(timing, ['-resize', W + 'x', '-layers', 'optimize', 'demo.gif']), opts);
  if (r.status !== 0) throw new Error('magick could not write the GIF (is ImageMagick on the PATH?)');
  const video = spawnSync('magick', timing.concat(['-resize', W + 'x', 'demo.mp4']), opts);
  const hasVideo = video.status === 0 && fs.existsSync(mp4) && fs.statSync(mp4).size > 0;
  for (const dir of OUTS) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(gif, path.join(dir, 'demo.gif'));
    if (hasVideo) fs.copyFileSync(mp4, path.join(dir, 'demo.mp4'));
  }
  console.log(frames.length + ' frames, ' + Math.round(frames.reduce((s, f) => s + f.ms, 0) / 1000) + ' s');
  console.log('demo.gif: ' + Math.round(fs.statSync(gif).size / 1024) + ' KB → ' + OUTS.join(', '));
  console.log(hasVideo ? 'demo.mp4: ' + Math.round(fs.statSync(mp4).size / 1024) + ' KB' : 'no demo.mp4: this ImageMagick has no ffmpeg (the GIF is still made)');
}

app.whenReady().then(main).then(() => app.exit(0)).catch((e) => { console.error(e); app.exit(1); });
