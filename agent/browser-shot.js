// A screenshot of the tab the agent browser was working in, for a task that stopped and needs James:
// he sees what the browser saw (a login page, a popup, a locked screen…). Run with the system's Node
// (it has WebSocket; Electron's built-in Node doesn't); main.js copies this file next to the browser tool.
// Usage: node browser-shot.js <port>   → prints {"jpeg": "<base64>", "url": "<page address>"} or {}
const [port] = process.argv.slice(2);

async function main() {
  const base = `http://127.0.0.1:${port}`;
  // Chrome lists the most recently used tab first; skip its own pages (new tab, settings…)
  const list = await (await fetch(base + '/json/list', { signal: AbortSignal.timeout(3000) })).json();
  const tab = list.find((t) => t.type === 'page' && /^https?:/i.test(t.url || '')) || list.find((t) => t.type === 'page');
  if (!tab || !tab.webSocketDebuggerUrl) return {};
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('cannot connect')); });
  let id = 0;
  const pending = {};
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; } };
  const send = (method, params = {}) => new Promise((resolve) => {
    const n = ++id; pending[n] = resolve;
    ws.send(JSON.stringify({ id: n, method, params }));
    setTimeout(() => { if (pending[n]) { delete pending[n]; resolve({}); } }, 15000); // a locked screen may never paint
  });
  const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
  ws.close();
  const data = r.result && r.result.data;
  return data ? { jpeg: data, url: tab.url || '' } : {};
}
main().then((out) => { process.stdout.write(JSON.stringify(out)); process.exit(0); })
  .catch(() => { process.stdout.write('{}'); process.exit(0); });
