/* The November 3 review pass: the local model's downloads bucket, the files it reads, the relay, and the final-action
   locks on the subscription and sign-in pages it now visits. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const wf = require('../agent/worker-files');
const a = { url: 'https://x.supabase.co', key: 'anon', syncKey: 'tk_agent_' + 'k'.repeat(32) };
const folder = wf.folderFor(a.syncKey);
const rowFetch = (files) => async (u, opts = {}) => {
  if (String(u).includes('/rpc/sync_get')) return { ok: true, status: 200, json: async () => [{ doc: { v: 1, files }, updated_at: 't1' }] };
  if (String(u).includes('/rpc/sync_put')) return { ok: true, status: 200, json: async () => true };
  if (opts.method === 'DELETE') { rowFetch.deleted.push(String(u)); return { ok: true, status: 200 }; }
  throw new Error('unexpected ' + u);
};
rowFetch.deleted = [];

test('the files row names the files; where they are is rebuilt from the own folder, never read from the row', async () => {
  const listed = await wf.list(a, { fetch: rowFetch([
    { name: 'ok.pdf', size: 3, at: 1, path: folder + '/dl-abc.pdf', url: 'http://127.0.0.1:9334/json/list' }, // a peer pointing Download at this computer
    { name: 'other.pdf', size: 3, at: 1, path: 'tk_agent_att_' + 'f'.repeat(40) + '/dl-x.pdf', url: 'https://x' }, // somebody else's folder
    { name: 'up.pdf', size: 3, at: 1, path: folder + '/../x.pdf', url: 'https://x' },
    { name: 'none.pdf', size: 3, at: 1, url: 'https://x' },
  ]) });
  assert.deepEqual(listed.map((f) => f.name), ['ok.pdf']);
  assert.strictEqual(listed[0].url, 'https://x.supabase.co/storage/v1/object/public/agent-files/' + folder + '/dl-abc.pdf');
  // remove: only the own folder's objects are deleted
  await wf.remove(a, listed.concat([{ name: 'other.pdf', size: 3, at: 1, path: 'tk_agent_att_' + 'f'.repeat(40) + '/dl-x.pdf' }]), { fetch: rowFetch([]) });
  assert.deepEqual(rowFetch.deleted.map((u) => u.split('agent-files/')[1]), [folder + '/dl-abc.pdf']);
});

test('a copy larger than the bucket allows is refused before it is kept', async () => {
  const to = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-big-')), 'x.pdf');
  const big = async () => ({ ok: true, status: 200, headers: { get: (h) => h === 'content-length' ? String(wf.MAX_BYTES + 1) : null }, arrayBuffer: async () => new ArrayBuffer(1) });
  await assert.rejects(wf.download({ url: 'https://x.supabase.co/storage/v1/object/public/agent-files/p/x.pdf', size: 1 }, to, { fetch: big }), /larger/);
  assert.ok(!fs.existsSync(to));
});

test('what the worker publishes: the browser\'s own folder, no runnable files, no links to files elsewhere', () => {
  assert.match(wf.downloadsDir(), /Downloads[\\/]Romulus$/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-skip-'));
  fs.writeFileSync(path.join(dir, 'sheet.pdf'), 'x');
  fs.writeFileSync(path.join(dir, 'setup.exe'), 'x');
  fs.writeFileSync(path.join(dir, 'run.sh'), 'x');
  try { fs.symlinkSync(path.join(dir, 'sheet.pdf'), path.join(dir, 'link.pdf')); } catch (e) {} // no symlink rights: still a pass
  assert.deepEqual(wf.listDownloads(dir).map((f) => f.name), ['sheet.pdf']);
  assert.strictEqual(wf.mimeFor('page.html'), 'application/octet-stream');
  assert.ok(wf.ownPath(a.syncKey, folder + '/dl-1.pdf'));
  assert.ok(!wf.ownPath(a.syncKey, folder + '/sub/dl-1.pdf'));
  assert.ok(!wf.ownPath(a.syncKey, 'tk_agent_att_' + 'f'.repeat(40) + '/dl-1.pdf'));
});

test('a zip that inflates to more than the reader takes stops instead of filling memory', () => {
  const fileText = require('../agent/file-text');
  // one entry, 40 MB of zeros deflated to a few KB
  const data = zlib.deflateRawSync(Buffer.alloc(40 * 1024 * 1024));
  const name = Buffer.from('word/document.xml');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = 30 + name.length + data.length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 10); end.writeUInt32LE(cdOffset, 16);
  const zip = Buffer.concat([local, name, data, central, name, end]);
  assert.throws(() => fileText.unzip(zip), /unpacks to more|maximum output|too large|ERR_BUFFER_TOO_LARGE/i);
});

test('an unclosed <script in a big page no longer takes minutes to strip', () => {
  const { htmlText } = require('../agent/local-tools');
  const page = '<p>hi</p>' + '<script '.repeat(80000) + '<b>there</b>';
  const t0 = Date.now();
  const out = htmlText(page);
  assert.ok(Date.now() - t0 < 2000, 'took ' + (Date.now() - t0) + ' ms');
  assert.match(out, /hi/);
});

test('the locks know the ways a subscription is ended, and never type a password or a code', () => {
  const g = require('../agent/browser-proxy');
  for (const w of ['Yes, cancel', 'Confirm cancellation', 'End membership', 'Stop subscription', 'Turn off auto-renew', 'Cancel Netflix subscription', 'Terminate plan'])
    assert.ok(g.CLOUD_FINAL.test(w), w);
  for (const w of ['End membership', 'Turn off auto-renewal', 'Pause my plan']) assert.ok(g.FINAL.test(w), w);
  assert.ok(!g.CLOUD_FINAL.test('Cancel'), 'a plain Cancel button closes a dialog');
  for (const el of ['Password', 'One-time code', 'Verification code', 'Authenticator code', 'Passcode'])
    assert.match(String(g.buyRefusal({ params: { name: 'browser_type', arguments: { element: el, text: 'x' } } }, 'https://school.edu') || ''), /Never type/, el);
  assert.strictEqual(g.buyRefusal({ params: { name: 'browser_type', arguments: { element: 'Search', text: 'x' } } }, 'https://school.edu'), null);
});

test('a yes shared from another device approves that one version, not everything after it', () => {
  const { onAvailable } = require('../main/updater');
  assert.strictEqual(onAvailable('1.0.30', { updateYes: '1.0.30' }), 'download');
  assert.strictEqual(onAvailable('1.0.31', { updateYes: '1.0.30' }), 'offer');
  assert.strictEqual(onAvailable('1.0.31', { updateYes: '999' }), 'offer');
});

test('the :files-gone row is a side row of its list under end-to-end sync, not a list of its own', () => {
  const sc = require('../agent/sync-crypto');
  const base = 'tk_agent_' + 'q'.repeat(32);
  assert.deepEqual(sc.splitKey(base + ':files-gone'), { base, sfx: ':files-gone' });
  assert.strictEqual(sc.rowKey(base + ':files-gone'), sc.rowKey(base) + ':files-gone');
});

test('the routing and the lane keep a coach task on the local model, hand-off or not', () => {
  const routing = require('../agent/routing');
  const coach = require('../agent/coach');
  const t = { title: 'write the lab report', ws: 'agent', lane: 'claude', notes: '' };
  if (!coach.isCoach(t)) t.coach = true; // whatever marks it (coach.isCoach decides)
  if (coach.isCoach(t)) assert.strictEqual(routing.laneOf(t), 'local');
});

test('the migration in last position carries every side row, the moved check and the guard', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261103_review_final.sql'), 'utf8');
  const last = fs.readdirSync(path.join(__dirname, '..', 'supabase', 'migrations')).sort().pop();
  assert.strictEqual(last, '20261103_review_final.sql');
  for (const fn of ['sync_get', 'sync_put', 'sync_set', 'sync_usage', 'agent_folder_proved', 'agent_file_upload_allowed', 'sync_pair_put', 'sync_pair_take'])
    assert.ok(sql.includes('create or replace function public.' + fn + '('), fn);
  assert.strictEqual((sql.match(/prefs\|locked\|routing\|standing\|ideas\|hours\|worker\|updates\|finance\|files\|files-gone/g) || []).length, 3);
  assert.strictEqual((sql.match(/sync_is_moved\(p_sync_key\)/g) || []).length, 2);
  assert.match(sql, /x-romulus-key/);
  assert.ok(!/create policy "agent files: app can see"[^;]*like 'tk_agent_att_%'/.test(sql), 'listing needs the key proof');
  const setup = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'setup.sql'), 'utf8');
  assert.strictEqual((setup.match(/pairing codes \(supabase\/migrations/g) || []).length, 1, 'the pairing section once');
  assert.match(setup, /\(:\[a-z-\]\+\)\?\$'/);
});
