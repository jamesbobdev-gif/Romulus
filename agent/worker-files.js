/* Files the local model's browser downloaded on its own computer (a worksheet off Blackboard) land in that
   computer's ~/Downloads, not on his laptop. They reach his other computers through Supabase, like everything
   else, so no device has to reach the mini PC (no SSH, no address):
   - the worker (agent/worker.js) puts each new file in the agent-files bucket and lists them in the ':files'
     row next to the agent list ({v:1, at, host, files: [{name, size, at, path, url}]}), on every heartbeat
     and after each browser task; a file that goes away on the worker comes out of the bucket too
   - another computer shows that list (Agent tab, main/downloads.js), downloads one from the bucket, and removes
     one by deleting it there and naming its key in the ':files-gone' row ({v:1, at, keys}), which the worker
     reads to move its own copy to the trash (recoverable there).
   The bucket is public, so the folder is a hash of the agent key, never the key (the same formula as
   renderer/js/agent-chat.js attachFolder). No Electron here, so it can be tested on its own. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const supabase = require('./supabase');

const FILES = ':files';
const GONE = ':files-gone';
const BUCKET = 'agent-files';
const MAX_BYTES = 10 * 1024 * 1024; // the bucket's limit (supabase/setup.sql, the local model's downloads): worksheets, not videos
const MAX_FILES = 100;
const KEEP_GONE = 200;
const SKIP = /\.(crdownload|part|tmp|deb|rpm|AppImage|exe|msi|bat|cmd|sh|ps1|lnk|jar|hta|scr|dll|apk|com|vbs)$/i; // half-downloaded and runnable files: never published
const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text', rtf: 'application/rtf', csv: 'text/csv', txt: 'text/plain', md: 'text/markdown',
  json: 'application/json', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }; // no html/svg/xml: a page served from the project's own address is a phishing page

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ext = (name) => ((String(name).match(/\.([A-Za-z0-9]{1,8})$/) || [])[1] || '').toLowerCase();
const mimeFor = (name) => MIME[ext(name)] || 'application/octet-stream';
const folderFor = (syncKey) => 'tk_agent_att_' + sha(syncKey).slice(0, 40);
// a file's identity across the two rows: the same name downloaded again (a new size or time) is a new file
const fileKey = (f) => String(f.name) + '|' + Number(f.size) + '|' + Number(f.at);
// where it goes in the bucket: the folder, then a name made from the key; the extension stays (viewers go by it)
const objectPath = (syncKey, f) => folderFor(syncKey) + '/dl-' + sha(fileKey(f)).slice(0, 24) + (ext(f.name) ? '.' + ext(f.name) : '');
const storageBase = (a) => String(a.url).replace(/\/+$/, '') + '/storage/v1/object/';
const publicUrl = (a, p) => storageBase(a) + 'public/' + BUCKET + '/' + p;
const entry = (f) => ({ name: String(f.name), size: Number(f.size) || 0, at: Number(f.at) || 0, path: f.path ? String(f.path) : undefined, url: f.url ? String(f.url) : undefined });
const badName = (n) => !n || /[\/\\\u0000]/.test(n) || n === '.' || n === '..';
// the folder the browser downloads into on the worker (browser-proxy.js sets it over CDP): only that is published,
// never the user's own Downloads
const downloadsDir = () => path.join(os.homedir(), 'Downloads', 'Romulus');
// a bucket path in the caller's own folder with a plain file name, as the upload policy admits them
const ownPath = (syncKey, p) => typeof p === 'string' && p.startsWith(folderFor(syncKey) + '/') && /^[A-Za-z0-9_-]+\/[A-Za-z0-9][A-Za-z0-9 ._()-]{0,119}$/.test(p);

// what's in the worker's Downloads: [{name, size, at}] newest first
function listDownloads(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    if (SKIP.test(name) || name.startsWith('.')) continue;
    let st; try { st = fs.lstatSync(path.join(dir, name)); } catch (e) { continue; } // lstat: a link to a file elsewhere is not a download
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    out.push({ name, size: st.size, at: Math.round(st.mtimeMs) });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, MAX_FILES);
}

/* What the worker publishes next (pure, for tests): the local files not named gone, each kept with the bucket
   path it already has or marked for upload → {keep (published entries still here), upload (new ones),
   drop (published entries whose file is gone from this computer: out of the bucket), trash (local paths another
   computer removed)} */
