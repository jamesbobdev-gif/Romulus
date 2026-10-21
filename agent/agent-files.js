/* His files for forms: the resume (and a transcript, a cover letter…) the agents may upload when a
   site asks for one. They sit in <userData>/form-files on this computer, where the browser launcher
   runs, copied in from ⚙ Settings → About you → Files for forms (main/downloads.js), so the original
   can move. The launcher (agent/browser-proxy.js) refuses any upload that isn't one of these exact
   paths, whatever a page or a prompt says: nothing else on this computer can be sent.
   No Electron here, so it can be tested on its own. */
const fs = require('fs');
const path = require('path');

const KINDS = /\.(pdf|docx?|rtf|txt|odt|pages|png|jpe?g)$/i;
const MAX_BYTES = 10 * 1024 * 1024;
const dirFor = (userData) => path.join(userData, 'form-files');
// a file name safe on Windows, with nothing a path could hide in
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

// what's there: [{name, path, size}], by name
function list(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => KINDS.test(f)).sort(); } catch (e) { return []; }
  return names.map((name) => {
    const p = path.join(dir, name);
    let size = 0; try { size = fs.statSync(p).size; } catch (e) {}
    return { name, path: p, size };
  });
}
// copy one in → {ok, file} or {ok: false, error}
function add(dir, src) {
  const name = safeName(path.basename(String(src || '')));
  if (!name || !KINDS.test(name)) return { ok: false, error: 'PDF, Word, text or image files only' };
  let st; try { st = fs.statSync(src); } catch (e) { return { ok: false, error: 'could not read that file' }; }
  if (!st.isFile()) return { ok: false, error: 'not a file' };
  if (st.size > MAX_BYTES) return { ok: false, error: 'too big (10 MB at most)' };
  try { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(src, path.join(dir, name)); }
  catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, file: { name, path: path.join(dir, name), size: st.size } };
}
function remove(dir, name) {
  name = safeName(name);
  if (!name || !list(dir).some((f) => f.name === name)) return { ok: false, error: 'no such file' };
  try { fs.unlinkSync(path.join(dir, name)); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}
// the files as an agent reads them: name and the full path it hands to the upload tool
const brief = (files) => files.map((f) => '- ' + f.name + ' → ' + f.path).join('\n');

module.exports = { dirFor, list, add, remove, brief, safeName, KINDS, MAX_BYTES };
