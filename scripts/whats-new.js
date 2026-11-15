/* The "what changed" lines each release carries (renderer/js/whats-new.js, where the newest entry is written as
   version 'next' while work goes on). At release, stamp() puts the version in and refuses a version with no lines,
   since the point is that every update says what it is; notesFor() reads a version's lines back for the release
   page (scripts/releases-readme.js). Run from scripts/release.js; test/whats-new.test.js covers it. */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'renderer', 'js', 'whats-new.js');
const NEXT = /version:\s*'next'/;

// the file's text with 'next' stamped as this version; unchanged when that version is already in it; throws when neither
function stamp(src, version) {
  const v = String(version).replace(/^v/, '');
  if (new RegExp("version:\\s*'" + v.replace(/\./g, '\\.') + "'").test(src)) return src;
  if (!NEXT.test(src)) throw new Error('No notes for ' + v + ": add what changed under the top entry (version 'next') of renderer/js/whats-new.js, one line per change");
  return src.replace(NEXT, "version:'" + v + "'");
}
// true when the file changed
function stampFile(version) {
  const src = fs.readFileSync(FILE, 'utf8');
  const out = stamp(src, version);
  if (out !== src) { fs.writeFileSync(FILE, out); console.log('what changed: the notes under next are now ' + String(version).replace(/^v/, '')); }
  return out !== src;
}
// a version's lines, or null; 'next' counts as the version asked for (a build carries whatever the file says)
function notesFor(version, entries) {
  const v = String(version).replace(/^v/, '');
  if (!entries) { delete require.cache[require.resolve(FILE)]; entries = require(FILE).WHATS_NEW; }
  const lines = [];
  for (const e of entries) if (e && (e.version === v || e.version === 'next') && Array.isArray(e.notes)) lines.push(...e.notes);
  return lines.length ? lines : null;
}

module.exports = { FILE, stamp, stampFile, notesFor };
