/* The runner's own log (<userData>/agent-runner.log, written by store.agentLog): which run started, which AI
   answered, what failed and why. Settings → What the Agent did shows its tail next to the actions and the
   tasks' conversations, so a run that went wrong can be read back instead of guessed at. Read-only. */
const fs = require('fs');
const path = require('path');

const MAX_LINES = 500;
let ctx = null; // { userData }
function init(c) { ctx = c; }
const handlers = {};
const handle = (ch, fn) => { handlers[ch] = fn; };

// the last lines, oldest first: [{at, text}] (at = ms, from the ISO stamp each line starts with)
function tail(file, max = MAX_LINES) {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } };
  let lines = read(file).split('\n').filter(Boolean);
  if (lines.length < max) lines = read(file + '.old').split('\n').filter(Boolean).concat(lines); // the rotated part when the new one is short
  return lines.slice(-max).map((l) => {
    const m = l.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (.*)$/);
    return m ? { at: Date.parse(m[1]) || 0, text: m[2] } : { at: 0, text: l };
  });
}
handle('agent:log', () => tail(path.join(ctx.userData(), 'agent-runner.log')));

module.exports = { init, handlers, tail };
