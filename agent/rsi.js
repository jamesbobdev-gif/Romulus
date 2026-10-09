/* RSI — Romulus Self Improvement: James asks for a change to the app in a chat, and Claude Code edits
   the app's own source. An experiment, so it's built to be easy to back out of:
   - only when there's a source folder that's a git repo: the folder the app runs from (npm start), or
     config.rsi.repo for the installed app (whose own files are packed and can't change)
   - it won't start with uncommitted work in the folder, so Undo can never take any of James's own edits
   - every change Claude makes is committed as "RSI: <request>"; Undo reverts that commit (a new commit,
     so nothing is ever lost from history)
   - Claude gets Read/Edit/Write in the folder and nothing else: no shell, no web, no connectors, and
     never this file (so RSI can't break its own Undo)
   - before committing, every changed .js file and index.html's scripts are compiled (not run); a change
     that doesn't even parse is thrown away instead of committed
   The tasks data lives in the user-data folder, outside the repo, so Claude never sees or touches it.
   No Electron here: main.js passes in what it needs. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync, spawn } = require('child_process');

const SELF = 'agent/rsi.js';
const TIMEOUT_MS = 15 * 60 * 1000;
const RULES = `You are RSI (Romulus Self Improvement), working inside James's Tasks app: an Electron to-do
app (main.js = main process, preload.js = the bridge, renderer/index.html = the whole UI in one file,
agent/ = the Agent-task runners). The same renderer/index.html also builds the Android app.
James is asking for a change to the app itself, from a chat inside it.
- Make the change he asks for, as small as it can be. Read the code around it first and write code that
  reads like what's there (same style, naming, comment density).
- Don't change anything he didn't ask for, and don't break sync, the Agent runners or his data format.
- You can only read and edit files in this folder: no shell, so you can't run or test anything.
- If what he asks is unclear or risky, don't edit: ask him a short question instead.
- End with 1–3 plain sentences: what you changed and where he'll see it. No code in that summary.`;

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).replace(/\s+$/, ''); // keep leading spaces: porcelain status starts with one
}

// does this changed source still parse? → null if fine, else what's wrong
function syntaxError(repo, file) {
  const full = path.join(repo, file);
  if (!fs.existsSync(full)) return null; // deleted
  const src = fs.readFileSync(full, 'utf8');
  try {
    if (/\.js$/.test(file)) new vm.Script('(function(exports,require,module,__filename,__dirname){' + src.replace(/^#!.*/, '') + '\n})', { filename: file });
    else if (/\.html?$/.test(file)) {
      const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi; let m;
      while ((m = re.exec(src))) new vm.Script('(async function(){' + m[1] + '\n})', { filename: file });
    }
    return null;
  } catch (e) { return file + ': ' + e.message; }
}

