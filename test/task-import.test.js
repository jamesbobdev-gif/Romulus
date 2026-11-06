const test = require('node:test');
const assert = require('node:assert');
const { parseImport, importToTasks, impDate, impRrule, impUnzip } = require('../renderer/js/task-import');

const NOW = new Date(2026, 10, 6, 9, 0); // Friday 6 Nov 2026

test('dates in the shapes apps write them', () => {
  assert.deepStrictEqual(impDate('2026-11-10'), { due: '2026-11-10', dueTime: null });
  assert.deepStrictEqual(impDate('2026-11-10 15:30'), { due: '2026-11-10', dueTime: '15:30' });
  assert.deepStrictEqual(impDate('11/10/2026'), { due: '2026-11-10', dueTime: null });
  assert.deepStrictEqual(impDate('25/12/2026'), { due: '2026-12-25', dueTime: null }); // day first when it has to be
  assert.deepStrictEqual(impDate('Nov 10 2026 3pm'), { due: '2026-11-10', dueTime: '15:00' });
  assert.deepStrictEqual(impDate('10 November 2026'), { due: '2026-11-10', dueTime: null });
  assert.deepStrictEqual(impDate('Nov 20', { now: NOW }), { due: '2026-11-20', dueTime: null });
  assert.deepStrictEqual(impDate('Jan 3', { now: NOW }), { due: '2027-01-03', dueTime: null }); // long gone this year: next year
  assert.deepStrictEqual(impDate('2026-11-10T00:00:00.000Z', { dateOnly: true }), { due: '2026-11-10', dueTime: null });
  assert.deepStrictEqual(impDate('next week'), { due: null, dueTime: null });
  assert.deepStrictEqual(impDate('2026-02-30'), { due: null, dueTime: null });
  const t = impDate('2026-11-10T15:00:00Z'); // a real moment: moved to this computer's time
  const d = new Date('2026-11-10T15:00:00Z');
  assert.strictEqual(t.dueTime, String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'));
});

test('repeat rules', () => {
  assert.strictEqual(impRrule('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO'), 'week');
  assert.strictEqual(impRrule('FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR'), 'weekday');
  assert.strictEqual(impRrule('FREQ=DAILY;INTERVAL=1'), 'day');
  assert.strictEqual(impRrule('FREQ=WEEKLY;INTERVAL=2'), '2week');
  assert.strictEqual(impRrule('FREQ=DAILY;INTERVAL=3'), null);
  assert.strictEqual(impRrule(''), null);
});

test('Todoist: sections and @labels tag, indents are steps, notes join, repeats', () => {
  const csv = [
    'TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT',
    'task,Pay rent,,4,1,James (1),,Nov 30 2026,en,America/Chicago,,',
    'task,Call bank @phone,"Ask about the fee",1,1,James (1),,,en,America/Chicago,,',
    'task,Find the account number,,1,2,James (1),,,en,America/Chicago,,',
    'note,They close at 5,,,,,,,,,,',
    ',,,,,,,,,,,',
    'section,Chores,,,,,,,,,,',
    'task,Take out trash,,1,1,James (1),,every monday,en,America/Chicago,,'
  ].join('\n');
  const r = parseImport(csv, { fileName: 'Home.csv', now: NOW });
  assert.strictEqual(r.source, 'todoist');
  assert.strictEqual(r.items.length, 3);
  assert.deepStrictEqual([r.items[0].title, r.items[0].due, r.items[0].tag], ['Pay rent', '2026-11-30', 'Home']);
  assert.strictEqual(r.items[1].title, 'Call bank');
  assert.strictEqual(r.items[1].tag, 'phone');
  assert.strictEqual(r.items[1].notes, 'Ask about the fee\n\nThey close at 5');
  assert.deepStrictEqual(r.items[1].subs, [{ title: 'Find the account number', done: false }]);
  assert.deepStrictEqual([r.items[2].tag, r.items[2].recur, r.items[2].due], ['Chores', 'week', '2026-11-09']);
});

test('TickTick backup: skips its preamble, lists and tags, checklists, subtasks, done ones', () => {
  const csv = [
    '"Date: 2026-11-06+0000"',
    '"Version: 7.1"',
    '"Status: ',
    '0 Normal',
    '1 Completed',
    '2 Archived"',
    '"Folder Name","List Name","Title","Kind","Tags","Content","Is Check list","Start Date","Due Date","Reminder","Repeat","Priority","Status","Created Time","Completed Time","Order","Timezone","Is All Day","Is Floating","Column Name","Column Order","View Mode","taskId","parentId"',
    '"","Inbox","Buy milk","TEXT","","","N","","2026-11-10T06:00:00+0000","","","0","0","2026-11-01T10:00:00+0000","","1","America/Chicago","true","false","","","list","11",""',
    '"","Groceries","Weekly shop","CHECKLIST","","\u25abEggs\n\u25aaBread","Y","","","","FREQ=WEEKLY;INTERVAL=1","0","0","","","2","America/Chicago","","false","","","list","12",""',
    '"","Work","Send report","TEXT","urgent,office","Q3 numbers","N","","","","","0","2","","2026-11-02T15:00:00+0000","3","America/Chicago","","false","","","list","13",""',
    '"","Work","Attach the chart","TEXT","","","N","","","","","0","0","","","4","America/Chicago","","false","","","list","14","13"'
  ].join('\n');
  const r = parseImport(csv, { fileName: 'TickTick-backup.csv' });
  assert.strictEqual(r.source, 'ticktick');
  assert.strictEqual(r.items.length, 3);
  const [milk, shop, report] = r.items;
  assert.strictEqual(milk.title, 'Buy milk');
  assert.strictEqual(milk.tag, null); // Inbox isn't a tag
  assert.strictEqual(milk.dueTime, null); // all day
  assert.ok(/^2026-11-(09|10)$/.test(milk.due));
  assert.deepStrictEqual(shop.subs, [{ title: 'Eggs', done: false }, { title: 'Bread', done: true }]);
  assert.strictEqual(shop.tag, 'Groceries');
  assert.strictEqual(shop.recur, null); // no date, so no repeat
  assert.strictEqual(report.done, true);
  assert.strictEqual(report.tag, 'urgent');
  assert.strictEqual(report.notes, 'Q3 numbers');
  assert.deepStrictEqual(report.subs, [{ title: 'Attach the chart', done: false }]);
});

test('Google Tasks Takeout: lists tag, subtasks become steps, deleted ones skipped', () => {
  const j = JSON.stringify({ kind: 'tasks#taskLists', items: [
    { kind: 'tasks#taskList', title: 'My Tasks', items: [
      { id: 'a', title: 'Renew license', due: '2026-12-01T00:00:00.000Z', status: 'needsAction' },
      { id: 'b', title: 'Get photo taken', parent: 'a', status: 'completed' },
      { id: 'c', title: 'Old thing', deleted: true, status: 'needsAction' }
    ] },
    { kind: 'tasks#taskList', title: 'Shopping', items: [{ id: 'd', title: 'Socks', status: 'completed', completed: '2026-10-01T12:00:00.000Z' }] }
  ] });
  const r = parseImport(j, { fileName: 'Tasks.json' });
  assert.strictEqual(r.source, 'gtasks');
  assert.strictEqual(r.items.length, 2);
  assert.deepStrictEqual([r.items[0].title, r.items[0].due, r.items[0].tag], ['Renew license', '2026-12-01', null]);
  assert.deepStrictEqual(r.items[0].subs, [{ title: 'Get photo taken', done: true }]);
  assert.deepStrictEqual([r.items[1].tag, r.items[1].done], ['Shopping', true]);
});

test('Trello board: labels or list tag, checklists, archived cards left out, a Done list is done', () => {
  const j = JSON.stringify({ name: 'Life', lists: [{ id: 'l1', name: 'To Do' }, { id: 'l2', name: 'Done' }],
    labels: [{ id: 'g', name: 'Garden' }],
    cards: [
      { id: 'c1', name: 'Plant bulbs', desc: 'Tulips', idList: 'l1', idLabels: ['g'], due: null, closed: false },
      { id: 'c2', name: 'Fix fence', idList: 'l2', idLabels: [], closed: false },
      { id: 'c3', name: 'Archived', idList: 'l1', idLabels: [], closed: true }
    ],
    checklists: [{ id: 'k', idCard: 'c1', checkItems: [{ name: 'Buy bulbs', state: 'complete', pos: 1 }, { name: 'Dig', state: 'incomplete', pos: 2 }] }] });
  const r = parseImport(j);
  assert.strictEqual(r.source, 'trello');
  assert.strictEqual(r.items.length, 2);
  assert.deepStrictEqual([r.items[0].tag, r.items[0].notes], ['Garden', 'Tulips']);
  assert.deepStrictEqual(r.items[0].subs, [{ title: 'Buy bulbs', done: true }, { title: 'Dig', done: false }]);
  assert.deepStrictEqual([r.items[1].done, r.items[1].tag], [true, null]);
});

test('Asana CSV: sections tag, parent tasks get steps', () => {
  const csv = [
    'Task ID,Created At,Completed At,Last Modified,Name,Section/Column,Assignee,Assignee Email,Start Date,Due Date,Tags,Notes,Projects,Parent task',
    '1,2026-10-01,,2026-10-02,Launch site,Marketing,,,,2026-11-20,,Go live,Web,',
    '2,2026-10-01,2026-10-03,2026-10-03,Write copy,Marketing,,,,,,,Web,Launch site'
  ].join('\n');
  const r = parseImport(csv, { fileName: 'Web.csv' });
  assert.strictEqual(r.source, 'asana');
  assert.strictEqual(r.items.length, 1);
  assert.deepStrictEqual([r.items[0].title, r.items[0].due, r.items[0].tag, r.items[0].notes], ['Launch site', '2026-11-20', 'Marketing', 'Go live']);
  assert.deepStrictEqual(r.items[0].subs, [{ title: 'Write copy', done: true }]);
});

test('any spreadsheet (Notion, Excel): columns found from the header', () => {
  const csv = 'Name,Status,Due date,Tags,Notes\nDentist,Not started,"November 12, 2026",Health,Bring card\nTaxes,Done,04/15/2026,Money,\n';
  const r = parseImport(csv, { fileName: 'Tasks_all.csv' });
  assert.strictEqual(r.source, 'csv');
  assert.deepStrictEqual(r.items.map((i) => [i.title, i.due, i.done, i.tag]), [['Dentist', '2026-11-12', false, 'Health'], ['Taxes', '2026-04-15', true, 'Money']]);
  assert.strictEqual(r.items[0].notes, 'Bring card');
  // semicolons, and no header at all
  assert.deepStrictEqual(parseImport('Task;Due\nWash car;2026-11-08\n').items.map((i) => i.due), ['2026-11-08']);
  assert.deepStrictEqual(parseImport('just one,thing\nanother,row', { fileName: 'x.csv' }).items.map((i) => i.title), ['just one', 'another']);
});

test('a pasted list: bullets, boxes, headings tag, indented steps, #tags and repeats', () => {
  const text = [
    'Groceries:',
    '- [ ] Milk',
    '- [x] Eggs',
    '',
    '# Home',
    '* Fix the sink',
    '    * Buy a washer',
    '1. Water plants every sunday',
    'Call mom #family'
  ].join('\n');
  const r = parseImport(text, { now: NOW });
  assert.strictEqual(r.source, 'text');
  assert.deepStrictEqual(r.items.map((i) => [i.title, i.tag, i.done]), [
    ['Milk', 'Groceries', false], ['Eggs', 'Groceries', true], ['Fix the sink', 'Home', false], ['Water plants', 'Home', false], ['Call mom', 'family', false]
  ]);
  assert.deepStrictEqual(r.items[2].subs, [{ title: 'Buy a washer', done: false }]);
  assert.deepStrictEqual([r.items[3].recur, r.items[3].due], ['week', '2026-11-08']);
  // Apple Reminders copies a plain column of names
  assert.deepStrictEqual(parseImport('Pick up dry cleaning\nBook flights\n').items.map((i) => i.title), ['Pick up dry cleaning', 'Book flights']);
});

test('a JSON file that isn\'t tasks says so', () => {
  const r = parseImport('{"hello":"world"}');
  assert.strictEqual(r.items.length, 0);
  assert.ok(r.error);
});

test('to tasks: on the chosen list, finished ones only when asked, no copies on a second import', () => {
  const r = parseImport('- [ ] Milk\n- [x] Eggs\n- [ ] Walk dog every day', { now: NOW });
  const first = importToTasks(r.items, { ws: 'work', existing: [], now: 1000 });
  assert.deepStrictEqual(first.tasks.map((t) => [t.title, t.ws, t.done]), [['Milk', 'work', false], ['Walk dog', 'work', false]]);
  assert.deepStrictEqual(first.tasks[1].recur, { every: 'day', dom: 6, series: first.tasks[1].id });
  assert.ok(first.tasks.every((t) => /^imp-/.test(t.id) && Array.isArray(t.subs)));
  const withDone = importToTasks(r.items, { ws: 'work', existing: [], withDone: true, now: 1000 });
  assert.strictEqual(withDone.tasks.length, 3);
  assert.strictEqual(withDone.tasks[1].doneAt, 1000);
  // again, with the first lot already there (or one of them deleted since)
  const again = importToTasks(r.items, { ws: 'work', existing: first.tasks.slice(1), tombstones: [{ id: first.tasks[0].id }] });
  assert.deepStrictEqual([again.tasks.length, again.skipped], [0, 2]);
  // a task he already typed in by hand, same name and day
  const typed = importToTasks(parseImport('Milk').items, { existing: [{ id: 'x', title: 'milk', due: null }] });
  assert.deepStrictEqual([typed.tasks.length, typed.skipped], [0, 1]);
});

test('a Google Takeout .zip: the tasks file inside is read, other files skipped', async () => {
  const b64 = 'UEsDBBQAAAAIAEdVZl3BcT+WvAAAAGsCAAAYAAAAVGFrZW91dC9UYXNrcy9UYXNrcy5qc29u7ZIxC8IwEIX/SjjXVtIODt0cxMVJnJQOaXNgaL2U5IqF0v8uCVi1OPgDPMIN7717y5cRGkMaCgGsfONXYR+MZw+JAMN481CIywhsuMUQ2zmnSC9tEytUUOfkEQnvojU1ksfg6D7qucw3aZanMjtJWcS3llKeQ8Sz4j50AiFqv63ZWAoGWcaoD/8Zfh2YEvFkU32w2SOL7mrZBrVTDolngN8ZvFXVC8zcOxKVtU38Fa/z2t66Fhk1TOVUTg9QSwMEFAAAAAgAR1VmXR+HG2ALAAAADQAAABwAAABUYWtlb3V0L2FyY2hpdmVfYnJvd3Nlci5odG1ss8koyc2xs9EHUwBQSwECFAAUAAAACABHVWZdwXE/lrwAAABrAgAAGAAAAAAAAAAAAAAAgAEAAAAAVGFrZW91dC9UYXNrcy9UYXNrcy5qc29uUEsBAhQAFAAAAAgAR1VmXR+HG2ALAAAADQAAABwAAAAAAAAAAAAAAIAB8gAAAFRha2VvdXQvYXJjaGl2ZV9icm93c2VyLmh0bWxQSwUGAAAAAAIAAgCQAAAANwEAAAAA';
  const buf = Buffer.from(b64, 'base64');
  const files = await impUnzip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  assert.deepStrictEqual(files.map((f) => f.name), ['Takeout/Tasks/Tasks.json']);
  const r = parseImport(files[0].text, { fileName: 'Tasks.json' });
  assert.deepStrictEqual(r.items.map((i) => [i.title, i.tag, i.done, i.subs.length]), [['Renew license', 'Errands', false, 1], ['Return books', 'Errands', true, 0]]);
  await assert.rejects(impUnzip(new ArrayBuffer(40)));
});

// the add box's date reader (task-actions.js is a page script, so the one function is lifted out of it)
function withDateReader(fn) {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../renderer/js/task-actions.js'), 'utf8');
  const body = src.slice(src.indexOf('function parseSpokenTask'), src.indexOf('/* Spoken commands'));
  const formatDate = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  globalThis.parseSpokenTask = new Function('formatDate', body + '\nreturn parseSpokenTask;')(formatDate);
  try { fn(); } finally { delete globalThis.parseSpokenTask; }
}

test('a pasted list reads typed days the way the add box does', () => withDateReader(() => {
  const r = parseImport([
    'Call dentist tomorrow',
    'Send report friday at 3pm',
    'Pay rent every month on the 1st',
    'Water plants every sunday',
    'Pick up dry cleaning'
  ].join('\n'), { now: NOW });
  assert.deepStrictEqual(r.items.map((i) => [i.title, i.due, i.dueTime, i.recur]), [
    ['Call dentist', '2026-11-07', null, null],
    ['Send report', '2026-11-13', '15:00', null], // "friday" on a Friday is next week's, as in the add box
    ['Pay rent', '2026-12-01', null, 'month'], // the 1st has passed this month: the next one
    ['Water plants', '2026-11-08', null, 'week'],
    ['Pick up dry cleaning', null, null, null]
  ]);
  const t = importToTasks(r.items, { existing: [], now: 1000 }).tasks.find((x) => x.title === 'Pay rent');
  assert.strictEqual(t.recur.dom, 1); // repeats on the 1st, not on the day it was imported
}));
