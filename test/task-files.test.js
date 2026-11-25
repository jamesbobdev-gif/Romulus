// Photos and files on any task (renderer/js/task-files.js): encrypted on the device, in the account's folder.
const test = require('node:test');
const assert = require('node:assert');
const nodeCrypto = require('node:crypto');
// sync-crypto.js's base64 helpers, which task-files.js uses as page globals
global.syncB64 = (bytes) => Buffer.from(bytes).toString('base64');
global.syncUnB64 = (s) => new Uint8Array(Buffer.from(String(s), 'base64'));
global.syncB64Url = (bytes) => global.syncB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const f = require('../renderer/js/task-files');

test('a file is encrypted with a key of its own, and only that key opens it', async () => {
  const plain = new TextEncoder().encode('receipt: 2 x part 4417-B');
  const a = await f.taskFileSeal(plain), b = await f.taskFileSeal(plain);
  assert.notDeepStrictEqual(Buffer.from(a.ct), Buffer.from(plain)); // what goes up is not the file
  assert.notStrictEqual(a.k, b.k); // a fresh key per file
  assert.notDeepStrictEqual(Buffer.from(a.ct), Buffer.from(b.ct));
  assert.match(a.k, /^[A-Za-z0-9_-]{43}$/); // 32 bytes, url-safe: it lives in the (sealed) task
  assert.deepStrictEqual(Buffer.from(await f.taskFileOpenBytes(a.ct, a.k, a.iv)), Buffer.from(plain));
  await assert.rejects(f.taskFileOpenBytes(a.ct, b.k, a.iv)); // another file's key can't open it
  const bent = Uint8Array.from(a.ct); bent[0] ^= 1;
  await assert.rejects(f.taskFileOpenBytes(bent, a.k, a.iv)); // a changed file is refused, not shown wrong
});

test('files go in the folder of the account the database counts space by', async () => {
  // sync_account_of in supabase/setup.sql: sha256 of the key's id part, without the list prefix or a side-row suffix
  const id = '26dbc739-a57d-4d40-900d-984640e0415d';
  const want = 'acct_' + nodeCrypto.createHash('sha256').update(id).digest('hex');
  for (const k of ['tk_' + id, 'tk_work_' + id, 'tk_agent_' + id, 'tk_' + id + ':ideas']) assert.strictEqual(await f.taskFilesFolder(k), want, k);
  assert.match(want, /^acct_[0-9a-f]{64}$/); // the shape the upload rule accepts (20261109_task_files.sql)
});

test('a refused upload says why in words', () => {
  assert.match(f.taskFileError(400, '{"statusCode":"403","error":"Unauthorized","message":"new row violates row-level security policy"}'), /space is full/);
  assert.match(f.taskFileError(403, ''), /space is full/);
  assert.match(f.taskFileError(400, '{"error":"Bucket not found"}'), /run the latest setup\.sql/);
  assert.match(f.taskFileError(413, ''), /over 10 MB/);
  assert.match(f.taskFileError(500, 'boom'), /upload failed \(500\)/);
  assert.strictEqual(f.taskFileSize(1536), '2 KB');
  assert.strictEqual(f.taskFileSize(3 * 1048576), '3 MB');
});
