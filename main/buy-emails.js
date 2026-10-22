/* "Buy this" emails.
   When the user chooses one of Claude's product options, the renderer stamps the
   task with `buyEmail` {label,url,price,rating,image,at}. Here we hand that to
   the `buy-email` Supabase edge function, which sends it through Resend (from a
   neutral address, to the user's inbox). No Google/Gmail permission is involved,
   and the Resend key lives only on the server. It emails the link; never buys.
   Dedup is by task+url+click-time, remembered in config.buyEmailsSent, so a
   given choice is emailed exactly once even across restarts and re-saves. */
let ctx = null; // { readConfig, writeConfig, agentLog }
function init(c) { ctx = c; }
const readConfig = () => ctx.readConfig();
const writeConfig = (c) => ctx.writeConfig(c);
const agentLog = (m) => ctx.agentLog(m);
// where to send it and the function's address (with its secret token) live in config.json
// (buyEmailTo, buyEmailUrl), not in the code
const buyFailed = new Set(); // keys that failed this session (don't retry every save until restart)
const buySending = new Set(); // keys being sent right now (a second save meanwhile must not send it again)

async function processBuyEmails(raw) {
  let saved; try { saved = JSON.parse(raw); } catch (e) { return; }
  const tasks = Array.isArray(saved.tasks) ? saved.tasks : [];
  const pending = tasks.filter((t) => t && t.ws === 'agent' && t.buyEmail && t.buyEmail.url);
  if (!pending.length) return;
  const cfg = readConfig();
  const to = cfg.buyEmailTo, fnUrl = cfg.buyEmailUrl;
  if (!to || !fnUrl) return; // not set up on this computer
  const sent = new Set(Array.isArray(cfg.buyEmailsSent) ? cfg.buyEmailsSent : []);
  let changed = false;
  for (const t of pending) {
    const b = t.buyEmail;
    const key = t.id + '|' + (b.url || '') + '|' + (b.at || '');
    if (sent.has(key) || buyFailed.has(key) || buySending.has(key)) continue;
    buySending.add(key);
    try {
      const res = await fetch(fnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, kind: b.kind === 'print' || b.kind === 'link' ? b.kind : 'buy', label: b.label, url: b.url, price: b.price, rating: b.rating, image: b.image }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
      sent.add(key); changed = true;
      agentLog('buy email sent: ' + b.label);
    } catch (e) {
      buyFailed.add(key);
      agentLog('buy email failed: ' + e.message);
    } finally { buySending.delete(key); }
  }
  if (changed) { // re-read: other settings may have been saved while the emails went out
    const fresh = readConfig();
    fresh.buyEmailsSent = Array.from(new Set([...(Array.isArray(fresh.buyEmailsSent) ? fresh.buyEmailsSent : []), ...sent])).slice(-500);
    writeConfig(fresh);
  }
}


module.exports = { init, processBuyEmails };
