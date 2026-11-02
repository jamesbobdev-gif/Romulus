/* The text of a file the local model's browser downloaded (an assignment sheet, a rubric, the slides off
   Blackboard or D2L): course sites keep the real instructions in attachments the page itself doesn't show.
   Word, PowerPoint and OpenDocument files are zips of XML, read here; a PDF goes through pdftotext (poppler,
   on Ubuntu by default); plain text, CSV, Markdown and HTML are read as they are. Read only, from Downloads only.
   No Electron here, so it can be tested on its own. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { listDownloads } = require('./worker-files');

const MAX_CHARS = 12000;
const downloadsDir = () => path.join(os.homedir(), 'Downloads');

// a zip's files → {name: Buffer}, from its central directory (stored or deflated, as Office writes them)
function unzip(buf) {
  const out = {};
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip file');
  let at = buf.readUInt32LE(end + 16);
  const count = buf.readUInt16LE(end + 10);
  for (let i = 0; i < count && buf.readUInt32LE(at) === 0x02014b50; i++) {
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.slice(at + 46, at + 46 + nameLen).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.slice(start, start + size);
    if (method === 0) out[name] = data; else if (method === 8) out[name] = zlib.inflateRawSync(data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
const unxml = (x) => String(x).replace(/<\/w:p>|<\/a:p>|<\/text:p>|<\/text:h>|<w:br\/>|<w:tab\/>/g, (m) => /tab/.test(m) ? '\t' : '\n')
  .replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
// Word: the body, then its tables come with it; PowerPoint: each slide in order, numbered
function officeText(buf, ext) {
  const files = unzip(buf);
  if (ext === 'docx') return unxml((files['word/document.xml'] || '').toString('utf8'));
  if (ext === 'pptx') {
    const slides = Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    return slides.map((n, i) => '--- Slide ' + (i + 1) + ' ---\n' + unxml(files[n].toString('utf8').replace(/<\/a:p>/g, '</a:p>'))).join('\n\n');
  }
  if (ext === 'xlsx') return unxml((files['xl/sharedStrings.xml'] || '').toString('utf8').replace(/<\/si>/g, '</si>\n'));
  return unxml((files['content.xml'] || '').toString('utf8')); // odt, odp
}
const pdfText = (file) => new Promise((resolve, reject) => {
  execFile('pdftotext', ['-layout', '-q', file, '-'], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (e, out) => {
    if (e) reject(new Error(e.code === 'ENOENT' ? 'pdftotext isn’t installed on this computer (sudo apt install poppler-utils)' : 'couldn’t read the PDF')); else resolve(out);
  });
});

/* name: a file in Downloads (as listed), or '' for the newest. → the text the model reads, or why not.
   dir and list are for tests. */
async function readDownloaded(name, { dir = downloadsDir() } = {}) {
  const files = listDownloads(dir);
  if (!files.length) return 'Nothing in Downloads yet. Click the attachment on the course page to download it, then call read_file.';
  const want = String(name || '').trim().toLowerCase();
  const f = want ? files.find((x) => x.name.toLowerCase() === want) || files.find((x) => x.name.toLowerCase().includes(want)) : files[0];
  if (!f) return 'No file called "' + name + '". Downloads has: ' + files.slice(0, 12).map((x) => x.name).join(', ');
  const file = path.join(dir, f.name), ext = (f.name.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  let text;
  try {
    const e = ext.toLowerCase();
    if (e === 'pdf') text = await pdfText(file);
    else if (['docx', 'pptx', 'xlsx', 'odt', 'odp'].includes(e)) text = officeText(fs.readFileSync(file), e);
    else if (['txt', 'md', 'csv', 'rtf', 'json'].includes(e)) text = fs.readFileSync(file, 'utf8');
    else if (['html', 'htm'].includes(e)) text = require('./local-tools').htmlText(fs.readFileSync(file, 'utf8'));
    else return f.name + ' is a .' + (e || '?') + ' file: it can’t be read as text. Say so in the brief.';
  } catch (err) { return 'Couldn’t read ' + f.name + ': ' + err.message; }
  text = String(text || '').trim();
  if (!text) return f.name + ' has no text in it (a scanned page or a picture): say so in the brief instead of guessing what it says.';
  return 'File: ' + f.name + '\n' + (text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '\n…(the rest is cut off)' : text);
}

const READ_FILE_TOOL = { type: 'function', function: { name: 'read_file', description: 'Read a file the browser downloaded (an assignment sheet, a rubric, slides: PDF, Word, PowerPoint, text). Click the attachment on the page first to download it. name = the file name, or empty for the newest download.', parameters: { type: 'object', properties: { name: { type: 'string' } } } } };

module.exports = { readDownloaded, unzip, officeText, unxml, READ_FILE_TOOL };
