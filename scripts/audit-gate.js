/* The release's security gate (.github/workflows/release.yml): a high or critical advisory anywhere, in what ships or
   in the build tools that make the installer and the APK, stops the release, unless that exact advisory is listed in
   scripts/audit-allow.json with a reason and a date it runs out. So one known problem with no fix yet (picomatch,
   2026-11) doesn't stop every release, and a new one still does. Expired entries stop it too, to be looked at again.
   node scripts/audit-gate.js            reads `npm audit --json` itself
   The pure part (which advisories block) is exported for test/audit-gate.test.js. */
'use strict';
const fs = require('fs');
const path = require('path');

const BLOCKS = ['high', 'critical'];
// `npm audit --json` (v2) → [{id: 'GHSA-…', severity, title, pkg}] for every advisory at a blocking level
function blockingAdvisories(report) {
  const out = [], seen = new Set();
  for (const [pkg, v] of Object.entries((report && report.vulnerabilities) || {})) {
    for (const via of Array.isArray(v.via) ? v.via : []) {
      if (!via || typeof via !== 'object' || !BLOCKS.includes(via.severity)) continue;
      const id = (String(via.url || '').match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i) || [String(via.source || via.title || pkg)])[0];
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, severity: via.severity, title: String(via.title || ''), pkg });
    }
  }
  return out;
}
// → {blocked: [...], allowed: [...], expired: [...]} for today's date (YYYY-MM-DD)
function judge(advisories, allow, today) {
  const byId = new Map((Array.isArray(allow) ? allow : []).map((a) => [String(a.id).toUpperCase(), a]));
  const res = { blocked: [], allowed: [], expired: [] };
  for (const a of advisories) {
    const ok = byId.get(String(a.id).toUpperCase());
    if (!ok) res.blocked.push(a);
    else if (!ok.until || String(ok.until) < today) res.expired.push(Object.assign({ until: ok.until || '(no date)' }, a));
    else res.allowed.push(Object.assign({ reason: ok.reason, until: ok.until }, a));
  }
  return res;
}

if (require.main === module) {
  const { execSync } = require('child_process');
  let raw;
  try { raw = execSync('npm audit --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { raw = e.stdout; } // npm audit exits non-zero when it finds anything; the report is still on stdout
  let report;
  try { report = JSON.parse(raw); } catch (e) { console.error('audit-gate: npm audit gave no report'); process.exit(1); }
  const allow = JSON.parse(fs.readFileSync(path.join(__dirname, 'audit-allow.json'), 'utf8'));
  const r = judge(blockingAdvisories(report), allow, new Date().toISOString().slice(0, 10));
  for (const a of r.allowed) console.log(`::warning::${a.severity} ${a.id} (${a.pkg}) allowed until ${a.until}: ${a.reason}`);
  for (const a of r.expired) console.log(`::error::${a.severity} ${a.id} (${a.pkg}): its allowance ran out on ${a.until}; check it again`);
  for (const a of r.blocked) console.log(`::error::${a.severity} ${a.id} (${a.pkg}): ${a.title}`);
  if (r.blocked.length || r.expired.length) process.exit(1);
  console.log('audit-gate: no high or critical advisories outside scripts/audit-allow.json');
}

module.exports = { blockingAdvisories, judge };
