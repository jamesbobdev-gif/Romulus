// agent/previews.js: an Amazon link whose page shows the bot check still gets its photo, from Amazon's
// image server by product number
const test = require('node:test');
const assert = require('node:assert');
const previews = require('../agent/previews');

previews.init({ readConfig: () => ({ agentRunner: { browser: false } }), agentLog: () => {} });

function fakeFetch(picture) {
  return async (url) => {
    if (/\/images\/P\//.test(url)) return picture;
    // the product page: Amazon's "Continue shopping" check
    return { ok: true, status: 200, text: async () => '<form action="/errors/validateCaptcha"></form>' };
  };
}
const jpeg = { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new ArrayBuffer(12000) };
const blankGif = { ok: true, headers: { get: () => 'image/gif' }, arrayBuffer: async () => new ArrayBuffer(43) };

test('bot check: the photo comes from the image server by product number', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch(jpeg));
  const o = await previews.enrichOption({ label: 'Eye cream', url: 'https://www.amazon.com/Eye-Cream/dp/b01ehw5jyi?ref=x' });
  assert.strictEqual(o.url, 'https://www.amazon.com/dp/b01ehw5jyi');
  assert.strictEqual(o.image, 'https://m.media-amazon.com/images/P/B01EHW5JYI.01._SCLZZZZZZZ_.jpg');
});

test('no picture on the image server (a 1-pixel gif): the card keeps its link, no photo', async (t) => {
  t.mock.method(global, 'fetch', fakeFetch(blankGif));
  const o = await previews.enrichOption({ label: 'New item', url: 'https://www.amazon.com/dp/B0H61NKYDD' });
  assert.strictEqual(o.url, 'https://www.amazon.com/dp/B0H61NKYDD');
  assert.strictEqual(o.image, undefined);
});

test('amazonAsinPicture: no product number, no picture', async () => {
  assert.strictEqual(await previews.amazonAsinPicture('https://www.amazon.com/s?k=eye+cream'), null);
});
