/* Option cards: a picture for each link Claude or the mini PC suggests, and Amazon links checked
   against the real product page (price, rating, photo) so a made-up link never reaches James. */
const path = require('path');
const fs = require('fs');
const { AGENT_BROWSER_PORT, agentBrowserDir, findNode, ensureAgentBrowser } = require('./agent-browser');
const { QWEN_BROWSER_LOCAL_PORT, ensureQwenBrowser } = require('./qwen-browser');

let ctx = null; // { readConfig, agentLog, newHiddenWindow }
function init(c) { ctx = c; }
const readConfig = () => ctx.readConfig();
const agentLog = (m) => ctx.agentLog(m);

// The preview picture a page publishes for link previews (og:image / twitter:image) — works for
// most sites (3D-print sites, stores, booking pages…). Plain fetch first; sites behind a bot
// check (Printables, Makerworld) get loaded in a hidden browser window, which passes it.
const PREVIEW_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
function absHttps(img, pageUrl) {
  try { const u = new URL(String(img).replace(/&amp;/g, '&'), pageUrl).href; return /^https:\/\//i.test(u) ? u : null; } catch (e) { return null; }
}
async function pagePreviewImage(url, lane) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': PREVIEW_UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' }, signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const h = (await r.text()).slice(0, 600000);
      const meta = (p) => (h.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']+)["']`, 'i'))
        || h.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${p}["']`, 'i')) || [])[1];
      const img = meta('og:image') || meta('og:image:url') || meta('twitter:image') || meta('twitter:image:src');
      if (img) return absHttps(img, url);
    }
  } catch (e) {}
  // blocked (bot check, e.g. MakerWorld): Claude's browser is a real Chrome and gets through; the app's
  // own hidden window is the last resort
  // (for the mini PC's answers, through its own browser there: nothing opens on this computer)
  return (await agentBrowserPreview(url, lane)) || (lane === 'local' ? null : hiddenWindowPreview(url));
}
let previewWindows = 0;
async function hiddenWindowPreview(url) {
  while (previewWindows >= 3) await new Promise((r) => setTimeout(r, 300)); // at most 3 hidden pages at once
  previewWindows++;
  const w = ctx.newHiddenWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true } });
  w.webContents.setAudioMuted(true);
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await Promise.race([w.loadURL(url, { userAgent: PREVIEW_UA }).catch(() => {}), new Promise((r) => setTimeout(r, 15000))]);
    for (let i = 0; i < 16; i++) { // a bot check takes a few seconds to wave the page through
      const img = await w.webContents.executeJavaScript(
        `(()=>{const m=s=>{const e=document.querySelector(s);return e&&e.content};return m('meta[property="og:image"]')||m('meta[name="og:image"]')||m('meta[name="twitter:image"]')||m('meta[property="twitter:image"]')||''})()`).catch(() => '');
      if (img) return absHttps(img, url);
      await new Promise((r) => setTimeout(r, 750));
    }
    return null;
  } finally { if (!w.isDestroyed()) w.destroy(); previewWindows--; }
}
// Check an Amazon link is a real product page and pull its photo/price/rating.
// Links that don't check out are dropped, so Claude can't hand James a made-up one.
async function enrichOption(o, lane) {
  const url = String(o.url || '');
  const base = { label: String(o.label || '').slice(0, 80), desc: String(o.desc || '').slice(0, 200) };
  const m = url.match(/^https:\/\/(?:www\.)?amazon\.com\/(?:.*\/)?dp\/([A-Z0-9]{10})/i);
  if (!m) {
    if (!/^https:\/\//i.test(url)) return null;
    const image = await pagePreviewImage(url, lane).catch(() => null);
    return Object.assign(base, { url }, image ? { image } : {});
  }
  const clean = 'https://www.amazon.com/dp/' + m[1];
  try {
    const r = await fetch(clean, { headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
    const h = await r.text();
    if (/validateCaptcha/.test(h)) return Object.assign(base, { url: clean }); // can't check right now; keep the link
    if (!r.ok || !/id="productTitle"/.test(h)) return null;                    // not a real product page
    // Amazon keeps the main photo in different spots depending on the page layout; .gif is a blank placeholder
    const img = [/data-old-hires="(https:[^"]+)"/, /"hiRes":"(https:[^"]+)"/, /data-a-dynamic-image="\{&quot;(https:[^&]+)&quot;/,
      /"large":"(https:[^"]+)"/, /property="og:image" content="(https:[^"]+)"/]
      .map((re) => (h.match(re) || [])[1]).find((u) => u && !/\.gif$/i.test(u));
    if (!img) return null; // no real product photo: usually a sketchy listing, and James wants to see what he's buying
    const price = (h.match(/<span class="a-offscreen">(\$[0-9.,]+)<\/span>/) || [])[1];
    const rating = (h.match(/([0-9.]+) out of 5 stars/) || [])[1];
    return Object.assign(base, { url: clean,
      image: img.replace(/\._[^/]*_\.(jpg|png)$/i, '._AC_SL500_.$1'),
      price: price || null, rating: rating ? rating + '★' : null });
  } catch (e) { return Object.assign(base, { url: clean }); }
}

// Preview pictures for option cards through Claude's browser, for sites whose bot check stops the plain
// fetch and the hidden window. Pages open in background tabs that are closed again; if the browser isn't
// running it's started minimized. Calls made within a moment of each other share one helper process.
const previewBatches = {};
function agentBrowserPreview(url, lane) {
  const k = lane === 'local' ? 'local' : 'claude';
  if (!previewBatches[k]) {
    const batch = previewBatches[k] = { urls: [] };
    batch.done = new Promise((resolve) => setTimeout(() => { delete previewBatches[k]; runBrowserPreview(batch.urls, k).then(resolve, () => resolve({})); }, 150));
  }
  previewBatches[k].urls.push(url);
  return previewBatches[k].done.then((found) => found[url] || null);
}
async function runBrowserPreview(urls, lane) {
  if ((readConfig().agentRunner || {}).browser === false) return {};
  const node = findNode();
  const local = lane === 'local'; // the mini PC's answers: its own browser (via the SSH tunnel), never one here
  if (!node || !(local ? await ensureQwenBrowser() : await ensureAgentBrowser())) return {};
  const script = path.join(agentBrowserDir(), 'browser-preview.js');
  const src = fs.readFileSync(path.join(__dirname, 'browser-preview.js'), 'utf8');
  try { if (fs.readFileSync(script, 'utf8') !== src) fs.writeFileSync(script, src); } catch (e) { fs.writeFileSync(script, src); }
  return new Promise((resolve) => {
    let out = '';
    const p = require('child_process').spawn(node, [script, String(local ? QWEN_BROWSER_LOCAL_PORT : AGENT_BROWSER_PORT), ...urls], { windowsHide: true });
    const killer = setTimeout(() => { try { p.kill(); } catch (e) {} }, 90 * 1000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(killer); resolve({}); });
    p.on('close', () => {
      clearTimeout(killer);
      let found = {}; try { found = JSON.parse(out); } catch (e) {}
      agentLog('pictures via ' + (local ? 'the mini PC\'s' : 'Claude\'s') + ' browser: ' + Object.values(found).filter(Boolean).length + ' of ' + urls.length);
      resolve(found);
    });
  });
}

module.exports = { init, PREVIEW_UA, absHttps, pagePreviewImage, enrichOption };
