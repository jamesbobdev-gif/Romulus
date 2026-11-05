/* The browser launcher (agent/browser-proxy.js) with no lock, no mail mode and no site list: a name that resolves to
   this computer or the LAN is refused like a private address, a PIN or card number can't be typed key by key, and
   Link's card values are blanked as text. A module of its own, because the launcher reads its settings once. */
const test = require('node:test');
const assert = require('node:assert');
delete process.env.TASKS_BROWSER_LOCK;
delete process.env.TASKS_BROWSER_HOSTS;
delete process.env.TASKS_BROWSER_APPROVED_HOSTS;
delete process.env.TASKS_LINK_CLI;
process.env.TASKS_BROWSER_MAIL = '';
process.env.TASKS_BROWSER_APPROVED = '0';
process.env.TASKS_BROWSER_FILES = '[]';
process.env.TASKS_BROWSER_ACTIONS = '';
const mod = require.resolve('../agent/browser-proxy');
delete require.cache[mod];
const proxy = require('../agent/browser-proxy');

const call = (name, args) => ({ id: 1, params: { name, arguments: args } });
const looked = [];
proxy._net.setLookup(async (h) => {
  looked.push(h);
  const m = /^(\d+)-(\d+)-(\d+)-(\d+)\.nip\.example$/.exec(h);
  if (m) return [{ address: m.slice(1, 5).join('.'), family: 4 }];
  if (h === 'gone.example') throw new Error('ENOTFOUND');
  return [{ address: '93.184.216.34', family: 4 }];
});

test('a name that resolves to this computer or the LAN can\'t be opened, and nothing is clicked on such a page', async () => {
  for (const u of ['http://127-0-0-1.nip.example:9222/json/list', 'https://192-168-1-1.nip.example/admin', 'http://10-0-0-7.nip.example/'])
    assert.match(await proxy.resolvedRefusal(call('browser_navigate', { url: u })), /points at this computer or its network/, u);
  assert.match(await proxy.resolvedRefusal(call('browser_tabs', { action: 'new', url: 'http://192-168-1-1.nip.example/' })), /points at this computer/);
  assert.strictEqual(await proxy.resolvedRefusal(call('browser_navigate', { url: 'https://example.com/' })), null);
  assert.strictEqual(await proxy.resolvedRefusal(call('browser_navigate', { url: 'https://gone.example/' })), null); // the browser shows its own error
  assert.strictEqual(await proxy.resolvedRefusal(call('browser_navigate', { url: 'http://127.0.0.1/' })), null); // an address: schemeRefusal's job
  assert.match(proxy.schemeRefusal(call('browser_navigate', { url: 'http://127.0.0.1/' })), /not this computer/);
  // reached by a redirect: reading is allowed, acting is not
  const here = 'http://192-168-1-1.nip.example/admin';
  assert.match(await proxy.resolvedRefusal(call('browser_click', { ref: 'e1' }), here), /where the agent may not act/);
  assert.strictEqual(await proxy.resolvedRefusal(call('browser_snapshot', {}), here), null);
  assert.strictEqual(await proxy.resolvedRefusal(call('browser_click', { ref: 'e1' }), 'https://example.com/'), null);
});

test('a name is looked up once per run', async () => {
  looked.length = 0;
  for (let i = 0; i < 3; i++) await proxy.resolvedRefusal(call('browser_navigate', { url: 'https://once.example/' + i }));
  assert.deepStrictEqual(looked, ['once.example']);
});

test('a PIN or card number can\'t be typed key by key into the field just clicked', () => {
  proxy.learnRefs(['- textbox "Card number" [ref=c1]', '- textbox "Search" [ref=s1]', '- textbox "EBT PIN" [ref=p1]'].join('\n'));
  const here = 'https://www.walmart.com/checkout';
  assert.match(proxy.buyRefusal(call('browser_type', { ref: 'c1', text: '4111' }), here), /Never type a PIN, card number or security code/);
  proxy.noteAction(call('browser_click', { ref: 'c1', element: 'card number' }), here); // the click went through: focus is in the card field
  assert.match(proxy.buyRefusal(call('browser_press_key', { key: '4' }), here), /not even one key at a time/);
  assert.match(proxy.buyRefusal(call('browser_press_key', { key: 'Digit4' }), here), /not even one key at a time/);
  assert.match(proxy.buyRefusal(call('browser_press_key', { key: 'Numpad1' }), here), /not even one key at a time/);
  assert.strictEqual(proxy.buyRefusal(call('browser_press_key', { key: 'Tab' }), here), null); // leaving the field is fine
  proxy.noteAction(call('browser_click', { ref: 's1', element: 'search' }), here);
  assert.strictEqual(proxy.buyRefusal(call('browser_press_key', { key: '4' }), here), null);
  proxy.noteAction(call('browser_fill_form', { fields: [{ ref: 's1', name: 'search', value: 'milk' }, { ref: 'p1', name: 'EBT PIN', value: '' }] }), here);
  assert.match(proxy.buyRefusal(call('browser_press_key', { key: '1' }), here), /not even one key/);
  proxy.noteAction(call('browser_navigate', { url: 'https://www.walmart.com/' }), here); // a new page: nothing is focused
  assert.strictEqual(proxy.buyRefusal(call('browser_press_key', { key: '1' }), 'https://www.walmart.com/'), null);
});
