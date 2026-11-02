/* Downloading documents from the Agent tab.
   - doc:save: an AI's written answer (an essay, a letter) saved as a Word file where he picks.
   - sheet:save: the Finance tab's stocks saved as a spreadsheet (.csv) where he picks.
   - lupa:files / lupa:fetch / lupa:remove: files the local model's browser downloaded (a worksheet off Blackboard)
     sit in its own computer's ~/Downloads, not on this one. The worker puts them on sync (agent/worker-files.js);
     these list them from there, copy one here, and remove one (it goes to the trash over there too).
   - forms:files / forms:add / forms:remove: his files for forms (the resume a job site asks for), kept on this
     computer where the browser launcher runs (agent/agent-files.js); Settings → About you lists them. */
const fs = require('fs');
const path = require('path');
const { app, dialog, shell } = require('electron');
const { makeDocx } = require('../agent/docx-writer');
const agentFiles = require('../agent/agent-files');
const workerFiles = require('../agent/worker-files');
const supabase = require('../agent/supabase');

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

const channel = () => supabase.channel(ctx.readConfig());
// a file name safe to use as a Windows file name
const safeName = (s, fallback) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || fallback;

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

// a table (the Finance tab's stocks) as a .csv that Excel, Numbers and Google Sheets open
async function saveSheet(_e, title, csv) {
  if (!String(csv || '').trim()) return { ok: false, error: 'nothing to save' };
  const file = await pickPath(safeName(title, 'Spreadsheet') + '.csv', [{ name: 'Spreadsheet (CSV)', extensions: ['csv'] }]);
  if (!file) return { ok: false, canceled: true };
  // the BOM tells Excel it's UTF-8 (names with accents, the — for a missing value)
  try { fs.writeFileSync(file, '﻿' + String(csv)); }
  catch (e) { return { ok: false, error: e.message }; }
  shell.showItemInFolder(file);
  return { ok: true, path: file };
}

// what the local model put on sync: [{name, size, at}] newest first; the full entries are kept for fetch/remove
let known = [];
async function lupaFiles() {
  const a = channel();
  if (!a) return { ok: false, error: 'sync isn’t set up' };
  try { known = await workerFiles.list(a); return { ok: true, files: known.map((f) => ({ name: f.name, size: f.size, at: f.at })) }; }
  catch (e) { return { ok: false, error: e.message }; }
}
const entryFor = (name) => known.find((f) => f.name === name);

async function lupaFetch(_e, name) {
  name = String(name || '');
  if (!name || /[\/\u0000]/.test(name) || name === '.' || name === '..') return { ok: false, error: 'bad file name' };
  if (!entryFor(name)) await lupaFiles();
  const f = entryFor(name);
  if (!f) return { ok: false, error: 'it isn’t on sync any more' };
  // "Worksheet (3).docx" (the browser's copy number) saves as "Worksheet.docx"
  // (with no filters Windows' Save As box leaves the file name empty)
  const ext = (name.match(/\.([A-Za-z0-9]{1,8})$/) || [])[1];
  const file = await pickPath(safeName(name.replace(/ \(\d+\)(?=\.[^.]+$)/, ''), 'file'),
    (ext ? [{ name: ext.toUpperCase() + ' file', extensions: [ext] }] : []).concat([{ name: 'All files', extensions: ['*'] }]));
  if (!file) return { ok: false, canceled: true };
  try { await workerFiles.download(f, file); }
  catch (e) { try { fs.unlinkSync(file); } catch (e2) {} ctx.agentLog('downloads: copying ' + name + ' from sync failed: ' + e.message); return { ok: false, error: e.message }; }
  shell.showItemInFolder(file);
  return { ok: true, path: file };
}

// done with it: off sync, and to the local model’s trash (not deleted for good), every copy the browser made
async function lupaRemove(_e, names) {
  names = (Array.isArray(names) ? names : [names]).map(String).filter((n) => n && !/[\/\u0000]/.test(n) && n !== '.' && n !== '..');
  if (!names.length) return { ok: false, error: 'bad file name' };
  const a = channel();
  if (!a) return { ok: false, error: 'sync isn’t set up' };
  if (!names.every(entryFor)) await lupaFiles();
  const entries = names.map(entryFor).filter(Boolean);
  if (!entries.length) return { ok: true };
  try { await workerFiles.remove(a, entries); known = known.filter((f) => !entries.includes(f)); return { ok: true }; }
  catch (e) { ctx.agentLog('downloads: removing ' + names.join(', ') + ' failed: ' + e.message); return { ok: false, error: e.message }; }
}

const handlers = {
  'lupa:remove': lupaRemove,
  'doc:save': saveDoc,
  'sheet:save': saveSheet,
  'lupa:files': () => lupaFiles(),
  'lupa:fetch': lupaFetch,
  'forms:files': () => ({ ok: true, files: agentFiles.list(formDir()) }),
  'forms:add': () => formAdd(),
  'forms:remove': (_e, name) => agentFiles.remove(formDir(), name),
};

module.exports = { init, handlers };
