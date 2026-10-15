// Copies the desktop renderer (index.html, styles.css, js/) into www/ and bakes in the device-sync config
// so the phone app syncs out of the box. Re-run before every APK build.
const fs = require('fs');
const path = require('path');

const rendererDir = path.join(__dirname, '..', 'renderer');
const src = path.join(rendererDir, 'index.html');
const outDir = path.join(__dirname, 'www');
const syncCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'sync-config.json'), 'utf8'));

// optional third channel for Claude's Agent tab; added to an existing phone
// config too (the personal seed below only applies to a fresh install)
const agentFile = path.join(__dirname, 'agent-sync-config.json');
const agentCfg = fs.existsSync(agentFile) ? JSON.parse(fs.readFileSync(agentFile, 'utf8')) : null;
// fourth channel for the School tab, merged in the same way
const schoolFile = path.join(__dirname, 'school-sync-config.json');
const schoolCfg = fs.existsSync(schoolFile) ? JSON.parse(fs.readFileSync(schoolFile, 'utf8')) : null;
const addChannel = (name, cfg) => cfg ? `try{ var c=JSON.parse(localStorage.getItem('tasks.sync.v1')); if(c&&c.url)c={personal:c}; if(c&&!c.${name}){ c.${name}=${JSON.stringify(cfg)}; localStorage.setItem('tasks.sync.v1',JSON.stringify(c)); } }catch(e){}` : '';

let html = fs.readFileSync(src, 'utf8');
const seed = `<script>
try{ if(!localStorage.getItem('tasks.sync.v1')) localStorage.setItem('tasks.sync.v1', ${JSON.stringify(JSON.stringify(syncCfg))}); }catch(e){}
${addChannel('agent', agentCfg)}
${addChannel('school', schoolCfg)}
</script>`;
// calendar accounts on the phone (window.phoneCal, read by the Settings → Calendars panel)
const calPhone = '<script>\n' + fs.readFileSync(path.join(__dirname, 'cal-phone.js'), 'utf8') + '</script>';
html = html.replace('<head>', () => '<head>\n' + seed + '\n' + calPhone);

fs.mkdirSync(outDir, { recursive: true });
// everything else in renderer/ (the stylesheet and the page's scripts) goes over as it is
fs.cpSync(rendererDir, outDir, { recursive: true, filter: (p) => path.resolve(p) !== path.resolve(src) });
fs.writeFileSync(path.join(outDir, 'index.html'), html);
console.log('www/index.html written with baked sync config (plus the rest of renderer/)');

// the home-screen widget reads the same config natively from res/raw
const rawDir = path.join(__dirname, 'android', 'app', 'src', 'main', 'res', 'raw');
if (fs.existsSync(path.join(__dirname, 'android'))) {
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, 'sync_config.json'), JSON.stringify(syncCfg));
  // the Today / Claude-needs-you / School widgets read these channels too
  fs.writeFileSync(path.join(rawDir, 'agent_sync_config.json'), JSON.stringify(agentCfg || {}));
  fs.writeFileSync(path.join(rawDir, 'school_sync_config.json'), JSON.stringify(schoolCfg || {}));
  console.log('res/raw/sync_config.json written for the widget');
  // the phone's own sign-in clients for calendar accounts (CalAccountsPlugin.java), from oauth-clients.json:
  // Google needs an Android-type client of its own; Microsoft is the desktop's Entra app with an Android platform added
  const oauthFile = path.join(__dirname, '..', 'oauth-clients.json');
  const oauth = fs.existsSync(oauthFile) ? JSON.parse(fs.readFileSync(oauthFile, 'utf8')) : {};
  const phoneClients = {
    google: { clientId: (oauth.googleAndroid && oauth.googleAndroid.clientId) || '' },
    microsoft: { clientId: (oauth.microsoft && oauth.microsoft.clientId) || '' }
  };
  fs.writeFileSync(path.join(rawDir, 'oauth_clients.json'), JSON.stringify(phoneClients));
  console.log('res/raw/oauth_clients.json written (Google: ' + (phoneClients.google.clientId ? 'set' : 'not set up') +
    ', Microsoft: ' + (phoneClients.microsoft.clientId ? 'set' : 'not set up') + ')');
}
