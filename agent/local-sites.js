/* The local model's sites (Settings → Routing → "Sites the local model may open"), kept up on their own:
   - a site the local lane actually opened in a run (a task's link, or a link one hop out) is remembered,
     so it's allowed next time without the task having to link it ('local:sites-seen' → the window adds it
     to the routing row)
   - a site its browser refused (not in the task, not allowed) becomes a to-do on his Human list: "Allow the
     local model on linkedin.com? …". Checking it off allows the site and runs the task again
     ('local:site-ask' → renderer/js/local-sites.js). Deleting the to-do is a no.
   No Electron here, so it can be tested on its own. */

const ASK_PREFIX = 'Allow the local model on ';

// "https://www.linkedin.com/jobs/x" → "linkedin.com"
const hostOf = (u) => { try { return new URL(/^https?:\/\//i.test(String(u)) ? String(u) : 'https://' + String(u)).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };
const cleanSite = (s) => String(s || '').trim().replace(/^https?:\/\//i, '').replace(/^\*\./, '').replace(/\/.*$/, '').replace(/^www\./, '').toLowerCase();
// is this host already covered by one of his sites (a site covers its subdomains)?
const covered = (host, sites) => sites.some((s) => host === s || host.endsWith('.' + s));
// the hosts a run reached that his list doesn't have yet (no bare names, no local addresses)
function newHosts(visited, sites) {
  const have = (Array.isArray(sites) ? sites : []).map(cleanSite).filter(Boolean);
  const out = [];
  for (const v of Array.isArray(visited) ? visited : []) {
    const h = cleanSite(v);
    if (!h || !h.includes('.') || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\d+\.\d+\.\d+\.\d+$)/.test(h) || /\.(local|localhost|internal|lan)$/.test(h)) continue;
    if (covered(h, have) || out.includes(h)) continue;
    out.push(h);
  }
  return out;
}
// his list with hosts added (no repeats, subdomains folded into a site already there)
const merge = (sites, hosts) => (Array.isArray(sites) ? sites : []).map(cleanSite).filter(Boolean).concat(newHosts(hosts, sites));
// the browser's refusal for a site outside the lock ("… https://x.com/y is not one of them.") → "x.com", or null
function refusedHost(text) {
  const m = String(text || '').match(/(\S+) is not one of them/);
  return m ? hostOf(m[1]) || null : null;
}
const askTitle = (host, taskTitle) => ASK_PREFIX + host + '? Check this off to let it open that site' + (taskTitle ? ' (for “' + String(taskTitle).replace(/\s+/g, ' ').slice(0, 60) + '”)' : '');
// the host a to-do made by askTitle is about, or null
function askHost(title) {
  const t = String(title || '');
  if (!t.startsWith(ASK_PREFIX)) return null;
  return cleanSite(t.slice(ASK_PREFIX.length).split('?')[0]) || null;
}

module.exports = { ASK_PREFIX, hostOf, cleanSite, covered, newHosts, merge, refusedHost, askTitle, askHost };
