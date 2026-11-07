/* Updates for the phone app. New versions come from the same public releases repository the desktop app
   uses (window.ROMULUS_RELEASES, set by prepare-www.js from package.json -> build.publish), where the
   release workflow puts a Romulus-<version>.apk next to the desktop installers.

   Android lets no app replace itself without the person's say-so, so this is a banner, not a silent
   install: it checks GitHub's "latest release" a few times a day, and when that is newer than the
   version baked into this build (window.ROMULUS_VERSION) it shows "Romulus 1.0.5 is out" with Update.
   Update hands the APK to the system browser, which downloads it; tapping the finished download installs
   it over this copy (the phone asks once to allow installs from the browser). Tasks and settings stay.
   "Later" hides the banner for that version until the next one. A check that fails (offline, or GitHub's hourly
   limit for the carrier's shared address) is tried again in five minutes, not six hours, and Settings → Updates
   says which version this phone runs with a Check for updates that looks right now, past any Later or Not now.
   The answer is shared with his other devices (renderer/js/update-sync.js): Update here makes the computers
   update too, and an Update said on a computer shows this banner even after a Later here (Android still
   needs his tap to install). A Not now said elsewhere keeps the banner away. */
(function () {
  var cap = window.Capacitor;
  var version = window.ROMULUS_VERSION, releases = window.ROMULUS_RELEASES;
  var CHECK_EVERY_MS = 6 * 60 * 60 * 1000, RETRY_MS = 5 * 60 * 1000;
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
  // the "last check" to remember after one: now when it answered; five minutes short of the next check when it failed
  function lastCheckAfter(ok, now) { return ok ? now : now - CHECK_EVERY_MS + RETRY_MS; }
  window.phoneUpdate = { isNewer: isNewer, pickRelease: pickRelease, lastCheckAfter: lastCheckAfter };

  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform() || !version || !releases) return;
  var store = window.ROMULUS_STORE;
  function whenReady(fn) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); }

  // Settings → Updates on the phone: which version this is, and (the APK build) a Check for updates
  function settings() {
    if (typeof document.getElementById !== 'function') return;
    var sec = document.getElementById('updateSection'), hint = document.getElementById('updateHint'), sel = document.getElementById('updateMode');
    var btn = document.getElementById('updateCheck'), status = document.getElementById('updateStatus');
    if (!sec || !hint || !btn || !status) return;
    sec.hidden = false; if (sel) sel.hidden = true;
    hint.textContent = 'This phone runs Romulus ' + version + '. ' + (store === 'github'
      ? 'A new version shows a banner within a few hours; Update downloads it and the phone asks once to install it.'
      : 'New versions come through ' + (store === 'play' ? 'Google Play' : store === 'appstore' ? 'the App Store' : 'its store') + '.');
    if (store !== 'github') return;
    btn.hidden = false;
    btn.onclick = function () {
      status.textContent = 'Looking…'; btn.disabled = true;
      fetchLatest().then(function (rel) {
        try { localStorage.setItem(LAST_KEY, String(lastCheckAfter(true, Date.now()))); } catch (e) {}
        if (isNewer(rel.version, version)) { status.textContent = 'Romulus ' + rel.version + ' is out.'; show(rel, null, true); }
        else status.textContent = 'Up to date.';
      }).catch(function () { status.textContent = 'Couldn’t reach GitHub. Try again in a minute.'; })
        .then(function () { btn.disabled = false; });
    };
  }
  whenReady(settings);
  // only the APK from the releases page updates itself; a store build is updated by its store (store.js)
  if (store !== 'github') return;

  var banner = null;
  // what he answered on his other devices: 'yes' | 'no' | null (update-sync.js, loaded with the page)
  function sharedAnswer(version) {
    if (typeof updateChoiceRead !== 'function') return Promise.resolve(null);
    return updateChoiceRead().then(function (doc) { return updateAnswer(doc, version); }).catch(function () { return null; });
  }
  function share(answer, version) { if (typeof updateChoiceWrite === 'function') updateChoiceWrite(answer, version); }

  // force: he pressed Check for updates, so a Later here or a Not now elsewhere doesn't keep it away
  function show(rel, answer, force) {
    if (banner || (answer === 'no' && !force)) return;
    try { if (!force && answer !== 'yes' && localStorage.getItem(SKIP_KEY) === rel.version) return; } catch (e) {}
    banner = document.createElement('div');
    banner.id = 'phoneUpdateBar';
    banner.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:9999;' +
      'display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:var(--surface,#222);' +
      'color:var(--fg,#eee);border:1px solid var(--border,#444);box-shadow:0 6px 24px rgba(0,0,0,.35);font-size:14px';
    var text = document.createElement('span');
    text.style.flex = '1';
    text.textContent = 'Romulus ' + rel.version + (answer === 'yes' ? ' is out: your other devices are updating' : ' is out');
    var later = document.createElement('button');
    later.className = 'ghost mono';
    later.textContent = 'Later';
    later.onclick = function () { try { localStorage.setItem(SKIP_KEY, rel.version); } catch (e) {} share('no', rel.version); banner.remove(); banner = null; };
    var go = document.createElement('button');
    go.className = 'btn-accent';
    go.textContent = 'Update';
    // Capacitor hands off-site URLs to the system browser, which downloads the APK; tapping it installs
    go.onclick = function () { share('yes', rel.version); window.location.href = rel.apkUrl || rel.page; };
    banner.appendChild(text); banner.appendChild(later); banner.appendChild(go);
    document.body.appendChild(banner);
  }

  // the newest release on GitHub; rejects when it can't be had (offline, rate-limited, or no release yet)
  function fetchLatest() {
    return fetch('https://api.github.com/repos/' + releases + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (json) { var rel = pickRelease(json); if (!rel) throw new Error('no release'); return rel; });
  }
  function check() {
    var last = 0; try { last = Number(localStorage.getItem(LAST_KEY)) || 0; } catch (e) {}
    if (Date.now() - last < CHECK_EVERY_MS) return;
    try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch (e) {}
    fetchLatest()
      .then(function (rel) { if (isNewer(rel.version, version)) sharedAnswer(rel.version).then(function (answer) { show(rel, answer); }); })
      .catch(function () { try { localStorage.setItem(LAST_KEY, String(lastCheckAfter(false, Date.now()))); } catch (e) {} }); // again in five minutes
  }

  whenReady(function () { setTimeout(check, 15 * 1000); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') check(); });
})();
