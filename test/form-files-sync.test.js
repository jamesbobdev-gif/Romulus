const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ff = require('../agent/form-files-sync');
const wf = require('../agent/worker-files');

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 10, 28, 12);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const A = sha('a'), B = sha('b');
const KEY = 'tk_agent_6f1d2c3b-4a5e-4f60-9b7c-8d9e0f1a2b3c';
const own = (p) => wf.ownPath(KEY, p);
const at = (name, s, when, up) => ({ name, size: 10, sha: s, at: when, path: ff.objectPath(KEY, { name, sha: s }, up || NOW), up: up || NOW });
const names = (list) => list.map((x) => x.name);

test('a file goes up sealed: the bucket copy is unreadable, opens only with his key, and a changed byte is refused', () => {
  const plain = Buffer.from('Resume of Alex Example, 12 Sample Street, 555 0100');
  const sealed = ff.sealFile(KEY, plain);
  assert.ok(!sealed.includes(Buffer.from('Alex Example')));
  assert.deepStrictEqual(ff.openFile(KEY, sealed), plain);
  assert.throws(() => ff.openFile(KEY + 'x', sealed));
  const bent = Buffer.from(sealed); bent[20] ^= 1;
  assert.throws(() => ff.openFile(KEY, bent));
  assert.throws(() => ff.openFile(KEY, Buffer.from('short')));
  // its place in the bucket is in his own folder, with a name that says nothing about the file
  const p = ff.objectPath(KEY, { name: 'Resume.pdf', sha: A }, NOW);
  assert.ok(own(p) && /\/ff-[0-9a-f]{24}\.bin$/.test(p) && !/resume/i.test(p));
});

test('a file added here goes up; one another computer has comes down', () => {
  const p = ff.plan([{ name: 'Resume.pdf', size: 10, sha: A, mtime: NOW - 5 }], {}, { v: 1, files: [at('Transcript.pdf', B, NOW - 9)] }, NOW, own);
  assert.deepStrictEqual(p.upload, [{ name: 'Resume.pdf', size: 10, sha: A, at: NOW - 5 }]);
  assert.deepStrictEqual(names(p.download), ['Transcript.pdf']);
  assert.deepStrictEqual([p.removeLocal, p.dropObjects], [[], []]);
});

test('once both have the same files nothing moves, until the 30-day cleanup is near', () => {
  const row = { v: 1, files: [at('Resume.pdf', A, NOW - 9)] }, local = [{ name: 'Resume.pdf', size: 10, sha: A, mtime: 1 }], known = { 'Resume.pdf': { sha: A, at: NOW - 9 } };
  const p = ff.plan(local, known, row, NOW, own);
  assert.deepStrictEqual([p.upload, p.download, p.removeLocal, p.dropObjects], [[], [], [], []]);
  assert.deepStrictEqual(names(p.files), ['Resume.pdf']);
  const later = ff.plan(local, known, row, NOW + ff.REFRESH_MS + DAY, own);
  assert.deepStrictEqual(later.upload, [{ name: 'Resume.pdf', size: 10, sha: A, at: NOW - 9, drop: row.files[0].path }]);
});

test('a newer version wins whichever side made it', () => {
  const known = { 'Resume.pdf': { sha: A, at: NOW - 9 } };
  // edited here since the last sync
  const mine = ff.plan([{ name: 'Resume.pdf', size: 10, sha: B, mtime: 1 }], known, { v: 1, files: [at('Resume.pdf', A, NOW - 9)] }, NOW, own);
  assert.deepStrictEqual(names(mine.upload), ['Resume.pdf']);
  assert.strictEqual(mine.upload[0].at, NOW);
  // replaced on another computer
  const theirs = ff.plan([{ name: 'Resume.pdf', size: 10, sha: A, mtime: 1 }], known, { v: 1, files: [at('Resume.pdf', B, NOW - 1)] }, NOW, own);
  assert.deepStrictEqual([names(theirs.download), theirs.upload], [['Resume.pdf'], []]);
});

