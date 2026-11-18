/* Release check on known vulnerabilities (.github/workflows/release.yml). Stops the release on any high or
   critical advisory in what ships or the build tooling, except the ones listed in ALLOWED below. An allowed one
   is still printed as a warning on every run, so it is not forgotten.
   Only add an advisory here when no fixed version exists yet and it cannot reach users, with the reason and a
   date, and take it out again as soon as a fix is out. Run locally with: node scripts/audit-gate.js */
const { execSync } = require('child_process');

const ALLOWED = {
  // picomatch <= 4.0.7, ReDoS on crafted glob patterns. 2026-11-17: no fixed release exists. Only reached through
  // electron-builder > @electron/rebuild > node-gyp > tinyglobby at build time, on our own globs; not in the app.
  'GHSA-fc5q-39xc-vjpf': 'picomatch, build tooling only, no fix released yet',
};

function blockingAdvisories(report, allowed) {
  const seen = new Map();
  for (const v of Object.values(report.vulnerabilities || {})) {
    for (const via of v.via || []) {
      if (typeof via !== 'object' || !via) continue; // a string just points at another flagged package
      if (via.severity !== 'high' && via.severity !== 'critical') continue;
      const id = String(via.url || '').split('/').pop() || String(via.source);
      if (!seen.has(id)) seen.set(id, { id, name: via.name, severity: via.severity, title: via.title, allowed: id in allowed });
    }
  }
  return [...seen.values()];
}

if (require.main === module) {
  let out;
  try { out = execSync('npm audit --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { out = e.stdout; } // npm audit exits non-zero whenever it finds anything
  let report;
  try { report = JSON.parse(out); } catch { console.error('npm audit did not return JSON:\n' + String(out).slice(0, 2000)); process.exit(1); }
  const found = blockingAdvisories(report, ALLOWED);
  for (const a of found.filter(a => a.allowed)) console.log(`::warning::allowed for now: ${a.id} ${a.name} (${a.severity}) - ${ALLOWED[a.id]}`);
  const blocking = found.filter(a => !a.allowed);
  for (const a of blocking) console.log(`::error::${a.id} ${a.name} (${a.severity}): ${a.title}`);
  if (blocking.length) process.exit(1);
  console.log('No high or critical advisories outside the allowed list.');
}

module.exports = { blockingAdvisories, ALLOWED };
