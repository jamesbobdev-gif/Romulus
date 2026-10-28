/* The app was called Tasks before it was Romulus. Electron names the user-data folder after the
   product, so a renamed app would start empty for everyone who had been using it. On the first run
   as Romulus, move the old folder's contents across. Pure: main.js passes the two folders and fs.
   File by file: one locked file (the Agent's Chrome still running on its profile) is skipped rather
   than stopping the rest. tasks.json goes last and marks it done; until it's there, every launch copies
   again, and the old files win over what a failed launch made (its own Local State would hold a new
   encryption key that can't open the sealed settings or the Finance vault). */
const path = require('path');

function copyTree(src, dst, fsx, skipped) {
  fsx.mkdirSync(dst, { recursive: true });
  for (const ent of fsx.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    try {
      if (ent.isDirectory()) copyTree(s, d, fsx, skipped);
      else if (ent.isFile()) fsx.copyFileSync(s, d);
    } catch (e) { skipped.push(s); }
  }
}

function migrateUserData(oldDir, newDir, fsx = require('fs')) {
  if (!oldDir || !newDir || path.resolve(oldDir) === path.resolve(newDir)) return { moved: false, reason: 'same folder' };
  const marker = 'tasks.json';
  if (!fsx.existsSync(path.join(oldDir, marker))) return { moved: false, reason: 'nothing to migrate' };
  if (fsx.existsSync(path.join(newDir, marker))) return { moved: false, reason: 'already migrated' };
  // Copy rather than move: the old folder stays as a backup, and the old Tasks install still works if it is ever run.
  const skipped = [];
  fsx.mkdirSync(newDir, { recursive: true });
  for (const ent of fsx.readdirSync(oldDir, { withFileTypes: true })) {
    if (ent.name === marker) continue;
    const s = path.join(oldDir, ent.name), d = path.join(newDir, ent.name);
    try {
      if (ent.isDirectory()) copyTree(s, d, fsx, skipped);
      else if (ent.isFile()) fsx.copyFileSync(s, d);
    } catch (e) { skipped.push(s); }
  }
  fsx.copyFileSync(path.join(oldDir, marker), path.join(newDir, marker)); // throws if it can't: tried again next launch
  if (skipped.length) console.warn('user-data migration skipped ' + skipped.length + ' file(s) in use, e.g. ' + skipped[0]);
  return { moved: true, how: 'copied', skipped: skipped.length };
}

module.exports = { migrateUserData };
