/* His files for forms (agent/agent-files.js: the resume a job site asks for) on every one of his computers, so
   the mini PC's browser can attach the resume he added on his desk. Like the worker's downloads
   (agent/worker-files.js) they travel through the agent-files bucket, with two differences:
   - A resume has his name, address and phone in it, and that bucket is public (a file is served to anyone who has
     its exact address). So a file goes up encrypted (AES-256-GCM under a key made from the agent sync key) as
     an unnamed .bin, whether or not his lists are encrypted. The bucket holds nothing readable.
   - The bucket is emptied of anything older than 30 days (supabase/functions/attachments-cleanup). A computer
     that has the file puts it up again under a new address before then (REFRESH_MS).
   What exists is listed in the ':forms' row next to the agent list (sealed when the lists are):
     { v: 1, files: [{name, size, sha, at, path, up}], gone: {name: at} }
   A file is known by its name. Each computer remembers what it had at its last sync (form-files-sync.json), so
   it can tell "changed here" from "changed there", and a file removed on one computer is removed on the others.
   A file this computer has never synced is never deleted by a removal made elsewhere: it goes up instead.
   No Electron here, so it can be tested on its own. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const agentFiles = require('./agent-files');
const wf = require('./worker-files');

const SUFFIX = ':forms';
const MAX_FILES = 20;
const KEEP_GONE = 100;
const DAY = 24 * 3600 * 1000;
const REFRESH_MS = 20 * DAY; // the cleanup takes files at 30 days
const INFO = 'romulus-form-files-v1';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function fileKey(syncKey) {
  const s = Buffer.from(INFO, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(syncKey), 'utf8'), s, s, 32));
}
// iv (12) + ciphertext + tag (16)
function sealFile(syncKey, buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', fileKey(syncKey), iv);
  return Buffer.concat([iv, c.update(buf), c.final(), c.getAuthTag()]);
}
function openFile(syncKey, sealed) {
  if (!Buffer.isBuffer(sealed) || sealed.length < 28) throw new Error('not a sealed file');
  const d = crypto.createDecipheriv('aes-256-gcm', fileKey(syncKey), sealed.subarray(0, 12));
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(12, sealed.length - 16)), d.final()]);
}
// where a file goes in the bucket: his folder, then a name that says nothing. The day it went up is part of it,
// so a second try the same day lands on the same object and a refresh makes a new one
const dayOf = (now) => Math.floor(now / DAY) * DAY;
const objectPath = (syncKey, f, up) => wf.folderFor(syncKey) + '/ff-' + sha256(f.name + '|' + f.sha + '|' + up).slice(0, 24) + '.bin';

const okName = (n) => typeof n === 'string' && !!n && agentFiles.safeName(n) === n && agentFiles.KINDS.test(n) && n !== '.' && n !== '..';
function cleanEntry(e) {
  if (!e || typeof e !== 'object' || !okName(e.name) || !/^[0-9a-f]{64}$/.test(String(e.sha))) return null;
  const size = Number(e.size), at = Number(e.at), up = Number(e.up);
  if (!(size > 0 && size <= agentFiles.MAX_BYTES) || !(at > 0)) return null;
  return { name: e.name, size, sha: e.sha, at, path: typeof e.path === 'string' ? e.path : '', up: up > 0 ? up : 0 };
}
function cleanDoc(doc) {
  const files = new Map(), gone = {};
  if (doc && typeof doc === 'object') {
    (Array.isArray(doc.files) ? doc.files : []).map(cleanEntry).filter(Boolean).forEach((e) => { if (!files.has(e.name)) files.set(e.name, e); });
    const g = doc.gone && typeof doc.gone === 'object' ? doc.gone : {};
    for (const n of Object.keys(g)) if (okName(n) && Number(g[n]) > 0) gone[n] = Number(g[n]);
  }
  return { files, gone };
}

/* What to do (pure, for tests).
   local: [{name, size, sha}] in the folder now; known: {name: {sha, at}} as of this computer's last sync;
   doc: the row; own(path): is this a place in his own bucket folder (false after the sync key changed).
   → { upload: [{name, size, sha, at, drop?}] (put it up; drop = the object it replaces),
       download: [entry], removeLocal: [name], dropObjects: [path],
       files (the row's entries that stay as they are), gone } */
