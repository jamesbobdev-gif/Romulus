const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wf = require('../agent/worker-files');

const a = { url: 'https://x.supabase.co/', key: 'anon', syncKey: 'tk_agent_abc' };
const f = (name, size, at) => ({ name, size, at });

test('the bucket folder is a hash of the agent key, never the key', () => {
  const folder = wf.folderFor(a.syncKey);
  assert.match(folder, /^tk_agent_att_[0-9a-f]{40}$/);
  assert.ok(!folder.includes('abc'));
  assert.equal(wf.objectPath(a.syncKey, f('Worksheet (3).DOCX', 10, 5)).replace(folder + '/', '').slice(0, 3), 'dl-');
  assert.ok(wf.objectPath(a.syncKey, f('Worksheet.docx', 10, 5)).endsWith('.docx'));
  assert.equal(wf.publicUrl(a, 'p/q.pdf'), 'https://x.supabase.co/storage/v1/object/public/agent-files/p/q.pdf');
});

test('content types go by the extension; anything else is a plain download', () => {
  assert.equal(wf.mimeFor('a.PDF'), 'application/pdf');
  assert.equal(wf.mimeFor('a.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(wf.mimeFor('noext'), 'application/octet-stream');
  assert.equal(wf.mimeFor('a.exe'), 'application/octet-stream');
});

test('plan: new files go up, published ones stay, gone ones go to the trash, missing ones come down', () => {
  const published = [{ name: 'old.pdf', size: 1, at: 1, path: 'p/old.pdf', url: 'u' }, { name: 'deleted-here.pdf', size: 2, at: 2, path: 'p/d.pdf', url: 'u' }];
  const local = [f('old.pdf', 1, 1), f('new.docx', 3, 3), f('removed.pdf', 4, 4)];
  const gone = [wf.fileKey(f('removed.pdf', 4, 4))];
  const p = wf.plan(local, published, gone, '/dl');
  assert.deepEqual(p.keep.map((x) => x.name), ['old.pdf']);
  assert.equal(p.keep[0].path, 'p/old.pdf');
  assert.deepEqual(p.upload.map((x) => x.name), ['new.docx']);
  assert.deepEqual(p.drop.map((x) => x.name), ['deleted-here.pdf']);
  assert.deepEqual(p.trash, [path.join('/dl', 'removed.pdf')]);
});

test('plan: the same name downloaded again (new size or time) is a new file, not a gone one', () => {
  const gone = [wf.fileKey(f('Worksheet.docx', 10, 100))];
  const p = wf.plan([f('Worksheet.docx', 12, 200)], [], gone, '/dl');
  assert.equal(p.upload.length, 1);
  assert.equal(p.trash.length, 0);
});

test('the gone list keeps the newest 200 keys, once each', () => {
  const many = Array.from({ length: 250 }, (_, i) => 'k' + i);
  const out = wf.addGone(many, ['k249', 'new']);
  assert.equal(out.length, 200);
  assert.equal(out[out.length - 1], 'new');
  assert.equal(out.filter((k) => k === 'k249').length, 1);
  assert.ok(!out.includes('k0'));
});

test('an unchanged list is not written again', () => {
  const l = [{ name: 'a', size: 1, at: 1, path: 'p/a' }];
  assert.ok(wf.sameList(l, [{ name: 'a', size: 1, at: 1, path: 'p/a', url: 'x' }]));
  assert.ok(!wf.sameList(l, [{ name: 'a', size: 1, at: 2, path: 'p/a' }]));
  assert.ok(!wf.sameList(l, []));
});

test('listDownloads: files only, newest first, no half-downloads or installers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  fs.writeFileSync(path.join(dir, 'a.pdf'), 'aaa');
  fs.writeFileSync(path.join(dir, 'b.crdownload'), 'bb');
  fs.writeFileSync(path.join(dir, 'c.AppImage'), 'c');
  fs.mkdirSync(path.join(dir, 'sub'));
  const old = Date.now() / 1000 - 1000;
  fs.utimesSync(path.join(dir, 'a.pdf'), old, old);
  fs.writeFileSync(path.join(dir, 'd.docx'), 'dddd');
  const got = wf.listDownloads(dir);
  assert.deepEqual(got.map((x) => x.name), ['d.docx', 'a.pdf']);
  assert.equal(got[1].size, 3);
  assert.deepEqual(wf.listDownloads(path.join(dir, 'nope')), []);
});

// a stand-in Supabase: the two rows and the bucket, reached through the same fetch the module uses
function fakeServer() {
  const rows = {}, bucket = {};
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push((opts.method || 'GET') + ' ' + url);
    const u = String(url);
    if (u.includes('/rpc/sync_get')) { const { p_sync_key } = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => rows[p_sync_key] ? [rows[p_sync_key]] : [] }; }
    if (u.includes('/rpc/sync_put')) {
      const { p_sync_key, p_doc, p_prev } = JSON.parse(opts.body);
      const cur = rows[p_sync_key];
      if ((cur ? cur.updated_at : null) !== (p_prev || null)) return { ok: true, status: 200, json: async () => false };
      rows[p_sync_key] = { doc: p_doc, updated_at: 't' + calls.length };
      return { ok: true, status: 200, json: async () => true };
    }
    const m = u.match(/\/storage\/v1\/object\/(public\/)?agent-files\/(.+)$/);
    if (m) {
      const p = m[2];
      if (opts.method === 'POST') { bucket[p] = opts.body; return { ok: true, status: 200 }; }
      if (opts.method === 'DELETE') { delete bucket[p]; return { ok: true, status: 200 }; }
      return bucket[p] ? { ok: true, status: 200, arrayBuffer: async () => bucket[p] } : { ok: false, status: 404 };
    }
    throw new Error('unexpected ' + u);
  };
  return { rows, bucket, calls, fetch };
}

