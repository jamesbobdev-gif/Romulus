/* The TV, through Media Hub (github.com/jamesbobdev-gif/mediahub): a hub on the home network that the TVs open.
   The local model gets one tool, media_hub, that lists the TVs, searches every source's titles, and tells a
   TV to play, pause, open a site, press a key or show a line. The hub forwards each command to the TV and
   hands back the TV's answer; this file turns that into a sentence the model can repeat to him.
   Address and control token come from Settings → Local model (config.mediaHub). Only the local lane gets
   the tool: nothing about what he watches goes to a cloud AI. No Electron here, so it can be tested on its own. */
'use strict';

const TOOL = { type: 'function', function: { name: 'media_hub',
  description: 'The TVs in the house, through the Media Hub. action: tvs (list the TVs and what each shows), search (find a title across every source: query), play (a title: item id from search, on tv), open (a source such as pbs or tubi: source id, on tv), pause, resume, stop, home, status, key (press one remote key: intent), say (show a short line on the TV: text). tv is the TV id from tvs; with one TV it may be left out. Always search first and use the id it gives; never make an id up.',
  parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['tvs', 'search', 'play', 'open', 'pause', 'resume', 'stop', 'home', 'status', 'key', 'say'] },
    tv: { type: 'string', description: 'which TV, by id from tvs' },
    query: { type: 'string', description: 'search: the title or words to look for' },
    item: { type: 'string', description: 'play: the title id from search' },
    source: { type: 'string', description: 'open: the source id, like pbs' },
    intent: { type: 'string', description: 'key: up, down, left, right, select, back, play, pause, playpause, ff, rw, menu, info, search' },
    text: { type: 'string', description: 'say: up to 120 characters' },
  }, required: ['action'] } } };

// a task about the TV: a control word near a TV word, or the hub by name. "best TV to buy" is shopping, not this.
const TV_WORDS = '(?:tv|television|the (?:big )?screen|living ?room|bedroom|fire ?(?:tv|stick)|roku|media ?hub)';
const CONTROL = '(?:play|pause|resume|unpause|stop|put|open|watch|turn|skip|rewind|fast.?forward|go home|back to home|what(?:\'s| is) (?:on|playing)|press|next|previous)';
const TV_TASK = new RegExp('\\b' + CONTROL + '\\b.{0,40}\\b' + TV_WORDS + '\\b|\\b' + TV_WORDS + '\\b.{0,30}\\b' + CONTROL + '\\b|\\bmedia ?hub\\b', 'i');
function isTvTask(t) {
  const text = [t && t.title, t && t.notes, t && t.reply].map((x) => String(x || '')).join('\n');
  return TV_TASK.test(text);
}

const cleanUrl = (u) => {
  u = String(u || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) && !/^https?:\/\//i.test(u)) return null; // another scheme: not a hub address
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  try { const p = new URL(u); if (!/^https?:$/.test(p.protocol) || !p.hostname) return null; return p.origin; } catch (e) { return null; }
};
const hubOf = (cfg) => (cfg && cfg.mediaHub) || {};
function enabled(cfg) { return !!cleanUrl(hubOf(cfg).url); }
function publicConfig(cfg) { const h = hubOf(cfg); return { url: cleanUrl(h.url) || '', hasToken: !!h.token }; }
/* Settings → Local model → Media Hub: {url, token}. An empty address turns it off; an empty token keeps the one saved. */
function mergeConfig(cfg, change) {
  const url = cleanUrl(change && change.url);
  if (url === null) throw new Error('use an address like http://192.168.1.200:8787');
  if (!url) return null;
  const token = String((change && change.token) || '').trim() || hubOf(cfg).token || '';
  return { url, token };
}