function plan(local, known, doc, now, own = () => true) {
  const row = cleanDoc(doc), k = known && typeof known === 'object' ? known : {};
  const mine = new Map((local || []).map((f) => [f.name, f]));
  const names = [...new Set([...mine.keys(), ...row.files.keys(), ...Object.keys(k)])].sort();
  const out = { upload: [], download: [], removeLocal: [], dropObjects: [], files: [], gone: Object.assign({}, row.gone) };
  const drop = (r) => { if (r && r.path && own(r.path)) out.dropObjects.push(r.path); };
  for (const name of names) {
    const L = mine.get(name), R = row.files.get(name), K = k[name], G = row.gone[name] || 0;
    const mineChanged = !!L && (!K || K.sha !== L.sha);          // new here, or edited here, since the last sync
    const theirsChanged = !!R && (!K || K.sha !== R.sha);        // new there, or replaced there
    const at = L ? (mineChanged ? (K ? now : (L.mtime || now)) : K.at) : 0;
    if (L && R) {
      if (L.sha === R.sha) {
        // the same file. Up again if its place is not in his folder any more, or the cleanup is due
        if (!own(R.path) || now - (R.up || 0) > REFRESH_MS) out.upload.push({ name, size: L.size, sha: L.sha, at: R.at, drop: R.path });
        else out.files.push(R);
      } else if (mineChanged && (!theirsChanged || at > R.at)) out.upload.push({ name, size: L.size, sha: L.sha, at, drop: R.path });
      else if (own(R.path)) out.download.push(R);
      else out.files.push(R); // a newer one this computer can't fetch (put up under an older key): left for a computer that has it
      delete out.gone[name];
    } else if (L) {
      // not in the row. Removed elsewhere only counts against a file this computer had synced and not touched since
      if (G && K && !mineChanged) out.removeLocal.push(name);
      else { out.upload.push({ name, size: L.size, sha: L.sha, at: Math.max(at, G + 1) }); delete out.gone[name]; }
    } else if (R) {
      if (K && !theirsChanged) { out.gone[name] = now; drop(R); }  // had it, deleted it here, nobody replaced it since
      else if (G >= R.at) drop(R);                                  // a leftover of a file that was removed
      else if (own(R.path)) out.download.push(R);
      else out.files.push(R);
    }
    // only in known: deleted here and already gone from the row; nothing to do
  }
  const goneNames = Object.keys(out.gone).sort((a, b) => out.gone[a] - out.gone[b]).slice(-KEEP_GONE);
  const gone = {}; goneNames.sort().forEach((n) => { gone[n] = out.gone[n]; });
  out.gone = gone;
  return out;
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } };
// the folder as it is: [{name, size, sha, mtime}]. A file unchanged since last time (same size and time) is not read again
function scan(dir, seen) {
  return agentFiles.list(dir).filter((f) => okName(f.name) && f.size > 0 && f.size <= agentFiles.MAX_BYTES).slice(0, MAX_FILES).map((f) => {
    let mtime = 0; try { mtime = Math.round(fs.statSync(f.path).mtimeMs); } catch (e) {}
    const s = seen && seen[f.name];
    const sha = s && s.size === f.size && s.mtime === mtime && s.fileSha ? s.fileSha : sha256(fs.readFileSync(f.path));
    return { name: f.name, size: f.size, sha, mtime };
  });
}

async function getObject(a, p, f = fetch) {
  const r = await f(wf.publicUrl(a, p), { signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!r.ok) throw new Error('not on sync any more (HTTP ' + r.status + ')');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > agentFiles.MAX_BYTES + 64) throw new Error('larger than a file for forms may be');
  return buf;
}

/* one pass. o: { a (the agent channel), supabase, dir (form-files), state (form-files-sync.json), fetch?, now?, log? }
   → {ok, got: [names that arrived], sent: [names put up], removed: [names removed here]} or {ok: false, error}. Never throws. */
