/* Claude Code on this computer: is it installed, is it signed in, and the two buttons that fix either
   (Install, Sign in). The CLI itself does the OAuth sign-in (`claude auth login`), so no Anthropic
   secret ever lives in the app; an Anthropic API key (config.json → ai.anthropicKey) is the alternative
   for people without a Claude subscription (platform.claudeEnv hands it to every run).
   No Electron here, so it can be tested on its own. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { isWin, claudeExe, claudeInstalled, forgetClaude, claudeEnv } = require('./platform');

const INSTALL_URL = { win: 'https://claude.ai/install.ps1', unix: 'https://claude.ai/install.sh' };
let auth = null; // last `claude auth status --json`: {loggedIn, authMethod, email, subscriptionType}; null = not asked yet
let authAt = 0;
let refreshing = null;

// without asking the CLI: its sign-in leaves a credentials file (and an account in ~/.claude.json)
function filesSayLoggedIn(home = os.homedir()) {
  try { if (fs.statSync(path.join(home, '.claude', '.credentials.json')).size > 2) return true; } catch (e) {}
  try { return /"oauthAccount"\s*:\s*\{/.test(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')); } catch (e) { return false; }
}
const hasKey = (cfg) => !!(cfg && cfg.ai && String(cfg.ai.anthropicKey || '').trim());
// what Settings shows. `via`: how a run would be paid for right now
function status(cfg) {
  const installed = claudeInstalled(cfg);
  const signedIn = installed && (auth ? !!auth.loggedIn : filesSayLoggedIn());
  const key = hasKey(cfg);
  return { installed, path: installed ? claudeExe(cfg) : null, signedIn, email: (auth && auth.email) || null, plan: (auth && auth.subscriptionType) || null,
    hasKey: key, via: key ? 'key' : signedIn ? 'subscription' : null, ready: installed && (signedIn || key), checkedAt: authAt };
}
// ask the CLI (15 s at most); the answer is kept for status()
function refresh(cfg) {
  if (!claudeInstalled(cfg)) { auth = null; return Promise.resolve(status(cfg)); }
  refreshing = refreshing || new Promise((resolve) => {
    // a saved key would make `auth status` report the key, not the sign-in: ask without it
    const env = Object.assign({}, process.env); delete env.ANTHROPIC_API_KEY;
    execFile(claudeExe(cfg), ['auth', 'status', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 15000, env }, (err, out) => {
      try { const j = JSON.parse(String(out || '').slice(String(out || '').indexOf('{'))); auth = { loggedIn: !!j.loggedIn, authMethod: j.authMethod, email: j.email, subscriptionType: j.subscriptionType }; }
      catch (e) { auth = err ? null : { loggedIn: false }; }
      authAt = Date.now();
      resolve(status(cfg));
    });
  }).finally(() => { refreshing = null; });
  return refreshing;
}

/* The official installer (no Node or npm needed), into ~/.local/bin. → {ok} or {ok, error} */
let installing = null;
function install(log = () => {}) {
  installing = installing || new Promise((resolve) => {
    log('claude: running the installer');
    let out = '', p;
    try {
      p = isWin
        ? spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm ' + INSTALL_URL.win + ' | iex'], { windowsHide: true })
        : spawn('bash', ['-lc', 'curl -fsSL ' + INSTALL_URL.unix + ' | bash'], { windowsHide: true });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} }, 10 * 60 * 1000);
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, error: e.message }); });
    p.on('close', (code) => {
      clearTimeout(killer); forgetClaude(); auth = null;
      const ok = code === 0 && claudeInstalled({});
      log('claude: installer ' + (ok ? 'finished' : 'failed (' + code + ')'));
      resolve(ok ? { ok: true } : { ok: false, error: out.trim().split('\n').slice(-3).join(' ').slice(0, 300) || 'the installer exited ' + code });
    });
  }).finally(() => { installing = null; });
  return installing;
}

