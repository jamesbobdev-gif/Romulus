/* Downloading documents from the Agent tab.
   - doc:save: an AI's written answer (an essay, a letter) saved as a Word file where he picks.
   - lupa:files / lupa:fetch / lupa:remove: files the mini PC's browser downloaded (a worksheet off Blackboard) sit in
     Lupa's ~/Downloads, not on this computer. These list them and copy one here, over the same SSH the
     mini PC's browser uses (localModel.browser.ssh).
   - forms:files / forms:add / forms:remove: his files for forms (the resume a job site asks for), kept on this
     computer where the browser launcher runs (agent/agent-files.js); Settings → About you lists them. */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, dialog, shell } = require('electron');
const { makeDocx } = require('../agent/docx-writer');
const agentFiles = require('../agent/agent-files');

let ctx = null;
function init(c) { ctx = c; }

const formDir = () => agentFiles.dirFor(ctx.userData());
async function formAdd() {
  const r = await dialog.showOpenDialog({ title: 'Add a file for forms', properties: ['openFile'],
    filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'doc', 'rtf', 'txt', 'odt', 'png', 'jpg', 'jpeg'] }] });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
  const out = agentFiles.add(formDir(), r.filePaths[0]);
  if (out.ok) ctx.agentLog('files for forms: added ' + out.file.name);
  return out;
}

const sshHost = () => ((ctx.readConfig().localModel || {}).browser || {}).ssh || '';
// a file name safe to use as a Windows file name
const safeName = (s, fallback) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || fallback;
// "…" in single quotes for the mini PC's shell
const shQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

async function pickPath(name, filters) {
  const r = await dialog.showSaveDialog({ defaultPath: path.join(app.getPath('downloads'), name), filters });
  return r.canceled || !r.filePath ? null : r.filePath;
}

async function saveDoc(_e, title, text) {
  if (!String(text || '').trim()) return { ok: false, error: 'nothing to save' };
  const file = await pickPath(safeName(title, 'Document') + '.docx', [{ name: 'Word document', extensions: ['docx'] }]);
  if (!file) return { ok: false, canceled: true };
  try { fs.writeFileSync(file, makeDocx(String(title || '').slice(0, 200), String(text))); }
  catch (e) { return { ok: false, error: e.message }; }
  shell.showItemInFolder(file);
  return { ok: true, path: file };
}

// one ssh command on the mini PC → stdout (a Buffer), or an error
function onLupa(cmd, toFile) {
  const host = sshHost();
  if (!host) return Promise.reject(new Error('the mini PC’s SSH isn’t set up'));
  return new Promise((resolve, reject) => {
    const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, cmd], { windowsHide: true });
    const out = [], err = [];
    const sink = toFile ? fs.createWriteStream(toFile) : null;
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} }, 120 * 1000);
    p.stdout.on('data', (d) => { if (sink) sink.write(d); else out.push(d); });
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => { clearTimeout(killer); if (sink) sink.destroy(); reject(e); });
    p.on('close', (code) => {
      clearTimeout(killer);
      const done = () => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(Buffer.concat(err).toString().trim().slice(0, 200) || 'ssh exited ' + code));
      if (sink) sink.end(done); else done();
    });
  });
}

// what's in Lupa's Downloads: [{name, size, at}] newest first (half-downloaded and installer files left out)
async function lupaFiles() {
  try {
    const out = (await onLupa("find ~/Downloads -maxdepth 1 -type f -printf '%T@\\t%s\\t%f\\n'")).toString();
    const files = out.split('\n').map((l) => l.split('\t')).filter((p) => p.length === 3 && p[2])
      .map((p) => ({ name: p[2], size: Number(p[1]) || 0, at: Math.round(Number(p[0]) * 1000) || 0 }))
      .filter((f) => !/\.(crdownload|part|tmp|deb|rpm|AppImage)$/i.test(f.name))
      .sort((a, b) => b.at - a.at).slice(0, 100);
    return { ok: true, files };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function lupaFetch(_e, name) {
  name = String(name || '');
  if (!name || /[\/\u0000]/.test(name) || name === '.' || name === '..') return { ok: false, error: 'bad file name' };
  // "Worksheet (3).docx" (the browser's copy number) saves as "Worksheet.docx"
  // (with no filters Windows' Save As box leaves the file name empty)
  const ext = (name.match(/\.([A-Za-z0-9]{1,8})$/) || [])[1];
  const file = await pickPath(safeName(name.replace(/ \(\d+\)(?=\.[^.]+$)/, ''), 'file'),
    (ext ? [{ name: ext.toUpperCase() + ' file', extensions: [ext] }] : []).concat([{ name: 'All files', extensions: ['*'] }]));
  if (!file) return { ok: false, canceled: true };
  try { await onLupa('cat -- ~/Downloads/' + shQuote(name), file); }
  catch (e) { try { fs.unlinkSync(file); } catch (e2) {} ctx.agentLog('downloads: copying ' + name + ' from the mini PC failed: ' + e.message); return { ok: false, error: e.message }; }
  shell.showItemInFolder(file);
  return { ok: true, path: file };
}

// done with it: to Lupa's trash (not deleted for good), every copy the browser made
async function lupaRemove(_e, names) {
  names = (Array.isArray(names) ? names : [names]).map(String).filter((n) => n && !/[\/\u0000]/.test(n) && n !== '.' && n !== '..');
  if (!names.length) return { ok: false, error: 'bad file name' };
  try { await onLupa('cd ~/Downloads && gio trash -- ' + names.map(shQuote).join(' ')); return { ok: true }; }
  catch (e) { ctx.agentLog('downloads: removing ' + names.join(', ') + ' on the mini PC failed: ' + e.message); return { ok: false, error: e.message }; }
}

const handlers = {
  'lupa:remove': lupaRemove,
  'doc:save': saveDoc,
  'lupa:files': () => lupaFiles(),
  'lupa:fetch': lupaFetch,
  'forms:files': () => ({ ok: true, files: agentFiles.list(formDir()) }),
  'forms:add': () => formAdd(),
  'forms:remove': (_e, name) => agentFiles.remove(formDir(), name),
};

module.exports = { init, handlers };
