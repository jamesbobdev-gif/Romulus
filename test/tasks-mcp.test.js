/* The MCP server Claude Desktop adds tasks through (agent/tasks-mcp.js), and the desktop side that takes the files
   in and puts the server into Claude Desktop's config (main/outside-adds.js). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mcp = require('../agent/tasks-mcp');
const outside = require('../main/outside-adds');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'romulus-mcp-'));

test('add_task: the title is required, the list defaults to his to-dos, dates and times are checked', () => {
  const a = mcp.clean({ title: '  Call the  dentist ', list: 'nope', due: '2026-11-20', time: '14:30', notes: ' bring the card ' });
  assert.strictEqual(a.title, 'Call the dentist');
  assert.strictEqual(a.list, 'todo');
  assert.strictEqual(a.due, '2026-11-20');
  assert.strictEqual(a.time, '14:30');
  assert.strictEqual(a.notes, 'bring the card');
  assert.strictEqual(a.from, 'Claude Desktop');
  assert.strictEqual(mcp.clean({ title: 'x', time: '09:00' }).time, null, 'a time needs a date');
  assert.strictEqual(mcp.clean({ title: 'x', list: 'agent' }).list, 'agent');
  assert.throws(() => mcp.clean({ title: '   ' }), /title is required/);
  assert.throws(() => mcp.clean({ title: 'x', due: 'tomorrow' }), /2026-11-20/);
});

test('a call drops one file in the inbox folder, never half-written, and says what it did', async () => {
  const inbox = path.join(tmp, 'inbox');
  process.env.ROMULUS_INBOX = inbox;
  const r = await mcp.call('add_task', { title: 'Find the cheapest flight to Denver', list: 'agent' });
  assert.strictEqual(r.added, 'Find the cheapest flight to Denver');
  assert.strictEqual(r.list, 'Agent');
  assert.match(r.note, /asks the user before buying/);
  const files = fs.readdirSync(inbox);
  assert.strictEqual(files.length, 1);
  assert.match(files[0], /^\d+-[a-z0-9]+\.json$/);
  const saved = JSON.parse(fs.readFileSync(path.join(inbox, files[0]), 'utf8'));
  assert.strictEqual(saved.list, 'agent');
  await assert.rejects(mcp.call('read_tasks', {}), /unknown tool/);
  delete process.env.ROMULUS_INBOX;
  await assert.rejects(mcp.call('add_task', { title: 'x' }), /ROMULUS_INBOX/);
});

test('the server speaks JSON-RPC: initialize, tools/list with one tool, tools/call, and an error for anything else', async () => {
  const out = [];
  const write = process.stdout.write;
  process.stdout.write = (s) => { out.push(JSON.parse(s)); return true; };
  try {
    await mcp.handle({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    await mcp.handle({ id: 2, method: 'tools/list' });
    await mcp.handle({ id: 3, method: 'tools/call', params: { name: 'add_task', arguments: { title: '' } } });
    await mcp.handle({ id: 4, method: 'resources/list' });
    await mcp.handle({ method: 'notifications/initialized' });
  } finally { process.stdout.write = write; }
  assert.strictEqual(out[0].result.protocolVersion, '2025-03-26');
  assert.strictEqual(out[0].result.serverInfo.name, 'romulus');
  assert.deepStrictEqual(out[1].result.tools.map((t) => t.name), ['add_task']);
  assert.ok(out[2].result.isError);
  assert.match(out[2].result.content[0].text, /title is required/);
  assert.strictEqual(out[3].error.code, -32601);
  assert.strictEqual(out.length, 4, 'a notification gets no answer');
});

test('the desktop takes the files in oldest first, cleans them, and throws away ones that are not tasks', () => {
  const folder = path.join(tmp, 'adds');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, '2-b.json'), JSON.stringify({ title: 'Second', list: 'work', due: '2026-12-01', time: '25:00', notes: 'n', from: 'Claude Desktop' }));
  fs.writeFileSync(path.join(folder, '1-a.json'), JSON.stringify({ title: 'First', list: 'agent' }));
  fs.writeFileSync(path.join(folder, '3-c.json'), JSON.stringify({ nothing: true }));
  fs.writeFileSync(path.join(folder, '4-d.json.tmp'), '{"title":"half');
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'x');
  const got = outside.pending(folder);
  assert.deepStrictEqual(got.map((x) => [x.file, x.title, x.list, x.due, x.time, x.notes, x.from]), [
    ['1-a.json', 'First', 'agent', null, null, null, 'another app'],
    ['2-b.json', 'Second', 'work', '2026-12-01', null, 'n', 'Claude Desktop'],
  ]);
  assert.ok(!fs.existsSync(path.join(folder, '3-c.json')), 'not a task: gone');
  assert.ok(fs.existsSync(path.join(folder, '4-d.json.tmp')), 'a file still being written is left alone');
  assert.strictEqual(outside.cleanItem({ title: 'x', list: 'finance' }).list, 'todo');
  assert.strictEqual(outside.cleanItem(null), null);
});

test('Claude Desktop’s config: the entry goes in beside what is there, and comes out again without touching the rest', () => {
  const ent = outside.entry({ exe: 'C:\\Apps\\Romulus.exe', script: 'C:\\data\\mcp\\tasks-mcp.js', inbox: 'C:\\data\\outside-adds' });
  assert.deepStrictEqual(ent, { command: 'C:\\Apps\\Romulus.exe', args: ['C:\\data\\mcp\\tasks-mcp.js'], env: { ELECTRON_RUN_AS_NODE: '1', ROMULUS_INBOX: 'C:\\data\\outside-adds' } });
  const before = JSON.stringify({ theme: 'dark', mcpServers: { github: { command: 'npx', args: ['x'] } } }, null, 2);
  const after = JSON.parse(outside.withEntry(before, ent));
  assert.strictEqual(after.theme, 'dark');
  assert.deepStrictEqual(Object.keys(after.mcpServers).sort(), ['github', 'romulus']);
  assert.deepStrictEqual(after.mcpServers.romulus, ent);
  assert.deepStrictEqual(after.mcpServers.github, { command: 'npx', args: ['x'] });
  const gone = JSON.parse(outside.withEntry(JSON.stringify(after), null));
  assert.deepStrictEqual(Object.keys(gone.mcpServers), ['github']);
  assert.strictEqual(gone.theme, 'dark');
  assert.deepStrictEqual(JSON.parse(outside.withEntry('', ent)), { mcpServers: { romulus: ent } }, 'no file yet');
  assert.throws(() => outside.withEntry('[1]', ent), /not a settings file/);
  assert.throws(() => outside.withEntry('{oops', ent));
});

test('where Claude Desktop keeps its config on each platform', () => {
  assert.strictEqual(outside.configPath('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a'), path.join('C:\\Users\\a\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
  assert.strictEqual(outside.configPath('darwin', {}, '/Users/a'), path.join('/Users/a', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
  assert.strictEqual(outside.configPath('linux', {}, '/home/a'), path.join('/home/a', '.config', 'Claude', 'claude_desktop_config.json'));
  assert.strictEqual(outside.configPath('linux', { XDG_CONFIG_HOME: '/x' }, '/home/a'), path.join('/x', 'Claude', 'claude_desktop_config.json'));
});
