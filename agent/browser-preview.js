// Preview pictures through Claude's browser (the agent browser: real Chrome, which gets through the bot
// checks that block the app's own hidden window, e.g. MakerWorld). Each page opens in a background tab,
// we read its og:image / twitter:image, and the tab is closed again. Run with the system's Node (it has
// WebSocket; Electron's built-in Node doesn't); main.js copies this file next to the browser tool.
// Usage: node browser-preview.js <port> <url>...   → prints {"<url>": "<image url>" | null, …}
const [port, ...urls] = process.argv.slice(2);

async function main() {
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('cannot connect')); });
  let id = 0;
  const pending = {};
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; } };
  const send = (method, params = {}, sessionId) => new Promise((resolve) => {
    const n = ++id; pending[n] = resolve;
    ws.send(JSON.stringify({ id: n, method, params, sessionId }));
    setTimeout(() => { if (pending[n]) { delete pending[n]; resolve({}); } }, 10000);
  });
  const READ = `(()=>{const m=s=>{const e=document.querySelector(s);return e&&e.content};return m('meta[property="og:image"]')||m('meta[name="og:image"]')||m('meta[property="og:image:url"]')||m('meta[name="twitter:image"]')||m('meta[property="twitter:image"]')||''})()`;
  async function one(url) {
    let targetId = null;
    try {
      targetId = ((await send('Target.createTarget', { url, background: true })).result || {}).targetId;
      if (!targetId) return null;
      const sessionId = ((await send('Target.attachToTarget', { targetId, flatten: true })).result || {}).sessionId;
      const end = Date.now() + 20000; // a bot check takes a few seconds to wave the page through
      while (Date.now() < end) {
        const r = await send('Runtime.evaluate', { expression: READ, returnByValue: true }, sessionId);
        const v = r.result && r.result.result && r.result.result.value;
        if (v) { const abs = new URL(v, url).href; return /^https:\/\//i.test(abs) ? abs : null; }
        await new Promise((res) => setTimeout(res, 700));
      }
      return null;
    } catch (e) { return null; } finally {
      if (targetId) await send('Target.closeTarget', { targetId });
    }
  }
  const out = {};
  for (let i = 0; i < urls.length; i += 4) { // at most 4 tabs at once
    const batch = urls.slice(i, i + 4);
    (await Promise.all(batch.map(one))).forEach((img, k) => { out[batch[k]] = img; });
  }
  ws.close();
  return out;
}
main().then((out) => { process.stdout.write(JSON.stringify(out)); process.exit(0); })
  .catch(() => { process.stdout.write('{}'); process.exit(0); });
