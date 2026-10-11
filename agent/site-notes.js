/* Site notes: what's worth knowing about one website before working on it ("Apply opens a popup",
   "asks for a code sent by email", "blocks page fetches: use the browser"). Two places:
   - agent/sites/*.md, written by hand (or by Claude) and kept in the repo
   - <userData>/site-notes/<site>.md, learned: after a browser run the mini PC's model may leave a tip
     about a site it actually worked on; the newest few are kept, marked as unchecked
   Frontmatter: name, sites (comma-separated domains; a domain also covers its subdomains).
   No Electron here, so it can be tested on its own. */
const fs = require('fs');
const path = require('path');

const MAX_LEARNED = 10; // tips kept per site
const hostOf = (u) => { try { return new URL(String(u)).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };
const covers = (domain, host) => !!host && (host === domain || host.endsWith('.' + domain));

function load(dirs) {
  const out = [];
  for (const [i, dir] of dirs.entries()) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch (e) { continue; }
    for (const f of files) {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r/g, '');
      const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const meta = {};
      if (m) m[1].split('\n').forEach((l) => { const k = l.indexOf(':'); if (k > 0) meta[l.slice(0, k).trim()] = l.slice(k + 1).trim(); });
      const sites = String(meta.sites || '').split(/[\s,]+/).map((s) => s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase()).filter(Boolean);
      if (sites.length) out.push({ name: meta.name || f.replace(/\.md$/, ''), sites, body: (m ? m[2] : raw).trim(), learned: i > 0 });
    }
  }
  return out;
}

// the notes for any of these addresses (or bare host names), hand-written ones first
function forUrls(notes, urls) {
  const hosts = [...new Set((urls || []).map((u) => /^https?:\/\//i.test(u) ? hostOf(u) : String(u).toLowerCase()).filter(Boolean))];
  return notes.filter((n) => hosts.some((h) => n.sites.some((d) => covers(d, h)))).sort((a, b) => a.learned - b.learned);
}

// one note as the model reads it
const show = (n) => (n.learned ? '### ' + n.sites[0] + ' (tips from earlier runs, unchecked: may be wrong)\n' : '### ' + n.name + ' (' + n.sites.join(', ') + ')\n') + n.body;

/* keep a tip about a site the run actually visited. Tips are short facts about the site, never about
   him (his details stay in his profile): anything with an email, phone or long number is dropped. */
function learn(dir, host, tip, today) {
  host = String(host || '').toLowerCase().replace(/^www\./, '');
  tip = String(tip || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || tip.length < 12) return false;
  if (/@|\d{3}[\s.-]?\d{3,}|\b\d{6,}\b/.test(tip)) return false;
  const file = path.join(dir, host + '.md');
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').replace(/\r/g, '').split('\n').filter((l) => l.startsWith('- ')); } catch (e) {}
  const said = (l) => l.replace(/^- \(\d{4}-\d{2}-\d{2}\) /, '').toLowerCase();
  if (lines.some((l) => said(l) === tip.toLowerCase())) return false;
  lines = lines.concat('- (' + today + ') ' + tip).slice(-MAX_LEARNED);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '---\nname: ' + host + '\nsites: ' + host + '\n---\n' + lines.join('\n') + '\n');
  return true;
}

module.exports = { load, forUrls, show, learn, hostOf, covers };