test('the worker publishes what it downloaded, and another computer gets it and removes it', async () => {
  const s = fakeServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-sync-'));
  fs.writeFileSync(path.join(dir, 'Worksheet.docx'), 'hello');
  const log = [];
  assert.equal(await wf.sync(a, { dir, fetch: s.fetch, trash: async () => true, log: (m) => log.push(m) }), true);
  const listed = await wf.list(a, { fetch: s.fetch });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'Worksheet.docx');
  assert.equal(listed[0].size, 5);
  assert.ok(Object.keys(s.bucket)[0].startsWith(wf.folderFor(a.syncKey) + '/dl-'));
  // the same list again: no second write
  const writes = () => s.calls.filter((c) => c.includes('sync_put')).length;
  const before = writes();
  await wf.sync(a, { dir, fetch: s.fetch, trash: async () => true, log: () => {} });
  assert.equal(writes(), before);
  // the laptop copies it
  const to = path.join(dir, 'copy.docx');
  await wf.download(listed[0], to, { fetch: s.fetch });
  assert.equal(fs.readFileSync(to, 'utf8'), 'hello');
  fs.unlinkSync(to);
  // and removes it: out of the bucket and the list, named gone
  await wf.remove(a, listed, { fetch: s.fetch });
  assert.deepEqual(Object.keys(s.bucket), []);
  assert.deepEqual(await wf.list(a, { fetch: s.fetch }), []);
  // the worker's next pass trashes its copy and leaves the list empty
  const trashed = [];
  await wf.sync(a, { dir, fetch: s.fetch, trash: async (p) => { trashed.push(...p); return true; }, log: () => {} });
  assert.deepEqual(trashed, [path.join(dir, 'Worksheet.docx')]);
  assert.deepEqual(await wf.list(a, { fetch: s.fetch }), []);
  assert.ok(log.some((m) => /Worksheet\.docx is on sync/.test(m)));
});

test('a file deleted on the worker comes out of the bucket on the next pass', async () => {
  const s = fakeServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-drop-'));
  fs.writeFileSync(path.join(dir, 'a.pdf'), 'x');
  await wf.sync(a, { dir, fetch: s.fetch, trash: async () => true, log: () => {} });
  assert.equal(Object.keys(s.bucket).length, 1);
  fs.unlinkSync(path.join(dir, 'a.pdf'));
  await wf.sync(a, { dir, fetch: s.fetch, trash: async () => true, log: () => {} });
  assert.equal(Object.keys(s.bucket).length, 0);
  assert.deepEqual(await wf.list(a, { fetch: s.fetch }), []);
});

test('a copy of the wrong size is not kept', async () => {
  const s = fakeServer();
  s.bucket['p/x.pdf'] = Buffer.from('abc');
  const to = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-dl-')), 'x.pdf');
  await assert.rejects(wf.download({ url: 'https://x.supabase.co/storage/v1/object/public/agent-files/p/x.pdf', size: 99 }, to, { fetch: s.fetch }), /wrong size/);
  assert.ok(!fs.existsSync(to));
});
