const test = require('node:test');
const assert = require('node:assert');
const hub = require('../agent/media-hub');
const routing = require('../agent/routing');
const ctx = require('../agent/task-context');

const cfg = { mediaHub: { url: 'http://192.168.1.200:8787/', token: 'secret-words' } };

// a hub in a box: answers by path, records what it was asked
function fakeHub({ tvs, items = [], results = {} } = {}) {
  const calls = [];
  const json = (status, body) => ({ status, ok: status < 400, json: async () => body });
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    const u = new URL(url);
    if (u.pathname === '/api/tv') return json(200, tvs);
    if (u.pathname === '/api/catalog/search') return json(200, { query: u.searchParams.get('q'), items });
    const m = u.pathname.match(/^\/api\/tv\/([^/]+)\/command$/);
    if (m) { const cmd = JSON.parse(opts.body); const r = results[cmd.type] || { ok: true }; return json(r.ok === false ? 400 : 200, Object.assign({ command: '1' }, r)); }
    return json(404, { error: 'nope' });
  };
  return { fetchImpl, calls };
}
const fire = { id: 'a1b2c3d4', name: 'Fire TV', online: true, state: { view: 'home', focus: 'Search', playing: { active: false } } };
const lg = { id: 'ffee0011', name: 'LG TV', online: true, state: { view: 'portal', source: 'pbs', title: 'Nature', playing: { active: true, paused: true, t: 1203, d: 4320 } } };

test('a TV task is one with a control word near a TV word, or the hub by name', () => {
  for (const title of ['play Fantastic Planet on the TV', 'pause the living room tv', 'put PBS on the big screen', 'what\'s on the tv right now?', 'turn the fire stick to Tubi', 'media hub: list the tvs', 'TV: stop'])
    assert.ok(hub.isTvTask({ title }), title);
  for (const title of ['best 65 inch TV to buy', 'TV show recommendations like Severance', 'fix the bathroom screen door', 'play with the kids'])
    assert.equal(hub.isTvTask({ title }), false, title);
  assert.ok(hub.isTvTask({ title: 'tonight', reply: 'put the Archive film on the TV' }), 'his reply counts');
});

test('settings: an address turns it on, an empty one off, an empty token keeps the saved one', () => {
  assert.deepStrictEqual(hub.mergeConfig({}, { url: '192.168.1.200:8787/', token: 'abc' }), { url: 'http://192.168.1.200:8787', token: 'abc' });
  assert.deepStrictEqual(hub.mergeConfig(cfg, { url: 'http://192.168.1.200:8787', token: '' }), { url: 'http://192.168.1.200:8787', token: 'secret-words' });
  assert.strictEqual(hub.mergeConfig(cfg, { url: '' }), null);
  assert.throws(() => hub.mergeConfig({}, { url: 'ftp://x' }), /address like/);
  assert.deepStrictEqual(hub.publicConfig(cfg), { url: 'http://192.168.1.200:8787', hasToken: true });
  assert.equal(hub.enabled({}), false); assert.ok(hub.enabled(cfg));
});

test('tvs and search read the hub and come back as sentences, with the token on every call', async () => {
  const h = fakeHub({ tvs: [fire, lg], items: [{ id: '9e0d1234abcd5678', title: 'Fantastic Planet', year: 1973, kind: 'movie', sources: [{ source: 'archive' }] }] });
  const tvs = await hub.run({ action: 'tvs' }, cfg, { fetchImpl: h.fetchImpl });
  assert.match(tvs, /Fire TV \(id a1b2c3d4\): on the home screen \(focus on Search\)/);
  assert.match(tvs, /LG TV \(id ffee0011\): paused Nature at 20:03 of 1:12:00/);
  const s = await hub.run({ action: 'search', query: 'fantastic planet' }, cfg, { fetchImpl: h.fetchImpl });
  assert.match(s, /1\. Fantastic Planet \(1973\) · id 9e0d1234abcd5678 · on archive/);
  for (const c of h.calls) assert.equal(c.headers.authorization, 'Bearer secret-words');
  assert.equal(h.calls[1].url, 'http://192.168.1.200:8787/api/catalog/search?q=fantastic%20planet&limit=10');
});

