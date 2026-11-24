/* Small helpers that agent/ and main/ files each used to write for themselves: the local date as
   "2026-11-16", a hostname from a link, escaping text for a RegExp or for HTML. One copy here so they
   all agree (the page has its own in renderer/js/util.js; the two are tested to give the same answers).
   No requires and no Electron, so anything can load it. */

const pad2 = (n) => String(n).padStart(2, '0');

// a Date or a time in ms → "YYYY-MM-DD" on this computer's clock (not UTC)
const dayKey = (d) => {
  const t = d instanceof Date ? d : new Date(d);
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
};

// a Date or a time in ms → "YYYY-MM"
const monthKey = (d) => { const t = d instanceof Date ? d : new Date(d); return t.getFullYear() + '-' + pad2(t.getMonth() + 1); };

// a link → its hostname, lowercase ("www." kept); '' when it isn't a link
const hostOf = (u) => { try { return new URL(String(u)).hostname.toLowerCase(); } catch (e) { return ''; } };

// a link or a bare domain → the site, lowercase, without "www."; '' when it isn't one
const siteOf = (u) => {
  const s = String(u);
  try { return new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; }
};

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

module.exports = { pad2, dayKey, monthKey, hostOf, siteOf, escapeRe, escapeHtml };
