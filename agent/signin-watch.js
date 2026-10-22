/* Signed out on the local model: his school sites (Blackboard, D2L) sign him out every so often (the school's
   Microsoft sign-in runs out), and the next task there failed at the last minute (Ch 8 Quiz, Oct 20). Now:
   - any local-model run that lands on a sign-in page puts a to-do on his Human list ("Sign in to Blackboard on the local model…"),
     the same way an AI with an expired key does (agent:reconnect); one per site
   - a page of that site that isn't a sign-in page checks it off again (agent:reconnected)
   - once a day, dailyCheck() opens his school sites in a background tab on the mini PC to see where they land,
     so it's caught before a task needs them
   Pure functions + one daily check over the browser's debugging port; no Electron here. */
'use strict';
const fs = require('fs');
const path = require('path');

// the sites he signs in to on the mini PC, and a page of each that only shows when signed in
const SITES = [
  { match: /(^|\.)blackboard\.com$/, name: 'Blackboard', home: '/ultra/course' },
  { match: /(^|\.)d2llearn\.school\.edu$|^d2l\.|\.d2l\./, name: 'D2L', home: '/d2l/home' },
];
// sign-in services the school sites send him to
const LOGIN_HOSTS = /^(login\.microsoftonline\.com|login\.microsoft\.com|login\.live\.com|accounts\.google\.com|.*\.okta\.com|sso\.[^/]+|idp\.[^/]+|adfs\.[^/]+)$/;
const LOGIN_PATH = /\/(login|signin|sign-in|logon|sso|saml2?|auth)(\/|\?|$|\.)/i;
const LOGIN_TITLE = /^(sign in|log ?in|pick an account)\b|sign in to your account/i;

const hostOf = (url) => { try { return new URL(String(url)).hostname.toLowerCase(); } catch (e) { return ''; } };
const siteFor = (host) => SITES.find((s) => s.match.test(host)) || null;
function isLoginPage(url, title) {
  const host = hostOf(url);
  if (!host) return false;
  if (LOGIN_HOSTS.test(host)) return true;
  try { if (LOGIN_PATH.test(new URL(url).pathname)) return true; } catch (e) {}
  return LOGIN_TITLE.test(String(title || '').trim());
}
// the to-do's title; the renderer finds it again by everything up to the first ':'
const prefixFor = (site) => 'Sign in to ' + site.name + ' on the local model’s computer:';
const todoTitle = (site) => prefixFor(site) + ' it signed you out. On its own screen, open ' + site.name +
  ' in its browser, sign in and tick "Stay signed in", so its tasks there can run';

/* One run's pages, in order. `send` is sendToRenderer. A sign-in page counts for the school site it came
   from (Blackboard sends him to Microsoft's), or the site itself when it's that site's own login page. */
function tracker(send) {
  let lastSite = null;
  const flagged = new Set(), cleared = new Set();
  return {
    see(url, title) {
      const host = hostOf(url);
      if (!host) return null;
      const site = siteFor(host);
      if (isLoginPage(url, title)) {
        const s = site || lastSite;
        if (s && !flagged.has(s.name)) { flagged.add(s.name); send('agent:reconnect', { id: 'signin-' + s.name, title: todoTitle(s) }); }
        return s ? 'signed-out' : null;
      }
      if (site) {
        lastSite = site;
        if (!cleared.has(site.name) && !flagged.has(site.name)) { cleared.add(site.name); send('agent:reconnected', { id: 'signin-' + site.name, prefix: prefixFor(site) }); }
        return 'signed-in';
      }
      return null;
    },
    // where a page was sent from, without counting it as reached (it may never have loaded signed in)
    cameFrom(url) { lastSite = siteFor(hostOf(url)) || lastSite; },
    signedOut: () => [...flagged],
  };
}

// ---------- the daily check ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toLocaleDateString('en-CA');
function stateFile(userData) { return path.join(userData, 'signin-check.json'); }
function lastChecked(userData) { try { return JSON.parse(fs.readFileSync(stateFile(userData), 'utf8')).day || null; } catch (e) { return null; } }
// due once a day, from 7 am
const due = (userData, now = new Date()) => now.getHours() >= 7 && lastChecked(userData) !== now.toLocaleDateString('en-CA');

/* The sites to look at: his allowed sites (Settings → routing) that are school sites, opened at their
   signed-in-only page. `port` is the local end of the tunnel to the mini PC's browser. Returns
   [{ site, url, title, state }] and sends the to-dos. Opens one tab per site and closes it again. */
async function dailyCheck({ port, sites, send, userData, log = () => {}, pauseMs = 2500 }) {
  const base = 'http://127.0.0.1:' + port + '/json';
  const targets = [];
  for (const s of sites || []) {
    const host = hostOf(/^https?:\/\//i.test(s) ? s : 'https://' + String(s).replace(/^\*\./, ''));
    const site = siteFor(host);
    if (site && !targets.some((t) => t.site === site)) targets.push({ site, url: 'https://' + host + site.home });
  }
  const out = [];
  for (const t of targets) {
    let tab = null;
    try {
      tab = await fetch(base + '/new?' + encodeURI(t.url), { method: 'PUT', signal: AbortSignal.timeout(5000) }).then((r) => r.json());
      // a signed-out site goes through a redirect or two to the sign-in page
      let page = null;
      for (let i = 0; i < 8; i++) {
        await wait(pauseMs);
        const list = await fetch(base + '/list', { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
        page = list.find((p) => p.id === tab.id) || page;
        if (page && page.url !== 'about:blank' && i >= 3) break;
      }
      const tr = tracker(send);
      tr.cameFrom(t.url); // so a sign-in page counts for this site
      const state = page ? tr.see(page.url, page.title) : null;
      out.push({ site: t.site.name, url: page && page.url, title: page && page.title, state });
      log('sign-in check: ' + t.site.name + ' is ' + (state || 'unknown') + (page ? ' (' + hostOf(page.url) + ')' : ''));
    } catch (e) {
      log('sign-in check: ' + t.site.name + ' failed: ' + e.message);
    } finally {
      if (tab && tab.id) await fetch(base + '/close/' + tab.id, { method: 'PUT', signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
  }
  try { fs.writeFileSync(stateFile(userData), JSON.stringify({ day: today(), at: Date.now(), sites: out })); } catch (e) {}
  return out;
}

module.exports = { isLoginPage, siteFor, todoTitle, prefixFor, tracker, dailyCheck, due };