test('play picks the only connected TV, names the title, and says when the video has not started', async () => {
  let h = fakeHub({ tvs: [fire], results: { play: { ok: true, title: 'Fantastic Planet', started: true } } });
  assert.equal(await hub.run({ action: 'play', item: '9e0d1234abcd5678' }, cfg, { fetchImpl: h.fetchImpl }), 'Playing Fantastic Planet on Fire TV.');
  assert.deepStrictEqual(h.calls[1].body, { type: 'play', item: '9e0d1234abcd5678' });
  assert.equal(h.calls[1].url, 'http://192.168.1.200:8787/api/tv/a1b2c3d4/command');
  h = fakeHub({ tvs: [fire], results: { play: { ok: true, title: 'Fantastic Planet', started: false } } });
  assert.match(await hub.run({ action: 'play', item: '9e0d1234abcd5678' }, cfg, { fetchImpl: h.fetchImpl }), /has not started yet/);
  assert.match(await hub.run({ action: 'play' }, cfg, { fetchImpl: h.fetchImpl }), /needs item/);
});

test('with two TVs it asks which; a name or an id picks one; a TV that is off is said so', async () => {
  const h = fakeHub({ tvs: [fire, lg] });
  assert.match(await hub.run({ action: 'pause' }, cfg, { fetchImpl: h.fetchImpl }), /Say which TV/);
  assert.equal(await hub.run({ action: 'pause', tv: 'lg tv' }, cfg, { fetchImpl: h.fetchImpl }), 'Paused on LG TV.');
  assert.equal(await hub.run({ action: 'home', tv: 'a1b2c3d4' }, cfg, { fetchImpl: h.fetchImpl }), 'Home screen on Fire TV.');
  const off = fakeHub({ tvs: [Object.assign({}, fire, { online: false })] });
  assert.match(await hub.run({ action: 'resume' }, cfg, { fetchImpl: off.fetchImpl }), /No TV is connected right now/);
  const none = fakeHub({ tvs: [] });
  assert.match(await hub.run({ action: 'stop' }, cfg, { fetchImpl: none.fetchImpl }), /No TV has opened the Media Hub/);
});

test('the TV\'s own refusal and the hub\'s errors come back as one sentence, never a throw', async () => {
  const h = fakeHub({ tvs: [fire], results: { pause: { ok: false, error: 'nothing is playing' } } });
  assert.equal(await hub.run({ action: 'pause' }, cfg, { fetchImpl: h.fetchImpl }), 'Fire TV: nothing is playing.');
  const refused = async () => ({ status: 401, ok: false, json: async () => ({ error: 'send the control token' }) });
  assert.match(await hub.run({ action: 'tvs' }, cfg, { fetchImpl: refused }), /refused the control token/);
  const down = async () => { throw new Error('ECONNREFUSED'); };
  assert.match(await hub.run({ action: 'tvs' }, cfg, { fetchImpl: down }), /did not answer .*ECONNREFUSED.*Is the Pi on/);
  assert.match(await hub.run({ action: 'tvs' }, {}, {}), /not set up/);
  assert.match(await hub.run({ action: 'reboot' }, cfg, { fetchImpl: h.fetchImpl }), /Unknown action/);
});

test('a TV task goes to the local model once the hub is set up; without it, nothing changes', () => {
  routing.useRouting(null);
  routing.init({ readConfig: () => cfg });
  assert.deepStrictEqual(routing.routeTask({ title: 'play Fantastic Planet on the TV' }), { lane: 'local', reason: 'the TV: your local model talks to the Media Hub' });
  assert.deepStrictEqual(routing.routeTask({ title: 'pause the tv #claude' }), { lane: 'claude', reason: 'tagged #claude' });
  routing.init({ readConfig: () => ({}) });
  assert.notEqual(routing.routeTask({ title: 'play Fantastic Planet on the TV' }).reason, 'the TV: your local model talks to the Media Hub');
});

test('the media-hub skill loads and matches TV tasks only', () => {
  const skill = ctx.loadSkills().find((s) => s.name === 'media-hub');
  assert.ok(skill && skill.match);
  assert.ok(skill.match.test('pause the TV'));
  assert.ok(skill.match.test('put PBS on the living room tv'));
  assert.equal(skill.match.test('best TV to buy under $500'), false);
});
