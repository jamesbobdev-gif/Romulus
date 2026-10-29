/* npm run release: build the installer and put it on GitHub, where every installed copy picks it up
   (main/updater.js). Bumps the patch version first (1.0.1 → 1.0.2), since the installed copies only
   take a version newer than theirs. Pass a version to set it instead: npm run release -- 1.2.0
   Needs `gh auth login` once on this computer. The installer goes to a public repo of its own
   (jamesbobdev-gif/romulus-releases): it holds no personal data, the code stays in the private one. */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgFile = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const { owner, repo } = pkg.build.publish;
const run = (cmd, opts = {}) => execSync(cmd, Object.assign({ cwd: root, encoding: 'utf8' }, opts));

let token;
try { token = run('gh auth token', { stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) {}
if (!token) { console.error('Not signed in to GitHub. Run: gh auth login'); process.exit(1); }

try { run(`gh repo view ${owner}/${repo}`, { stdio: 'ignore' }); } catch (e) {
  console.log(`Making ${owner}/${repo} (public, installers only)…`);
  run(`gh repo create ${owner}/${repo} --public --description "Installers for Romulus (auto-update)" --add-readme`, { stdio: 'inherit' });
}

const bump = (v) => v.split('.').map(Number).map((n, i) => (i === 2 ? n + 1 : n)).join('.');
pkg.version = process.argv[2] || bump(pkg.version);
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
console.log('Releasing ' + pkg.version);

// the public repo's README (install steps, what the repo is) travels with each release
try { require('./releases-readme').syncReadme(); } catch (e) { console.log('releases README not updated: ' + e.message); }
run('npx electron-builder --win --publish always', { stdio: 'inherit', env: Object.assign({}, process.env, { GH_TOKEN: token }) });
// installed copies find the new version only through latest.yml; v1.0.4 went out without it, so check, and
// attach this build's own copy if electron-builder didn't
const tag = 'v' + pkg.version;
const assets = run(`gh release view ${tag} --repo ${owner}/${repo} --json assets --jq ".assets[].name"`).split(/\r?\n/);
if (!assets.includes('latest.yml')) {
  const yml = path.join(root, 'dist', 'latest.yml');
  if (!fs.readFileSync(yml, 'utf8').includes(`version: ${pkg.version}`)) { console.error(`dist/latest.yml is not for ${pkg.version}; the release has no latest.yml, so installed copies won't update`); process.exit(1); }
  run(`gh release upload ${tag} "${yml}" --repo ${owner}/${repo}`, { stdio: 'inherit' });
  console.log('latest.yml was missing from the release: attached');
}
// the release page: say which file to download (GitHub adds source archives of its own that hold only the README)
try { require('./releases-readme').writeNotes(pkg.version); } catch (e) { console.log('release notes not written: ' + e.message); }
console.log(`Done: ${pkg.version} is on https://github.com/${owner}/${repo}/releases — Windows copies update within a few hours.`);
console.log(`For the phone, Mac and Linux too: git commit -am "v${pkg.version}" && git tag v${pkg.version} && git push origin main v${pkg.version} (runs the release workflow).`);
