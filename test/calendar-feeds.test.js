const test = require('node:test');
const assert = require('node:assert');
const feeds = require('../agent/calendar-feeds');

const cal = (events) => 'BEGIN:VCALENDAR\r\n' + events.map((e) =>
  'BEGIN:VEVENT\r\nUID:' + e.uid + '\r\nSUMMARY:' + e.title + '\r\nDTEND:20991231T235900Z\r\nEND:VEVENT\r\n').join('') + 'END:VCALENDAR\r\n';
// stands in for fetch: url → [status, body] or an Error
function withFetch(map, fn) {
  const real = global.fetch;
  global.fetch = async (u) => {
    const v = map[u];
    if (v instanceof Error) throw v;
    return { ok: v[0] === 200, status: v[0], text: async () => v[1] };
  };
  return fn().finally(() => { global.fetch = real; });
}

test('complete only when every link answers with events, so a missing item really is gone', async () => {
  const a = 'https://a.example/cal', b = 'https://b.example/cal';
  await withFetch({ [a]: [200, cal([{ uid: '1', title: 'Quiz 1' }])], [b]: [200, cal([{ uid: '2', title: 'Essay' }])] }, async () => {
    const r = await feeds.fetchAll([a, b]);
    assert.strictEqual(r.items.length, 2);
    assert.strictEqual(r.complete, true);
  });
  await withFetch({ [a]: [200, cal([{ uid: '1', title: 'Quiz 1' }])], [b]: [500, ''] }, async () => {
    assert.strictEqual((await feeds.fetchAll([a, b])).complete, false);
  });
  await withFetch({ [a]: [200, cal([{ uid: '1', title: 'Quiz 1' }])], [b]: [200, cal([])] }, async () => {
    assert.strictEqual((await feeds.fetchAll([a, b])).complete, false); // an empty calendar is more likely a hiccup
  });
  await withFetch({ [a]: new Error('offline') }, async () => {
    assert.strictEqual((await feeds.fetchAll([a])).complete, false);
  });
  assert.strictEqual((await feeds.fetchAll([])).complete, false);
});