let running = null;
function sync(o) {
  if (running) return running;
  running = once(o).catch((e) => ({ ok: false, error: String((e && e.message) || e) })).finally(() => { running = null; });
  return running;
}
async function once(o) {
  const { a, supabase, dir, state } = o, f = o.fetch || fetch, log = o.log || (() => {});
  if (!a) return { ok: false, error: 'sync isn’t set up on this computer' };
  const own = (p) => wf.ownPath(a.syncKey, p);
  const got = [], sent = [], removed = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = o.now ? o.now() : Date.now();
    const row = await supabase.readRow(a, SUFFIX, { fetch: f });
    const st = readJson(state, {}), known = st.known && typeof st.known === 'object' ? st.known : {};
    const local = scan(dir, known);
    const p = plan(local, known, row ? row.doc : null, now, own);
    const files = p.files.slice(), nextKnown = {};
    const localBy = new Map(local.map((x) => [x.name, x]));
    const keepKnown = (name, sha, at) => {
      let size = 0, mtime = 0; try { const s = fs.statSync(path.join(dir, name)); size = s.size; mtime = Math.round(s.mtimeMs); } catch (e) {}
      nextKnown[name] = { sha, at, size, mtime, fileSha: sha };
    };
    for (const e of p.files) { const L = localBy.get(e.name); if (L && L.sha === e.sha) keepKnown(e.name, e.sha, e.at); else if (known[e.name]) nextKnown[e.name] = known[e.name]; }
    // 1. what another computer has and this one doesn't
    for (const e of p.download) {
      try {
        const plain = openFile(a.syncKey, await getObject(a, e.path, f));
        if (plain.length !== e.size || sha256(plain) !== e.sha) throw new Error('the copy does not match what was put up');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, e.name + '.part'), plain);
        fs.renameSync(path.join(dir, e.name + '.part'), path.join(dir, e.name));
        keepKnown(e.name, e.sha, e.at);
        if (!got.includes(e.name)) got.push(e.name);
      } catch (err) {
        try { fs.unlinkSync(path.join(dir, e.name + '.part')); } catch (x) {}
        log('files for forms: ' + e.name + ' didn’t arrive: ' + err.message);
        if (known[e.name]) nextKnown[e.name] = known[e.name];
      }
      files.push(e); // it stays listed either way
    }
    // 2. what was removed on another computer
    for (const name of p.removeLocal) {
      try { fs.unlinkSync(path.join(dir, name)); if (!removed.includes(name)) removed.push(name); }
      catch (err) { log('files for forms: ' + name + ' could not be removed here: ' + err.message); nextKnown[name] = known[name]; }
    }
    // 3. what this computer has that the row doesn't (or has newer, or is due a refresh)
    const drops = p.dropObjects.slice();
    for (const u of p.upload) {
      const up = dayOf(now), dest = objectPath(a.syncKey, u, up);
      try {
        await wf.putObject(a, dest, sealFile(a.syncKey, fs.readFileSync(path.join(dir, u.name))), 'sealed.bin', f);
        files.push({ name: u.name, size: u.size, sha: u.sha, at: u.at, path: dest, up });
        keepKnown(u.name, u.sha, u.at);
        if (u.drop && u.drop !== dest && own(u.drop)) drops.push(u.drop);
        if (!sent.includes(u.name)) sent.push(u.name);
      } catch (err) {
        log('files for forms: ' + u.name + ' didn’t go up: ' + err.message);
        const old = cleanDoc(row ? row.doc : null).files.get(u.name);
        if (old) files.push(old); // what was listed stays listed
        if (known[u.name]) nextKnown[u.name] = known[u.name];
      }
    }
    files.sort((x, y) => x.name.localeCompare(y.name));
    const next = Object.assign({}, row ? row.doc : null, { v: 1, files: files.slice(0, MAX_FILES), gone: p.gone });
    const same = row && JSON.stringify(next) === JSON.stringify(row.doc);
    const saveState = () => { try { fs.mkdirSync(path.dirname(state), { recursive: true }); fs.writeFileSync(state, JSON.stringify({ known: nextKnown })); } catch (e) {} };
    if (same || (!row && !files.length && !Object.keys(p.gone).length)) { saveState(); return { ok: true, got, sent, removed }; }
    if (await supabase.writeRow(a, SUFFIX, next, row ? row.updated_at : null, { fetch: f })) {
      saveState();
      for (const d of [...new Set(drops)]) await wf.deleteObject(a, d, f).catch(() => {}); // a leftover goes with the 30-day cleanup
      return { ok: true, got, sent, removed };
    }
    // the row changed meanwhile: what arrived or was removed here is remembered, the rest is planned again
    try { fs.writeFileSync(state, JSON.stringify({ known: Object.assign({}, known, nextKnown) })); } catch (e) {}
  }
  return { ok: false, error: 'the list of files kept changing while it was being written' };
}

module.exports = { SUFFIX, REFRESH_MS, MAX_FILES, sealFile, openFile, objectPath, plan, scan, sync };
