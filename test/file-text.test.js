const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const fileText = require('../agent/file-text');
const { makeDocx, zip } = require('../agent/docx-writer');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'file-text-'));

test('a Word file the browser downloaded is read as text', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'Video Assignment.docx'), makeDocx('Video Assignment', '# Video Assignment\n\nRecord a 3-5 minute video.\n\n- Face on camera'));
  const out = await fileText.readDownloaded('video assignment', { dir });
  assert.match(out, /^File: Video Assignment\.docx/);
  assert.match(out, /Record a 3-5 minute video/);
  assert.match(out, /Face on camera/);
});

test('PowerPoint slides come in order, deflated zips too', async () => {
  const slide = (t) => Buffer.from('<p:sld><a:p><a:r><a:t>' + t + '</a:t></a:r></a:p></p:sld>');
  const stored = zip([{ name: 'ppt/slides/slide2.xml', data: slide('Second') }, { name: 'ppt/slides/slide10.xml', data: slide('Tenth') }, { name: 'ppt/slides/slide1.xml', data: slide('First') }]);
  const text = fileText.officeText(stored, 'pptx');
  assert.ok(text.indexOf('First') < text.indexOf('Second') && text.indexOf('Second') < text.indexOf('Tenth'), text);
  // the same zip with its one file deflated, as Office writes them
  const data = Buffer.from('<w:document><w:p><w:r><w:t>Rubric: clarity &amp; eye contact</w:t></w:r></w:p></w:document>');
  const z = zip([{ name: 'word/document.xml', data }]);
  const deflated = zlib.deflateRawSync(data);
  const local = Buffer.from(z.slice(0, 30)); local.writeUInt16LE(8, 8); local.writeUInt32LE(deflated.length, 18);
  const nameLen = z.readUInt16LE(26), name = z.slice(30, 30 + nameLen);
  const cdStart = 30 + nameLen + data.length, cd = Buffer.from(z.slice(cdStart, z.length - 22));
  cd.writeUInt16LE(8, 10); cd.writeUInt32LE(deflated.length, 20);
  const end = Buffer.from(z.slice(z.length - 22)); end.writeUInt32LE(30 + nameLen + deflated.length, 16);
  assert.strictEqual(fileText.officeText(Buffer.concat([local, name, deflated, cd, end]), 'docx'), 'Rubric: clarity & eye contact');
});

test('it says plainly what it can’t read', async () => {
  const dir = tmp();
  assert.match(await fileText.readDownloaded('', { dir }), /Nothing in Downloads yet/);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'Be under 5 minutes.');
  fs.writeFileSync(path.join(dir, 'clip.mp4'), 'x');
  assert.match(await fileText.readDownloaded('notes', { dir }), /Be under 5 minutes/);
  assert.match(await fileText.readDownloaded('clip.mp4', { dir }), /can’t be read as text/);
  assert.match(await fileText.readDownloaded('rubric', { dir }), /No file called "rubric"\. Downloads has: /);
  fs.writeFileSync(path.join(dir, 'blank.txt'), '   ');
  assert.match(await fileText.readDownloaded('blank.txt', { dir }), /has no text in it/);
});
