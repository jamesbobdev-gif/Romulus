/* Where things are on this computer: the laptop is Windows, the hub mini PC is Linux (Ubuntu).
   One place for the paths the agent needs (the claude CLI, Chrome, Node, npm's global folder),
   so the same code runs on both. No Electron here, so it can be tested on its own. */
const path = require('path');
const fs = require('fs');
const os = require('os');

const isWin = process.platform === 'win32';
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };

/* The Claude Code CLI: the command set in config (agentRunner.command), else the official installer's
   place (~/.local/bin), else `claude` on the PATH, else an npm -g install. When none is there the
   installer's path comes back anyway, so an error names where it was expected. */
const CLAUDE_HOME = () => path.join(os.homedir(), '.local', 'bin', isWin ? 'claude.exe' : 'claude');
let claudeOnPath; // undefined = not looked yet; null = none
function claudeFromPath() {
  if (claudeOnPath !== undefined) return claudeOnPath;
  claudeOnPath = null;
  try {
    const out = require('child_process').execFileSync(isWin ? 'where' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const hit = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && (!isWin || /\.(exe|cmd|bat)$/i.test(l)) && isFile(l));
    if (hit) claudeOnPath = hit;
  } catch (e) {}
  return claudeOnPath;
}
function claudeFromNpm() {
  for (const root of npmGlobalRoots()) {
    const dir = path.join(root, '@anthropic-ai', 'claude-code');
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && (pkg.bin.claude || Object.values(pkg.bin)[0]);
      if (bin && isFile(path.join(dir, bin))) return path.join(dir, bin);
    } catch (e) {}
  }
  return null;
}
function claudeExe(cfg) {
  const own = cfg && cfg.agentRunner && cfg.agentRunner.command;
  if (own) return own;
  const home = CLAUDE_HOME();
  if (isFile(home)) return home;
  return claudeFromPath() || claudeFromNpm() || home;
}
// forget where claude was found (after an install)
function forgetClaude() { claudeOnPath = undefined; }
const claudeInstalled = (cfg) => isFile(claudeExe(cfg));
/* The environment for a Claude run. With an Anthropic API key saved (config.json → ai.anthropicKey) the
   CLI bills that key instead of a Claude subscription sign-in; without one, the CLI's own sign-in is used. */
function claudeEnv(cfg, base = process.env) {
  const key = cfg && cfg.ai && String(cfg.ai.anthropicKey || '').trim();
  return key ? Object.assign({}, base, { ANTHROPIC_API_KEY: key }) : base;
}

function chromeCandidates(env = process.env, win = isWin) {
  if (win) {
    return [path.join(env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')];
  }
  // Google Chrome's .deb first (a real Chrome, like his laptop's); Chromium only as a fallback
  return ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}
const findChrome = () => chromeCandidates().find(isFile) || null;

function findNode() {
  try {
    const out = require('child_process').execFileSync(isWin ? 'where' : 'which', ['node'], { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/)[0].trim() || null;
  } catch (e) { return null; }
}

// folders npm -g may have put a CLI in, besides `npm root -g`
function npmGlobalRoots(env = process.env, win = isWin) {
  if (win) return [path.join(env.APPDATA || '', 'npm', 'node_modules')];
  return [path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'), '/usr/local/lib/node_modules', '/usr/lib/node_modules'];
}

// the agent browser's user agent: plain Chrome on this OS ("HeadlessChrome" makes shops suspicious, and a
// Windows UA on a Linux browser doesn't match what its pages can see)
function chromeUA(major, win = isWin) {
  const osPart = win ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return 'Mozilla/5.0 (' + osPart + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + major + '.0.0.0 Safari/537.36';
}
// Chrome's major version: Windows keeps it as a folder next to chrome.exe; on Linux, ask it
function chromeMajor(chrome) {
  try {
    if (isWin) { const v = fs.readdirSync(path.dirname(chrome)).find((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)); if (v) return v.split('.')[0]; }
    else { const m = /(\d+)\.\d+\.\d+/.exec(require('child_process').execFileSync(chrome, ['--version'], { encoding: 'utf8', timeout: 5000 })); if (m) return m[1]; }
  } catch (e) {}
  return '140';
}

module.exports = { isWin, claudeExe, claudeEnv, claudeInstalled, forgetClaude, chromeCandidates, findChrome, findNode, npmGlobalRoots, chromeUA, chromeMajor };