function create({ repoDir, exe, log, onEvent, getSession, setSession }) {
  let proc = null;
  const chat = []; // this run of the app's conversation, so the panel can redraw after a reload
  const say = (m) => { chat.push(m); if (chat.length > 200) chat.shift(); onEvent(m); };

  function repo() {
    const r = repoDir();
    return r && fs.existsSync(path.join(r, '.git')) ? r : null;
  }

  function status() {
    const r = repo();
    if (!r) return { available: false, reason: 'RSI needs the app\'s source folder (run it with npm start, or set rsi.repo in config.json).' };
    let dirty = '';
    try { dirty = git(r, ['status', '--porcelain']); } catch (e) { return { available: false, reason: 'git isn\'t working here: ' + e.message.split('\n')[0] }; }
    return { available: true, repo: r, busy: !!proc, dirty: !!dirty, chat, canUndo: !!lastRsiCommit(r) };
  }

  // the newest commit, if it's an RSI change (only that one can be undone: anything after it is left alone)
  function lastRsiCommit(r) {
    try {
      const [hash, subject] = git(r, ['log', '-1', '--format=%H%x09%s']).split('\t');
      return /^RSI: /.test(subject) ? { hash, subject } : null;
    } catch (e) { return null; }
  }

  const needsRestart = (files) => files.some((f) => f === 'main.js' || f === 'preload.js' || (/^agent\//.test(f) && /\.js$/.test(f)));

  function ask(text) {
    const r = repo();
    if (!r) return { ok: false, error: status().reason };
    if (proc) return { ok: false, error: 'RSI is already working on something.' };
    if (git(r, ['status', '--porcelain'])) return { ok: false, error: 'There are uncommitted changes in ' + r + '. Commit them first, so Undo can only ever take back RSI\'s own edits.' };
    const base = git(r, ['rev-parse', 'HEAD']);
    say({ who: 'you', text });

    const allowed = ['Read', 'Glob', 'Grep', 'Edit(./**)', 'Write(./**)'];
    const denied = ['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Agent', 'NotebookEdit',
      'Edit(./' + SELF + ')', 'Write(./' + SELF + ')', 'Edit(./.git/**)', 'Write(./.git/**)', 'Edit(./node_modules/**)', 'Write(./node_modules/**)'];
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', '40', '--strict-mcp-config',
      '--append-system-prompt', RULES, '--allowedTools', allowed.join(','), '--disallowedTools', denied.join(',')];
    const session = getSession();
    if (session) args.push('--resume', session);
    try { proc = spawn(exe(), args, { cwd: r, windowsHide: true }); }
    catch (e) { proc = null; say({ who: 'sys', text: 'Couldn\'t start Claude: ' + e.message }); return { ok: false, error: e.message }; }
    log('RSI: started (pid ' + proc.pid + ')' + (session ? ', continuing the conversation' : ''));
    onEvent({ who: 'busy', busy: true });

    const p = proc;
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} }, TIMEOUT_MS);
    let buf = '', err = '', final = null, failed = false;
    p.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch (e) { continue; }
        if (m.session_id) setSession(m.session_id);
        if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
          for (const c of m.message.content) {
            if (c.type === 'tool_use') {
              const f = c.input && (c.input.file_path || c.input.path || c.input.pattern) || '';
              const short = path.isAbsolute(String(f)) ? path.relative(r, String(f)).replace(/\\/g, '/') : String(f);
              say({ who: 'sys', text: ({ Read: '📖 Reading ', Edit: '✏️ Editing ', Write: '📝 Writing ', Grep: '🔎 Searching ', Glob: '🔎 Looking for ' }[c.name] || c.name + ' ') + short });
            }
          }
        }
        if (m.type === 'result') { final = String(m.result || ''); failed = !!m.is_error; }
      }
    });
    p.stderr.on('data', (d) => { err += d; });
    p.stdin.on('error', () => {});
    p.stdin.end(text);
    p.on('error', (e) => { err += e.message; });
    p.on('close', (code) => {
      clearTimeout(killer); proc = null;
      log('RSI: Claude exited (code ' + code + ')');
      try { finish(r, base, text, code, final, failed, err); }
      catch (e) { say({ who: 'sys', text: 'Something went wrong wrapping up: ' + e.message }); }
      onEvent({ who: 'busy', busy: false });
    });
    return { ok: true };
  }

  function finish(r, base, text, code, final, failed, err) {
    if (final) say({ who: 'claude', text: final });
    else if (code !== 0) say({ who: 'sys', text: /log ?in|auth/i.test(err) ? 'Claude needs signing in again.' : 'Claude stopped without an answer' + (err ? ': ' + err.replace(/\s+/g, ' ').slice(0, 200) : '.') });
    // stopped or failed partway: never keep half a change
    const files = git(r, ['status', '--porcelain', '-uall']).split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ''));
    if (!files.length) return;
    if (failed || code !== 0 || !final) { discard(r, base); say({ who: 'sys', text: 'It didn\'t finish, so its partial edits were thrown away.' }); return; }
    const broken = files.map((f) => syntaxError(r, f)).filter(Boolean);
    if (broken.length) {
      discard(r, base);
      say({ who: 'sys', text: 'Its change didn\'t parse, so it was thrown away (nothing changed):\n' + broken.join('\n').slice(0, 400) + '\nAsk again and it can try another way.' });
      return;
    }
    git(r, ['add', '-A']);
    git(r, ['commit', '-q', '-m', 'RSI: ' + text.replace(/\s+/g, ' ').slice(0, 72), '-m', text + '\n\n' + final]);
    const hash = git(r, ['rev-parse', '--short', 'HEAD']);
    log('RSI: committed ' + hash + ' (' + files.join(', ') + ')');
    say({ who: 'change', text: 'Changed: ' + files.join(', '), files, hash, restart: needsRestart(files) });
  }

  function discard(r, base) {
    git(r, ['reset', '-q', '--hard', base]);
    git(r, ['clean', '-qfd']);
  }

  function undo() {
    const r = repo();
    if (!r) return { ok: false, error: 'No source folder.' };
    if (proc) return { ok: false, error: 'RSI is still working.' };
    if (git(r, ['status', '--porcelain'])) return { ok: false, error: 'There are uncommitted changes; undo them by hand.' };
    const last = lastRsiCommit(r);
    if (!last) return { ok: false, error: 'The latest commit isn\'t an RSI change, so there\'s nothing to undo.' };
    const files = git(r, ['show', '--name-only', '--format=', last.hash]).split('\n').filter(Boolean);
    git(r, ['revert', '--no-commit', last.hash]);
    git(r, ['commit', '-q', '-m', 'RSI undo: ' + last.subject.replace(/^RSI: /, '')]);
    log('RSI: undid ' + last.hash.slice(0, 7));
    say({ who: 'change', text: 'Undone: ' + last.subject.replace(/^RSI: /, ''), files, restart: needsRestart(files), undo: true });
    return { ok: true, restart: needsRestart(files) };
  }

  function stop() { if (proc) { try { proc.kill(); } catch (e) {} } return true; }

  function newChat() { setSession(null); chat.length = 0; return true; }

  return { status, ask, undo, stop, newChat };
}

module.exports = { create, syntaxError };