test('removed on one computer, it goes on the others; but never a file this computer has not synced yet', () => {
  const known = { 'Resume.pdf': { sha: A, at: NOW - 9 } }, row = { v: 1, files: [at('Resume.pdf', A, NOW - 9)] };
  // removed here: the row says so and the bucket copy goes
  const here = ff.plan([], known, row, NOW, own);
  assert.deepStrictEqual([here.gone, here.dropObjects, here.download], [{ 'Resume.pdf': NOW }, [row.files[0].path], []]);
  // removed there: this computer's copy goes
  const there = ff.plan([{ name: 'Resume.pdf', size: 10, sha: A, mtime: 1 }], known, { v: 1, files: [], gone: { 'Resume.pdf': NOW - 1 } }, NOW, own);
  assert.deepStrictEqual([there.removeLocal, there.upload], [['Resume.pdf'], []]);
  // a computer that never synced this file keeps it and puts it up, even though one of that name was removed once
  const fresh = ff.plan([{ name: 'Resume.pdf', size: 10, sha: B, mtime: NOW - 5 * DAY }], {}, { v: 1, files: [], gone: { 'Resume.pdf': NOW - 1 } }, NOW, own);
  assert.deepStrictEqual([fresh.removeLocal, names(fresh.upload), fresh.gone], [[], ['Resume.pdf'], {}]);
  assert.ok(fresh.upload[0].at > NOW - 1);
  // and one edited here after it was removed there is kept too
  const edited = ff.plan([{ name: 'Resume.pdf', size: 10, sha: B, mtime: 1 }], known, { v: 1, files: [], gone: { 'Resume.pdf': NOW - 1 } }, NOW, own);
  assert.deepStrictEqual([edited.removeLocal, names(edited.upload)], [[], ['Resume.pdf']]);
});

test('the row is checked before it is trusted: no odd names, no paths outside his folder', () => {
  const p = ff.plan([], {}, { v: 1, files: [
    { name: '../../evil.pdf', size: 10, sha: A, at: 5, path: 'x', up: 5 },
    { name: 'run.exe', size: 10, sha: A, at: 5, path: 'x', up: 5 },
    { name: 'Huge.pdf', size: 99 * 1024 * 1024, sha: A, at: 5, path: 'x', up: 5 },
    { name: 'Elsewhere.pdf', size: 10, sha: A, at: 5, path: 'tk_agent_att_' + '0'.repeat(40) + '/ff-' + 'a'.repeat(24) + '.bin', up: 5 },
    at('Good.pdf', B, 5),
  ], gone: { '../x.pdf': 9 } }, NOW, own);
  assert.deepStrictEqual(names(p.download), ['Good.pdf']);
  assert.deepStrictEqual(names(p.files), ['Elsewhere.pdf']); // listed, but this computer can't fetch it and won't try
  assert.deepStrictEqual(p.gone, {});
});

test('after the sync key changes, a computer that has the file puts it up again in the new folder', () => {
  const old = { name: 'Resume.pdf', size: 10, sha: A, at: 5, path: 'tk_agent_att_' + '0'.repeat(40) + '/ff-' + 'a'.repeat(24) + '.bin', up: NOW };
  const p = ff.plan([{ name: 'Resume.pdf', size: 10, sha: A, mtime: 1 }], { 'Resume.pdf': { sha: A, at: 5 } }, { v: 1, files: [old] }, NOW, own);
  assert.deepStrictEqual(names(p.upload), ['Resume.pdf']);
  assert.deepStrictEqual(p.dropObjects, []); // the old object is not his to remove with the new key
});

// two computers and a pretend bucket and row
function world() {
  const bucket = new Map();
  let row = null, n = 0;
  const supabase = {
    readRow: async (a, sfx) => { assert.strictEqual(sfx, ':forms'); return row ? { doc: JSON.parse(JSON.stringify(row.doc)), updated_at: row.updated_at } : undefined; },
    writeRow: async (a, sfx, doc, prev) => { if ((row ? row.updated_at : null) !== prev) return false; row = { doc: JSON.parse(JSON.stringify(doc)), updated_at: 't' + (++n) }; return true; },
  };
  const fetchFn = async (url, opts = {}) => {
    const p = String(url).split('/agent-files/')[1];
    if (opts.method === 'POST') { if (bucket.has(p)) return { ok: false, status: 409 }; bucket.set(p, Buffer.from(opts.body)); return { ok: true, status: 200 }; }
    if (opts.method === 'DELETE') { bucket.delete(p); return { ok: true, status: 200 }; }
    const b = bucket.get(p);
    return b ? { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) } : { ok: false, status: 404 };
  };
  const computer = (name) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-' + name + '-'));
    const dir = path.join(root, 'form-files'); fs.mkdirSync(dir);
    return { root, dir, sync: (now) => ff.sync({ a: { url: 'https://x.example', key: 'k', syncKey: KEY }, supabase, dir, state: path.join(root, 'form-files-sync.json'), fetch: fetchFn, now: () => now }) };
  };
  return { bucket, row: () => row, computer };
}