/* Sign in: `claude auth login` needs a real terminal (it opens the browser and may ask for a code), so one
   is opened with a small script in it; meanwhile the CLI is asked every few seconds whether it worked.
   dir: where the script may be written. → {ok} once signed in, {ok: false, error} after 5 minutes */
let loggingIn = null;
function login(cfg, dir, log = () => {}) {
  loggingIn = loggingIn || new Promise(async (resolve) => {
    const exe = claudeExe(cfg);
    if (!claudeInstalled(cfg)) return resolve({ ok: false, error: 'install Claude Code first' });
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    try { openTerminal(exe, dir); }
    catch (e) { return resolve({ ok: false, error: 'couldn’t open a terminal (' + e.message + '). Open one yourself and run: claude auth login' }); }
    log('claude: sign-in terminal opened');
    const until = Date.now() + 5 * 60 * 1000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 4000));
      const s = await refresh(cfg);
      if (s.signedIn) { log('claude: signed in' + (s.email ? ' as ' + s.email : '')); return resolve({ ok: true }); }
    }
    resolve({ ok: false, error: 'the sign-in didn’t finish in 5 minutes' });
  }).finally(() => { loggingIn = null; });
  return loggingIn;
}
// a terminal window running `claude auth login`, then waiting so the person can read the result
function openTerminal(exe, dir) {
  if (isWin) {
    const f = path.join(dir, 'claude-sign-in.cmd');
    fs.writeFileSync(f, ['@echo off', 'title Claude sign-in', 'echo Signing in to Claude. Your browser opens; come back here when it is done.', 'echo.',
      '"' + exe + '" auth login', 'echo.', 'echo You can close this window.', 'pause >nul', ''].join('\r\n'));
    spawn('cmd.exe', ['/c', 'start', 'Claude sign-in', f], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return;
  }
  const f = path.join(dir, 'claude-sign-in.command');
  fs.writeFileSync(f, ['#!/bin/bash', 'echo "Signing in to Claude. Your browser opens; come back here when it is done."', 'echo',
    JSON.stringify(exe) + ' auth login', 'echo', 'read -n 1 -s -r -p "You can close this window."', ''].join('\n'), { mode: 0o755 });
  if (process.platform === 'darwin') { spawn('open', ['-a', 'Terminal', f], { detached: true, stdio: 'ignore' }).unref(); return; }
  const tries = [['x-terminal-emulator', ['-e', f]], ['gnome-terminal', ['--', f]], ['konsole', ['-e', f]], ['xfce4-terminal', ['-e', f]], ['xterm', ['-e', f]]];
  for (const [cmd, args] of tries) {
    try { const p = spawn(cmd, args, { detached: true, stdio: 'ignore' }); p.on('error', () => {}); p.unref(); return; } catch (e) {}
  }
  throw new Error('no terminal program found');
}

/* One tiny run, to prove a sign-in or key works ("Check"). → {ok, model} or {ok: false, error} */
function check(cfg, dir) {
  return new Promise((resolve) => {
    if (!claudeInstalled(cfg)) return resolve({ ok: false, error: 'Claude Code isn’t installed' });
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    let out = '', err = '', p;
    try {
      p = spawn(claudeExe(cfg), ['-p', '--output-format', 'json', '--model', 'haiku', '--max-turns', '1', '--tools', '', '--strict-mcp-config'],
        { cwd: dir, windowsHide: true, env: claudeEnv(cfg) });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} }, 60 * 1000);
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, error: e.message }); });
    p.stdin.on('error', () => {}); p.stdin.end('Reply with the word ok.');
    p.on('close', (code) => {
      clearTimeout(killer);
      let r = null; try { r = JSON.parse(out); } catch (e) {}
      if (r && !r.is_error) return resolve({ ok: true, model: Object.keys((r.modelUsage || {}))[0] || null });
      const why = (r && String(r.result || r.subtype || '')) || (err || out).trim();
      resolve({ ok: false, error: (why || 'Claude exited ' + code).replace(/\s+/g, ' ').slice(0, 300) });
    });
  });
}

module.exports = { status, refresh, install, login, check, filesSayLoggedIn, INSTALL_URL };
