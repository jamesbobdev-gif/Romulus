// Claude Code hook for the Tasks agent's Claude runs (agent/runner.js passes it with --settings): what James
// writes on a task while Claude works on it. The runner drops each message in <inbox> as a file; after every
// tool call (PostToolUse) this hands the waiting ones to Claude, and when Claude is about to finish (Stop) it
// keeps it going with them. Taking a message = moving its file to <heard>, which is how the runner knows
// Claude saw it. agent/runner.js copies this file out of the app (hooks run with plain node).
// Usage: node run-inbox.js <inbox dir> <heard dir> PostToolUse|Stop
const fs = require('fs');
const path = require('path');
const [inbox, heard, event] = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const got = [];
  let names = [];
  try { names = fs.readdirSync(inbox).filter((n) => n.endsWith('.json')).sort(); } catch (e) {}
  for (const n of names) {
    const to = path.join(heard, n);
    try { fs.renameSync(path.join(inbox, n), to); } catch (e) { continue; } // gone already: another hook took it
    try { got.push(JSON.parse(fs.readFileSync(to, 'utf8'))); } catch (e) {}
  }
  if (!got.length) process.exit(0);
  const text = 'James just wrote on his task while you were working (his own words, same as a reply in the app):\n' +
    got.map((m) => '- task ' + m.id + (m.title ? ' ("' + m.title + '")' : '') + ': ' + m.text +
      (m.photos ? ' [+' + m.photos + ' photo(s): you get them next round]' : '')).join('\n') +
    '\nTake it into account now: change course, drop or add steps, and update your plan (TaskUpdate/TaskCreate) to match. ' +
    'A yes sent this way does not unlock a final step in this run: finish with needs-you and say you\'ll do it next.';
  if (event === 'Stop') process.stdout.write(JSON.stringify({ decision: 'block', reason: text }));
  else process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }));
  process.exit(0);
});
