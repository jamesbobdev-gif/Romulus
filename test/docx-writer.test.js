const test = require('node:test');
const assert = require('node:assert');
const { makeDocx, crc32 } = require('../agent/docx-writer');

test('crc32 matches the standard check value', () => {
  assert.strictEqual(crc32(Buffer.from('123456789')), 0xCBF43926);
});

test('a written answer becomes a zip with the Word parts, text escaped', () => {
  const b = makeDocx('My essay', '# Intro\nCats & **dogs** <3\n- one');
  assert.strictEqual(b.readUInt32LE(0), 0x04034b50); // a zip
  const s = b.toString('utf8');
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml']) assert.ok(s.includes(part), part);
  assert.ok(s.includes('Cats &amp; '));
  assert.ok(s.includes('&lt;3'));
  assert.ok(s.includes('<w:b/></w:rPr><w:t xml:space="preserve">dogs'));
  assert.ok(s.includes('w:val="Heading1"'));
  assert.ok(s.includes('• one'));
});
