/* The hidden window that reads a link's preview picture (agent/previews.js hiddenWindowPreview), against a
   stand-in for Electron's window: what the page it loads is allowed to do. */
const test = require('node:test');
const assert = require('node:assert');
const previews = require('../agent/previews');

function fakeWindow() {
  const on = {}, ses = { on: {} };
  const w = {
    destroyed: false, isDestroyed() { return w.destroyed; }, destroy() { w.destroyed = true; },
    loadURL: async () => {},
    webContents: {
      setAudioMuted() {}, setWindowOpenHandler() {}, on(name, f) { on[name] = f; },
      executeJavaScript: async () => 'https://shop.example.com/picture.jpg',
      session: { setPermissionRequestHandler(f) { ses.request = f; }, setPermissionCheckHandler(f) { ses.check = f; }, on(name, f) { ses.on[name] = f; } },
    },
  };
  return { w, on, ses };
}

test('the hidden preview window grants nothing, downloads nothing and stays on public https pages', async () => {
  const f = fakeWindow();
  previews.init({ newHiddenWindow: () => f.w, readConfig: () => ({}), agentLog() {} });
  assert.strictEqual(await previews.hiddenWindowPreview('https://shop.example.com/item'), 'https://shop.example.com/picture.jpg');
  assert.ok(f.w.destroyed);

  let answer = null;
  f.ses.request(null, 'media', (ok) => { answer = ok; });
  assert.strictEqual(answer, false);
  assert.strictEqual(f.ses.check(null, 'geolocation'), false);

  const stopped = (handler, ...args) => { let s = false; handler({ preventDefault() { s = true; }, url: args[0] }, ...args); return s; };
  assert.ok(stopped(f.ses.on['will-download']));
  for (const name of ['will-navigate', 'will-redirect']) {
    assert.ok(!stopped(f.on[name], 'https://www.example.com/next'), name);
    assert.ok(stopped(f.on[name], 'http://localhost:9222/json'), name);
    assert.ok(stopped(f.on[name], 'https://192.168.1.1/'), name);
    assert.ok(stopped(f.on[name], 'file:///etc/hosts'), name);
    assert.ok(stopped(f.on[name], 'someapp://open'), name);
  }
});
