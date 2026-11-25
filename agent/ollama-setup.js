/* Local model, the easy way: Settings → Local model → Set it up for me.
   Starts Ollama if it's installed but not running, installs it on Windows (winget) when it isn't,
   and downloads a model sized to this computer's memory with a progress bar (Ollama's /api/pull),
   so nobody has to open a terminal. Mac and Linux without Ollama get its download page.
   local-model.js drives it; local:save (agent/local-lane.js) switches the model on afterwards. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let ctx = null; // { agentLog, sendToRenderer, openExternal }
function init(c) { ctx = c; }
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };
const log = (m) => ctx && ctx.agentLog && ctx.agentLog('ollama: ' + m);

const OLLAMA = 'http://localhost:11434';
const DOWNLOAD_PAGE = 'https://ollama.com/download';

// the biggest model that runs comfortably in this much memory (bytes) — pure, for tests
function recommendModel(totalMem) {
  const gb = totalMem / 1024 ** 3;
  if (gb < 10) return { model: 'qwen3:4b', sizeGb: 2.5 };
  if (gb < 20) return { model: 'qwen3:8b', sizeGb: 5.2 };
  return { model: 'qwen3:14b', sizeGb: 9.3 };
}

/* Can this computer run one well? At least 8 GB of memory (under that a model crowds out everything else
   and answers too slowly to be worth it), and room on the disk for the model plus Ollama. → {ok, why} — pure, for tests */
const MIN_RAM_GB = 8;
function hardwareFit(totalMem, freeDisk, { installed = true } = {}) {
  const ramGb = totalMem / 1024 ** 3, s = recommendModel(totalMem);
  if (ramGb < MIN_RAM_GB) return { ok: false, why: 'This computer has ' + Math.round(ramGb) + ' GB of memory; a local model needs at least ' + MIN_RAM_GB + ' GB to be useful.' };
  const needGb = s.sizeGb + (installed ? 1 : 3);
  if (freeDisk != null && freeDisk / 1024 ** 3 < needGb) return { ok: false, why: 'Needs about ' + Math.ceil(needGb) + ' GB free on the disk; there is ' + (freeDisk / 1024 ** 3).toFixed(1) + ' GB.' };
  return { ok: true, why: ramGb < 16 ? 'It will run, but slowly: this computer has ' + Math.round(ramGb) + ' GB of memory.' : '' };
}
// free bytes on the disk Ollama keeps its models on (the home folder's), or null if it can't tell
function freeDisk() {
  try { const s = fs.statfsSync(os.homedir()); return s.bavail * s.bsize; } catch (e) { return null; }
}
const fitHere = () => hardwareFit(os.totalmem(), freeDisk(), { installed: !!installedApp() });

const answering = () => fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
async function waitUp(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await answering()) return true; await new Promise((r) => setTimeout(r, 1000)); }
  return false;
}

// where an installed Ollama is, per platform (null: not installed)
function installedApp() {
  if (process.platform === 'win32') {
    const dir = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama');
    for (const f of ['ollama app.exe', 'ollama.exe']) if (fs.existsSync(path.join(dir, f))) return { exe: path.join(dir, f) };
  } else if (process.platform === 'darwin') {
    if (fs.existsSync('/Applications/Ollama.app')) return { mac: true };
  }
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { encoding: 'utf8', windowsHide: true });
  const p = which.status === 0 && String(which.stdout).split(/\r?\n/)[0].trim();
  return p ? { exe: p, serve: true } : null;
}
function start(app) {
  try {
    const p = app.mac ? spawn('open', ['-a', 'Ollama'], { detached: true, stdio: 'ignore' })
      : spawn(app.exe, app.serve || /ollama\.exe$/i.test(app.exe) ? ['serve'] : [], { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', (e) => log('start failed: ' + e.message)); p.unref();
  } catch (e) { log('start failed: ' + e.message); }
}
const hasWinget = () => process.platform === 'win32' && spawnSync('winget', ['--version'], { windowsHide: true }).status === 0;

handle('local:setup-info', async () => ({
  running: await answering(), installed: !!installedApp(), canInstall: hasWinget(), fit: fitHere(),
  ramGb: Math.round(os.totalmem() / 1024 ** 3), suggest: recommendModel(os.totalmem()), url: OLLAMA }));

/* Make Ollama answer on this computer: already running → nothing; installed → start it; Windows with
   winget → install it (Ollama's MIT-licensed package) and start it; otherwise open the download page. */
let installing = null;
handle('local:install', async () => {
  if (await answering()) return { ok: true };
  const fit = fitHere(); if (!fit.ok) return { ok: false, error: fit.why };
  let app = installedApp();
  if (!app) {
    if (!hasWinget()) { ctx.openExternal(DOWNLOAD_PAGE); return { ok: false, opened: true, error: 'Install Ollama from the page that just opened, then press Set it up for me again.' }; }
    installing = installing || new Promise((resolve) => {
      log('installing with winget');
      let out = '';
      const p = spawn('winget', ['install', '--id', 'Ollama.Ollama', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'], { windowsHide: true });
      p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
      p.on('error', (e) => resolve({ ok: false, error: e.message }));
      p.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: out.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 300) || 'winget exited ' + code }));
    }).finally(() => { installing = null; });
    const r = await installing;
    if (!r.ok) { log('install failed: ' + r.error); return { ok: false, error: 'Couldn’t install Ollama: ' + r.error }; }
    app = installedApp();
  }
  if (await waitUp(5000)) return { ok: true }; // the installer may have started it already
  if (app) start(app);
  return (await waitUp(30000)) ? { ok: true } : { ok: false, error: 'Ollama is installed but didn’t start. Open it from the Start menu, then press this again.' };
});

/* Download a model into this computer's Ollama, reporting progress as 'local:pull-progress'
   {model, status, done, total} (bytes). One at a time. */
let pulling = null;
handle('local:pull', async (_e, model) => {
  model = String(model || '').trim();
  if (!/^[a-z0-9._\/-]+(:[a-z0-9._-]+)?$/i.test(model)) return { ok: false, error: 'not a model name' };
  if (pulling) return { ok: false, error: 'already downloading ' + pulling };
  const fit = fitHere(); if (!fit.ok) return { ok: false, error: fit.why };
  pulling = model; log('pulling ' + model);
  try {
    const r = await fetch(OLLAMA + '/api/pull', { method: 'POST', body: JSON.stringify({ model, stream: true }) });
    if (!r.ok || !r.body) return { ok: false, error: 'Ollama said HTTP ' + r.status };
    let buf = '', last = 0, err = null;
    const dec = new TextDecoder();
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch (e) { continue; }
        if (m.error) err = m.error;
        const now = Date.now();
        if (now - last > 250 || m.status === 'success') { last = now; ctx.sendToRenderer('local:pull-progress', { model, status: m.status || '', done: m.completed || 0, total: m.total || 0 }); }
      }
    }
    if (err) return { ok: false, error: err };
    log('pulled ' + model);
    return { ok: true, model };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { pulling = null; }
});

module.exports = { init, handlers, recommendModel, hardwareFit };