const headersFor = (hub) => Object.assign({ accept: 'application/json' }, hub.token ? { authorization: 'Bearer ' + hub.token } : {});
async function call(hub, method, path, body, fetchImpl) {
  let r;
  try {
    r = await fetchImpl(hub.url + path, { method, headers: Object.assign(headersFor(hub), body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  } catch (e) { throw new Error('The Media Hub at ' + hub.url + ' did not answer (' + (e && e.name === 'TimeoutError' ? 'no reply in 15 seconds' : (e && e.message) || e) + '). Is the Pi on and on the same network?'); }
  let j = null; try { j = await r.json(); } catch (e) {}
  if (r.status === 401) throw new Error('The Media Hub refused the control token. Check it against controlToken in the hub\'s config/access.json (Settings → Local model → Media Hub).');
  if (r.status === 403) throw new Error('The Media Hub does not allow this computer: add its address to allowClients in the hub\'s config/access.json.');
  if (r.status === 404 && j && /unknown TV/i.test(j.error || '')) throw new Error('That TV is not known to the hub right now: open the hub on it again, then list the TVs.');
  if (!r.ok && !(j && j.error)) throw new Error('The Media Hub answered HTTP ' + r.status + ' for ' + path);
  return j == null ? {} : j;
}

const clock = (s) => { s = Math.max(0, Math.floor(Number(s) || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0'); };
function describeTv(tv) {
  const s = tv.state || {}, p = s.playing || {};
  let doing;
  if (!tv.online) doing = 'not connected (off, asleep, or on another app)';
  else if (p.active) doing = (p.paused ? 'paused' : 'playing') + (s.title ? ' ' + s.title : '') + (p.d ? ' at ' + clock(p.t) + ' of ' + clock(p.d) : '');
  else if (s.view === 'portal') doing = 'on ' + (s.source || 'a site') + (s.title ? ', ' + s.title : '') + ', nothing playing';
  else if (s.view === 'search') doing = 'on the search screen' + (s.query ? ' ("' + s.query + '")' : '');
  else if (s.view === 'settings') doing = 'in Settings';
  else doing = 'on the home screen' + (s.focus ? ' (focus on ' + s.focus + ')' : '');
  return tv.name + ' (id ' + tv.id + '): ' + doing;
}
const describeItem = (it, i) => (i + 1) + '. ' + it.title + (it.year ? ' (' + it.year + ')' : '') + (it.kind && it.kind !== 'movie' ? ' · ' + it.kind : '') +
  ' · id ' + it.id + ' · on ' + (it.sources || []).map((s) => s.source).join(', ');

/* Which TV a command goes to: the one he named, else the only one connected. Returns {tv} or {error}. */
function pickTv(tvs, wanted) {
  if (wanted) {
    const w = String(wanted).trim().toLowerCase();
    const tv = tvs.find((t) => t.id.toLowerCase() === w) || tvs.find((t) => String(t.name || '').toLowerCase() === w) || tvs.find((t) => String(t.name || '').toLowerCase().includes(w));
    return tv ? { tv } : { error: 'No TV called "' + wanted + '". The TVs: ' + (tvs.map(describeTv).join('; ') || 'none connected') + '.' };
  }
  const on = tvs.filter((t) => t.online);
  if (on.length === 1) return { tv: on[0] };
  if (!on.length) return { error: tvs.length ? 'No TV is connected right now: ' + tvs.map(describeTv).join('; ') + '. Ask him to open the Media Hub on the TV.' : 'No TV has opened the Media Hub since it started. Ask him to open the hub on the TV, then try again.' };
  return { error: 'Say which TV (tv: its id): ' + on.map(describeTv).join('; ') + '.' };
}

const COMMAND_OF = { play: (a) => ({ type: 'play', item: String(a.item || '').trim() }), open: (a) => ({ type: 'open_source', source: String(a.source || '').trim().toLowerCase() }),
  pause: () => ({ type: 'pause' }), resume: () => ({ type: 'resume' }), stop: () => ({ type: 'stop' }), home: () => ({ type: 'home' }), status: () => ({ type: 'status' }),
  key: (a) => ({ type: 'key', intent: String(a.intent || '').trim().toLowerCase() }), say: (a) => ({ type: 'say', text: String(a.text || '').trim().slice(0, 120) }) };

/* One tool call → one plain-English result for the model. Never throws: a problem is a sentence. */
async function run(args, cfg, { fetchImpl = fetch } = {}) {
  const hub = { url: cleanUrl(hubOf(cfg).url), token: hubOf(cfg).token || '' };
  if (!hub.url) return 'The Media Hub is not set up: he adds its address and control token in Settings → Local model → Media Hub.';
  const a = args || {}, action = String(a.action || '').trim().toLowerCase();
  try {
    if (action === 'tvs') {
      const tvs = await call(hub, 'GET', '/api/tv', null, fetchImpl);
      return tvs.length ? 'TVs on the hub:\n' + tvs.map(describeTv).join('\n') : 'No TV has opened the Media Hub since it started. Ask him to open the hub on the TV.';
    }
    if (action === 'search') {
      const q = String(a.query || '').trim();
      if (!q) return 'search needs query: the title or words to look for.';
      const r = await call(hub, 'GET', '/api/catalog/search?q=' + encodeURIComponent(q.slice(0, 80)) + '&limit=10', null, fetchImpl);
      const items = Array.isArray(r.items) ? r.items : [];
      return items.length ? 'Titles matching "' + q + '":\n' + items.map(describeItem).join('\n') + '\nUse play with the id.' : 'Nothing in the hub\'s catalog matches "' + q + '". Try other words, or open a source and let him browse.';
    }
    const make = COMMAND_OF[action];
    if (!make) return 'Unknown action "' + action + '". One of: tvs, search, play, open, pause, resume, stop, home, status, key, say.';
    const cmd = make(a);
    for (const k of Object.keys(cmd)) if (cmd[k] === '') return action + ' needs ' + (k === 'item' ? 'item: the title id from search' : k === 'source' ? 'source: the source id' : k) + '.';
    const tvs = await call(hub, 'GET', '/api/tv', null, fetchImpl);
    const picked = pickTv(Array.isArray(tvs) ? tvs : [], a.tv);
    if (picked.error) return picked.error;
    const tv = picked.tv;
    const r = await call(hub, 'POST', '/api/tv/' + encodeURIComponent(tv.id) + '/command', cmd, fetchImpl);
    if (r.pending) return tv.name + ' did not answer in time. Ask status in a few seconds to see what it is doing.';
    if (r.ok === false) return tv.name + ': ' + (r.error || 'could not do that') + '.';
    switch (action) {
      case 'play': return r.started ? 'Playing ' + (r.title || 'it') + ' on ' + tv.name + '.' : 'Opened ' + (r.title || 'it') + ' on ' + tv.name + ', but the video has not started yet. Check status in a few seconds; if it still has not, a select key press on the TV usually starts it.';
      case 'open': return 'Opened ' + (r.opened || cmd.source) + ' on ' + tv.name + (r.loaded ? '.' : ', still loading.');
      case 'status': return describeTv(Object.assign({}, tv, { state: r.state || tv.state }));
      case 'key': return 'Pressed ' + cmd.intent + ' on ' + tv.name + (r.focus ? '. Focus is now on ' + r.focus : '') + '.';
      case 'say': return 'Shown on ' + tv.name + ': "' + cmd.text + '".';
      case 'stop': return 'Stopped on ' + tv.name + (r.view === 'home' ? ', back at the home screen.' : '.');
      default: return (action === 'home' ? 'Home screen' : action.charAt(0).toUpperCase() + action.slice(1) + 'd') + ' on ' + tv.name + '.';
    }
  } catch (e) { return (e && e.message) || String(e); }
}

/* Settings → Save: one look at the hub, so he knows at once whether the address and token work. */
async function check(cfg, { fetchImpl = fetch } = {}) {
  const hub = { url: cleanUrl(hubOf(cfg).url), token: hubOf(cfg).token || '' };
  if (!hub.url) return '';
  const tvs = await call(hub, 'GET', '/api/tv', null, fetchImpl);
  return !tvs.length ? 'the hub answers; no TV has opened it yet' : tvs.length + ' TV' + (tvs.length === 1 ? '' : 's') + ': ' + tvs.map((t) => t.name + (t.online ? '' : ' (not connected)')).join(', ');
}

module.exports = { TOOL, isTvTask, enabled, publicConfig, mergeConfig, run, check, describeTv, pickTv };