test('two computers end to end: add, arrive, replace, remove, and nothing readable in the bucket', async () => {
  const w = world(), pc = w.computer('pc'), lupa = w.computer('lupa');
  const resume = 'Resume of Alex Example, 12 Sample Street';
  fs.writeFileSync(path.join(pc.dir, 'Resume.pdf'), resume);
  assert.deepStrictEqual(await pc.sync(NOW), { ok: true, got: [], sent: ['Resume.pdf'], removed: [] });
  assert.strictEqual(w.bucket.size, 1);
  for (const b of w.bucket.values()) assert.ok(!b.includes(Buffer.from('Alex Example')), 'the bucket copy is sealed');
  // it arrives on the other computer, byte for byte
  assert.deepStrictEqual(await lupa.sync(NOW + 1000), { ok: true, got: ['Resume.pdf'], sent: [], removed: [] });
  assert.strictEqual(fs.readFileSync(path.join(lupa.dir, 'Resume.pdf'), 'utf8'), resume);
  // and then neither has anything to do
  const before = w.row().updated_at;
  assert.deepStrictEqual(await pc.sync(NOW + 2000), { ok: true, got: [], sent: [], removed: [] });
  assert.deepStrictEqual(await lupa.sync(NOW + 3000), { ok: true, got: [], sent: [], removed: [] });
  assert.strictEqual(w.row().updated_at, before);
  // a new version on the PC replaces Lupa's, and the old bucket copy goes
  fs.writeFileSync(path.join(pc.dir, 'Resume.pdf'), resume + ', updated');
  assert.deepStrictEqual((await pc.sync(NOW + DAY)).sent, ['Resume.pdf']);
  assert.strictEqual(w.bucket.size, 1);
  assert.deepStrictEqual((await lupa.sync(NOW + DAY + 1000)).got, ['Resume.pdf']);
  assert.strictEqual(fs.readFileSync(path.join(lupa.dir, 'Resume.pdf'), 'utf8'), resume + ', updated');
  // removed on Lupa: gone from the bucket and from the PC
  fs.unlinkSync(path.join(lupa.dir, 'Resume.pdf'));
  await lupa.sync(NOW + 2 * DAY);
  assert.strictEqual(w.bucket.size, 0);
  assert.deepStrictEqual((await pc.sync(NOW + 2 * DAY + 1000)).removed, ['Resume.pdf']);
  assert.strictEqual(fs.existsSync(path.join(pc.dir, 'Resume.pdf')), false);
  // added again later: it comes back everywhere
  fs.writeFileSync(path.join(pc.dir, 'Resume.pdf'), 'a new resume');
  assert.deepStrictEqual((await pc.sync(NOW + 3 * DAY)).sent, ['Resume.pdf']);
  assert.deepStrictEqual((await lupa.sync(NOW + 3 * DAY + 1000)).got, ['Resume.pdf']);
  for (const c of [pc, lupa]) fs.rmSync(c.root, { recursive: true, force: true });
});

test('a bucket copy that was swapped for something else is not written to the folder', async () => {
  const w = world(), pc = w.computer('pc'), lupa = w.computer('lupa');
  fs.writeFileSync(path.join(pc.dir, 'Resume.pdf'), 'the real one');
  await pc.sync(NOW);
  for (const k of w.bucket.keys()) w.bucket.set(k, ff.sealFile(KEY, Buffer.from('a different file'))); // sealed with his key, but not what the row lists
  assert.deepStrictEqual((await lupa.sync(NOW + 1000)).got, []);
  assert.deepStrictEqual(fs.readdirSync(lupa.dir), []);
  for (const k of w.bucket.keys()) w.bucket.set(k, Buffer.from('not sealed at all, just bytes someone put there'));
  assert.deepStrictEqual((await lupa.sync(NOW + 2000)).got, []);
  assert.deepStrictEqual(fs.readdirSync(lupa.dir), []);
  assert.deepStrictEqual(await ff.sync({ a: null }), { ok: false, error: 'sync isn’t set up on this computer' });
  for (const c of [pc, lupa]) fs.rmSync(c.root, { recursive: true, force: true });
});
