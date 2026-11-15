/* Add a task from Claude Desktop (or any app that speaks MCP): a small MCP server (JSON-RPC over stdin/stdout)
   with one tool, add_task. It writes the task as a file into the app's own drop folder (ROMULUS_INBOX, which is
   <user data>/outside-adds); the running app picks it up within seconds (main/outside-adds.js) and puts it on
   the list like anything typed in, synced and all. With the app closed, the file waits for the next start.
   Nothing is read back: the other app can add to the lists, not see them. Settings → Agent & AI → Add from
   Claude Desktop writes the entry in Claude Desktop's config that runs this file with the app's own Electron
   as node (ELECTRON_RUN_AS_NODE). Plain node, no packages: the app copies it out of itself.
   Usage: ROMULUS_INBOX=<folder> node tasks-mcp.js */
const fs = require('fs');
const path = require('path');

const LISTS = { todo: 'To do', agent: 'Agent', work: 'Work', school: 'School' };
const TOOLS = [{
  name: 'add_task',
  description: 'Add a task to the user\'s Romulus lists. list "todo" is their own to-do list (the default); "agent" hands the ' +
    'task to the Romulus Agent, which goes and does it (research, shopping, forms, email) and asks the user before anything ' +
    'final; "work" and "school" are their other lists. Returns what was added; the app shows it within seconds.',
  inputSchema: { type: 'object', properties: {
    title: { type: 'string', description: 'The task, as the user would write it ("Call the dentist", "Find the cheapest flight to Denver on the 14th")' },
    list: { type: 'string', enum: ['todo', 'agent', 'work', 'school'], description: 'Which list; todo when not said' },
    due: { type: 'string', description: 'Due date, YYYY-MM-DD, if any' },
    time: { type: 'string', description: 'Due time, HH:MM (24-hour), only with a date' },
    notes: { type: 'string', description: 'Details to keep with the task (kept on Agent and School tasks)' },
  }, required: ['title'] },
}];

// the request → the file's contents, or an error the other app can read out
function clean(a) {
  a = a && typeof a === 'object' ? a : {};
  const title = String(a.title == null ? '' : a.title).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!title) throw new Error('title is required');
  const list = LISTS[a.list] ? a.list : 'todo';
  const due = /^\d{4}-\d{2}-\d{2}$/.test(String(a.due || '')) ? String(a.due) : null;
  if (a.due && !due) throw new Error('due must be a date like 2026-11-20');
  const time = due && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(a.time || '')) ? String(a.time) : null;
  const notes = String(a.notes == null ? '' : a.notes).replace(/\r\n/g, '\n').trim().slice(0, 2000) || null;
  return { title, list, due, time, notes, from: 'Claude Desktop', at: Date.now() };
}
function inboxDir() {
  const d = process.env.ROMULUS_INBOX;
  if (!d) throw new Error('ROMULUS_INBOX is not set: set this up again from Romulus’s Settings');
  return d;
}
// one file per task, never half-written (the app reads only .json files)
function drop(item, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const name = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json';
  const file = path.join(dir, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(item));
  fs.renameSync(file + '.tmp', file);
  return name;
}
async function call(name, args) {
  if (name !== 'add_task') throw new Error('unknown tool ' + name);
  const item = clean(args);
  drop(item, inboxDir());
  return { added: item.title, list: LISTS[item.list], due: item.due || undefined, time: item.time || undefined,
    note: item.list === 'agent' ? 'The Romulus Agent starts on it when the app is open. It asks the user before buying, sending, submitting or booking anything.'
      : 'Romulus shows it within seconds, or when it next opens.' };
}

const send = (m) => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0' }, m)) + '\n');
async function handle(m) {
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18',
    capabilities: { tools: {} }, serverInfo: { name: 'romulus', version: '1' } } });
  if (m.method === 'tools/list') return send({ id: m.id, result: { tools: TOOLS } });
  if (m.method === 'tools/call') {
    const p = m.params || {};
    try { send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(await call(p.name, p.arguments), null, 1) }] } }); }
    catch (e) { send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: String((e && e.message) || e) }] } }); }
    return;
  }
  if (m.method === 'ping') return send({ id: m.id, result: {} });
  if (m.id != null) send({ id: m.id, error: { code: -32601, message: 'method not found' } });
}

if (require.main === module) {
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      handle(m);
    }
  });
  process.stdin.on('end', () => process.exit(0)); // Claude Desktop closed: nothing is left to wait for
}

module.exports = { TOOLS, LISTS, clean, drop, call, handle };
