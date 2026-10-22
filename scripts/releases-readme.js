/* Keeps the README on the public installers repo (scripts/releases-readme.md) up to date through the
   GitHub API. Run on its own (`node scripts/releases-readme.js`) or from scripts/release.js. Needs gh signed in. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const pkg = require('../package.json');
const { owner, repo } = pkg.build.publish;
const file = path.join(__dirname, 'releases-readme.md');
const api = (args, input) => execFileSync('gh', ['api', ...args], { encoding: 'utf8', input, windowsHide: true });

function syncReadme() {
  const want = fs.readFileSync(file, 'utf8');
  let sha = null;
  try {
    const cur = JSON.parse(api([`repos/${owner}/${repo}/contents/README.md`]));
    if (Buffer.from(cur.content, 'base64').toString('utf8') === want) { console.log('releases README is current'); return false; }
    sha = cur.sha;
  } catch (e) {} // none yet: made below
  const body = { message: 'README: how to install, what this repository is', content: Buffer.from(want).toString('base64') };
  if (sha) body.sha = sha;
  api([`repos/${owner}/${repo}/contents/README.md`, '-X', 'PUT', '--input', '-'], JSON.stringify(body));
  console.log(`releases README updated on ${owner}/${repo}`);
  return true;
}

if (require.main === module) syncReadme();
module.exports = { syncReadme };
