const test = require('node:test');
const assert = require('node:assert');
const { next, parseAction, keyCombo, neverPressed, parseFg, terminalInFront, firstJson, describe, promptText } = require('../agent/pc-control');

const IMG = { mime: 'image/png', b64: 'AAAA' };
const SIZE = { w: 1280, h: 720 };
const cfg = (ai) => ({ ai: Object.assign({ order: [] }, ai) });
const gemini = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });

test('firstJson: the action out of a fenced or chatty reply', () => {
  assert.deepStrictEqual(firstJson('Sure.\n```json\n{"do":"click","x":5,"y":6}\n```'), { do: 'click', x: 5, y: 6 });
  assert.deepStrictEqual(firstJson('{"do":"type","text":"a } b"} then more'), { do: 'type', text: 'a } b' });
  assert.strictEqual(firstJson('no json here'), null);
});

test('parseAction: a click inside the picture, with its button', () => {
  const r = parseAction('{"do":"click","x":100.4,"y":200,"button":"right","why":"menu"}', SIZE);
  assert.deepStrictEqual(r.action, { do: 'click', x: 100, y: 200, button: 'right', double: false, why: 'menu' });
});

test('parseAction: clicks and drags off the picture come back for another try', () => {
  assert.ok(parseAction('{"do":"click","x":1280,"y":10}', SIZE).bad);
  assert.ok(parseAction('{"do":"click","x":-1,"y":10}', SIZE).bad);
  assert.ok(parseAction('{"do":"drag","x":1,"y":1,"x2":5000,"y2":1}', SIZE).bad);
  assert.ok(parseAction('{"do":"fly"}', SIZE).bad);
  assert.ok(parseAction('nothing', SIZE).bad);
});

test('parseAction: never types a card number, whatever the AI says', () => {
  assert.ok(parseAction('{"do":"type","text":"4111 1111 1111 1111"}', SIZE).refuse);
  assert.ok(parseAction('{"do":"type","text":"4111-1111-1111-1111"}', SIZE).refuse);
  assert.ok(parseAction('{"do":"type","text":"call 555 123 4567"}', SIZE).action);
});

test('parseAction: scroll and wait are kept in bounds', () => {
  assert.strictEqual(parseAction('{"do":"scroll","x":1,"y":1,"amount":50}', SIZE).action.amount, 10);
  assert.strictEqual(parseAction('{"do":"wait","seconds":60}', SIZE).action.seconds, 5);
});

test('keyCombo: names, letters and F keys to Windows key codes; arrows are extended keys', () => {
  assert.deepStrictEqual(keyCombo('ctrl+shift+t'), [{ vk: 17, ext: false }, { vk: 16, ext: false }, { vk: 84, ext: false }]);
  assert.deepStrictEqual(keyCombo('Win'), [{ vk: 91, ext: true }]);
  assert.deepStrictEqual(keyCombo('f5'), [{ vk: 116, ext: false }]);
  assert.deepStrictEqual(keyCombo('down'), [{ vk: 40, ext: true }]);
  assert.strictEqual(keyCombo('ctrl+banana'), null);
  assert.strictEqual(keyCombo(''), null);
});

test('describe: typed text is only quoted when short', () => {
  assert.match(describe({ do: 'type', text: 'hello', why: '' }), /"hello"/);
  assert.doesNotMatch(describe({ do: 'type', text: 'x'.repeat(60), why: '' }), /xxxx/);
});

test('promptText: the picture size, his request and the steps so far', () => {
  const t = promptText({ goal: 'open notepad', steps: ['Pressed win'], w: 1280, h: 720 });
  assert.match(t, /1280 x 720/);
  assert.match(t, /open notepad/);
  assert.match(t, /1\. Pressed win/);
});

test('next: the first AI that can read a picture gives the action, and is remembered', async () => {
  const sent = [];
  const fetch = async (url, o) => { sent.push(JSON.parse(o.body)); return gemini('{"do":"key","keys":"win","why":"open start"}'); };
  const r = await next(cfg({ geminiKey: 'g', groqKey: 'q' }), { goal: 'open notepad', steps: [], image: IMG, ...SIZE, lane: 'cloud' },
    { fetch, order: ['groq', 'gemini'], local: null });
  assert.strictEqual(r.action.do, 'key');
  assert.strictEqual(r.stick, 'gemini');
  assert.strictEqual(sent.length, 1); // Groq can't read a picture, so it isn't asked
  assert.strictEqual(sent[0].contents[0].parts[0].inline_data.data, 'AAAA');
});

test('next: says why when nothing can read a picture', async () => {
  const r = await next(cfg({ groqKey: 'q' }), { goal: 'x', steps: [], image: IMG, ...SIZE, lane: 'cloud' }, { fetch: async () => { throw new Error('no'); }, order: ['groq'], local: null });
  assert.match(r.why, /screenshot/);
});

test('parseAction: the Run box, Task Manager and Alt+F4 are never pressed for him; Win alone is', () => {
  assert.match(parseAction('{"do":"key","keys":"win+r"}', SIZE).bad, /Win\+R/);
  assert.match(parseAction('{"do":"key","keys":"alt+f4"}', SIZE).bad, /Alt\+F4/);
  assert.match(parseAction('{"do":"key","keys":"ctrl+shift+esc"}', SIZE).bad, /Task Manager/);
  assert.match(parseAction('{"do":"key","keys":"ctrl+alt+delete"}', SIZE).bad, /Ctrl\+Alt\+Delete/);
  assert.ok(parseAction('{"do":"key","keys":"win"}', SIZE).action);
  assert.ok(parseAction('{"do":"key","keys":"ctrl+l"}', SIZE).action);
  assert.strictEqual(neverPressed([{ vk: 17 }, { vk: 67 }]), null);
});

test('terminalInFront: a console, a terminal, the Run box or the Registry Editor, not a browser about them', () => {
  const fg = (cls, title) => parseFg(cls + '\t' + title);
  assert.ok(terminalInFront(fg('ConsoleWindowClass', 'Windows PowerShell')));
  assert.ok(terminalInFront(fg('CASCADIA_HOSTING_WINDOW_CLASS', 'Windows Terminal')));
  assert.ok(terminalInFront(fg('HwndWrapper[powershell_ise.exe;;1]', 'Windows PowerShell ISE')));
  assert.ok(terminalInFront(fg('#32770', 'Run')));
  assert.ok(terminalInFront(fg('RegEdit_RegEdit', 'Registry Editor')));
  assert.ok(terminalInFront(fg('Chrome_WidgetWin_1', 'Administrator: Command Prompt')));
  assert.ok(!terminalInFront(fg('Chrome_WidgetWin_1', 'bash tutorial - Google Chrome')));
  assert.ok(!terminalInFront(fg('#32770', 'Save As')));
  assert.ok(!terminalInFront(parseFg('')));
  assert.deepStrictEqual(parseFg('A\tB\tC'), { cls: 'A', title: 'B\tC' });
});
