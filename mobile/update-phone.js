/* Updates for the phone app. New versions come from the same public releases repository the desktop app
   uses (window.ROMULUS_RELEASES, set by prepare-www.js from package.json -> build.publish), where the
   release workflow puts a Romulus-<version>.apk next to the desktop installers.

   Android lets no app replace itself without the person's say-so, so this is a banner, not a silent
   install: it checks GitHub's "latest release" a few times a day, and when that is newer than the
   version baked into this build (window.ROMULUS_VERSION) it shows "Romulus 1.0.5 is out" with Update.
   Update hands the APK to the system browser, which downloads it; tapping the finished download installs
   it over this copy (the phone asks once to allow installs from the browser). Tasks and settings stay.
   "Later" hides the banner for that version until the next one. */
(function () {
  var cap = window.Capacitor;
  var version = window.ROMULUS_VERSION, releases = window.ROMULUS_RELEASES;
  var CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
  var LAST_KEY = 'tasks.update.lastCheck', SKIP_KEY = 'tasks.update.skip';

  // 1.0.10 is newer than 1.0.9; a 'v' in front is ignored
  function isNewer(candidate, current) {
    var a = String(candidate || '').replace(/^v/i, '').split('.').map(Number);
    var b = String(current || '').replace(/^v/i, '').split('.').map(Number);
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      var x = a[i] || 0, y = b[i] || 0;
      if (isNaN(x) || isNaN(y)) return false;
      if (x !== y) return x > y;
    }
    return false;
  }
  // the newest release on GitHub, or null: { version, apkUrl, page }
  function pickRelease(rel) {
    if (!rel || !rel.tag_name) return null;
    var apk = (rel.assets || []).filter(function (a) { return /\.apk$/i.test(a.name || ''); })[0];
    return { version: String(rel.tag_name).replace(/^v/i, ''), apkUrl: apk ? apk.browser_download_url : null, page: rel.html_url };
  }
  window.phoneUpdate = { isNewer: isNewer, pickRelease: pickRelease };

  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform() || !version || !releases) return;
  // only the APK from the releases page updates itself; a store build is updated by its store (store.js)
  if (window.ROMULUS_STORE !== 'github') return;

  var banner = null;
  function show(rel) {
    if (banner) return;
    try { if (localStorage.getItem(SKIP_KEY) === rel.version) return; } catch (e) {}
    banner = document.createElement('div');
    banner.id = 'phoneUpdateBar';
    banner.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:9999;' +
      'display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:var(--surface,#222);' +
      'color:var(--fg,#eee);border:1px solid var(--border,#444);box-shadow:0 6px 24px rgba(0,0,0,.35);font-size:14px';
    var text = document.createElement('span');
    text.style.flex = '1';
    text.textContent = 'Romulus ' + rel.version + ' is out';
    var later = document.createElement('button');
    later.className = 'ghost mono';
    later.textContent = 'Later';
    later.onclick = function () { try { localStorage.setItem(SKIP_KEY, rel.version); } catch (e) {} banner.remove(); banner = null; };
    var go = document.createElement('button');
    go.className = 'btn-accent';
    go.textContent = 'Update';
    // Capacitor hands off-site URLs to the system browser, which downloads the APK; tapping it installs
    go.onclick = function () { window.location.href = rel.apkUrl || rel.page; };
    banner.appendChild(text); banner.appendChild(later); banner.appendChild(go);
    document.body.appendChild(banner);
  }

  function check() {
    var last = 0; try { last = Number(localStorage.getItem(LAST_KEY)) || 0; } catch (e) {}
    if (Date.now() - last < CHECK_EVERY_MS) return;
    try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch (e) {}
    fetch('https://api.github.com/repos/' + releases + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) { var rel = pickRelease(json); if (rel && isNewer(rel.version, version)) show(rel); })
      .catch(function () {}); // offline: next time
  }

  var start = function () { setTimeout(check, 15 * 1000); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') check(); });
})();