function plan(local, published, gone, dir = '') {
  const goneSet = new Set((gone || []).map(String));
  const have = new Map((published || []).filter((p) => p && p.path).map((p) => [fileKey(p), p]));
  const keep = [], upload = [], trash = [];
  const kept = new Set();
  for (const f of local || []) {
    const k = fileKey(f);
    if (goneSet.has(k)) { trash.push(path.join(dir, f.name)); continue; }
    const p = have.get(k);
    if (p) { keep.push(entry(p)); kept.add(k); } else upload.push(entry(f));
  }
  const drop = (published || []).filter((p) => p && p.path && !kept.has(fileKey(p)));
  return { keep, upload, drop, trash };
}
// the gone list after keys are added (pure): newest last, capped
const addGone = (gone, keys) => Array.from(new Set((gone || []).map(String).concat((keys || []).map(String)))).slice(-KEEP_GONE);
// two lists that say the same thing (pure): no row write for an unchanged list on every heartbeat
const sameList = (a, b) => JSON.stringify((a || []).map((f) => [fileKey(f), f.path || ''])) === JSON.stringify((b || []).map((f) => [fileKey(f), f.path || '']));

// to the trash, not deleted for good (gio on the mini PC's GNOME); a computer without gio leaves the file
function trashFiles(paths) {
  if (!paths.length) return Promise.resolve(false);
  return new Promise((resolve) => {
    let p;
    try { p = require('child_process').spawn('gio', ['trash', '--'].concat(paths), { stdio: 'ignore', windowsHide: true }); }
    catch (e) { return resolve(false); }
    const t = setTimeout(() => { try { p.kill(); } catch (e) {} resolve(false); }, 15000);
    p.on('exit', (code) => { clearTimeout(t); resolve(code === 0); });
    p.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

async function putObject(a, p, body, name, f = fetch) {
  // x-romulus-key: the storage policies let a request see and remove only the folder of the key it proves (setup.sql agent_folder_proved)
  const r = await f(storageBase(a) + BUCKET + '/' + p, { method: 'POST', body, headers: supabase.headers(a, { 'Content-Type': mimeFor(name), 'x-romulus-key': a.syncKey }), signal: AbortSignal.timeout(120000) });
  if (r.ok || r.status === 409) return true; // 409: already there from an earlier try
  throw new Error('upload failed (HTTP ' + r.status + ')');
}
async function deleteObject(a, p, f = fetch) {
  const r = await f(storageBase(a) + BUCKET + '/' + p, { method: 'DELETE', headers: supabase.headers(a, { 'x-romulus-key': a.syncKey }), signal: AbortSignal.timeout(20000) });
  if (!r.ok && r.status !== 404) throw new Error('remove failed (HTTP ' + r.status + ')');
  return true;
}
const rowFiles = (row) => (row && row.doc && Array.isArray(row.doc.files) ? row.doc.files : []).filter((x) => x && typeof x === 'object' && x.name).map(entry);
const rowGone = (row) => (row && row.doc && Array.isArray(row.doc.keys) ? row.doc.keys : []).map(String);

/* The worker's side: what's in Downloads goes up, what another computer removed goes to the trash, and the
   ':files' row says what's there. Returns true when the row is current. */
let syncing = null;
async function sync(a, { dir = downloadsDir(), fetch: f = fetch, trash = trashFiles, log = () => {} } = {}) {
  if (!a) return false;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  if (syncing) return syncing;
  syncing = (async () => {
    const [filesRow, goneRow] = await Promise.all([supabase.readRow(a, FILES, { fetch: f }), supabase.readRow(a, GONE, { fetch: f })]);
    const published = rowFiles(filesRow), gone = rowGone(goneRow);
    const { keep, upload, drop, trash: toTrash } = plan(listDownloads(dir), published, gone, dir);
    if (toTrash.length) { if (await trash(toTrash)) log('files: ' + toTrash.length + ' file(s) he removed went to the trash'); }
    const out = keep.slice();
    for (const x of upload) {
      const p = objectPath(a.syncKey, x);
      try {
        await putObject(a, p, fs.readFileSync(path.join(dir, x.name)), x.name, f);
        out.push(Object.assign({}, x, { path: p, url: publicUrl(a, p) }));
        log('files: ' + x.name + ' is on sync for his other devices');
      } catch (e) { log('files: ' + x.name + ' didn’t go up: ' + e.message); }
    }
    for (const p of drop) await deleteObject(a, p.path, f).catch((e) => log('files: ' + p.name + ' stayed in the bucket: ' + e.message));
    out.sort((x, y) => y.at - x.at);
    if (filesRow && sameList(published, out)) return true;
    return supabase.writeRow(a, FILES, { v: 1, at: Date.now(), host: os.hostname().slice(0, 60), files: out }, filesRow ? filesRow.updated_at : null, { fetch: f });
  })().finally(() => { syncing = null; });
  return syncing;
}

/* The other computers' side (main/downloads.js) */
// the worker's list: [{name, size, at, path, url}] newest first; [] when nothing was ever published
async function list(a, { fetch: f = fetch } = {}) {
  if (!a) return [];
  // the row names the files; where they are is rebuilt from the path, never taken from the row: a peer with the key
  // could otherwise point Download at any address this computer can reach
  return rowFiles(await supabase.readRow(a, FILES, { fetch: f })).filter((x) => !badName(x.name) && ownPath(a.syncKey, x.path))
    .map((x) => Object.assign({}, x, { url: publicUrl(a, x.path) }));
}
// one file from the bucket → a file here; a failed copy leaves nothing behind
async function download(entryToGet, toFile, { fetch: f = fetch } = {}) {
  const r = await f(String(entryToGet.url), { signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!r.ok) throw new Error('the file isn’t on sync any more (HTTP ' + r.status + ')');
  const len = Number(r.headers && typeof r.headers.get === 'function' ? r.headers.get('content-length') : 0);
  if (len > MAX_BYTES) throw new Error('the file is larger than the bucket allows');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('the file is larger than the bucket allows');
  if (entryToGet.size && buf.length !== Number(entryToGet.size)) throw new Error('the copy came back the wrong size');
  fs.writeFileSync(toFile, buf);
  return toFile;
}
// done with them: out of the bucket, off the list, and named gone so the worker trashes its copies
async function remove(a, entries, { fetch: f = fetch } = {}) {
  if (!a || !entries.length) return false;
  for (const x of entries) if (ownPath(a.syncKey, x.path)) await deleteObject(a, x.path, f).catch(() => {}); // the worker drops a leftover on its next pass
  const keys = entries.map(fileKey);
  for (let i = 0; i < 2; i++) { // compare-and-swap like every row; a write that lost a race reads again and tries once more
    const row = await supabase.readRow(a, GONE, { fetch: f });
    if (await supabase.writeRow(a, GONE, { v: 1, at: Date.now(), keys: addGone(rowGone(row), keys) }, row ? row.updated_at : null, { fetch: f })) break;
  }
  const filesRow = await supabase.readRow(a, FILES, { fetch: f }).catch(() => null); // off the list now, not at the worker's next pass
  if (filesRow) {
    const left = rowFiles(filesRow).filter((x) => !keys.includes(fileKey(x)));
    if (left.length !== rowFiles(filesRow).length) await supabase.writeRow(a, FILES, Object.assign({}, filesRow.doc, { at: Date.now(), files: left }), filesRow.updated_at, { fetch: f }).catch(() => {});
  }
  return true;
}

module.exports = { FILES, GONE, BUCKET, MAX_BYTES, mimeFor, folderFor, fileKey, objectPath, publicUrl, downloadsDir, ownPath, listDownloads, plan, addGone, sameList, trashFiles, sync, list, download, remove };
