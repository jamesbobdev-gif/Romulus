// Claude Code PreToolUse hook for the Tasks agent's web runs (main.js passes it with --settings, for
// WebFetch and WebSearch). Once the agent browser has shown James's mail in this run, browser-proxy.js
// writes the taint file; from then on this refuses the web tools, so nothing read in his mail can be
// sent to a server through a fetched address or a search. Exit code 2 = refused (the reason goes to Claude).
// main.js copies this file next to browser-proxy.js. Usage: node web-guard.js <taint file>
const fs = require('fs');
const taintFile = process.argv[2];
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let tool = 'this tool';
  try { tool = JSON.parse(input).tool_name || tool; } catch (e) {}
  if (taintFile && fs.existsSync(taintFile)) {
    process.stderr.write(tool + ' is off for the rest of this run: it has opened James\'s mail, and a page could have asked ' +
      'for what is in it to be sent somewhere. Finish with what you have and say in your note what is left for next time.\n');
    process.exit(2);
  }
  process.exit(0);
});
