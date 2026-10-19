/* Where he is right now, for "near me" tasks (movies): Windows location services, the same fix the Maps
   app uses. Rounded to about 100 m and kept for 30 minutes; null when location is off or this isn't Windows. */
const { execFile } = require('child_process');

const PS = "Add-Type -AssemblyName System.Device; $w = New-Object System.Device.Location.GeoCoordinateWatcher; $w.Start(); " +
  "$i = 0; while (($w.Status -ne 'Ready') -and ($w.Permission -ne 'Denied') -and $i -lt 40) { Start-Sleep -Milliseconds 250; $i++ }; " +
  "$c = $w.Position.Location; if (-not $c.IsUnknown) { '{0} {1} {2}' -f $c.Latitude, $c.Longitude, $c.HorizontalAccuracy }; $w.Stop()";

let cached = null, cachedAt = 0;
function hereNow() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (cached && Date.now() - cachedAt < 30 * 60 * 1000) return Promise.resolve(cached);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { windowsHide: true, timeout: 20000 }, (err, out) => {
      const [lat, lng, acc] = String(out || '').trim().replace(/,/g, '.').split(/\s+/).map(Number);
      if (err || !isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return resolve(cached);
      cached = { lat: Math.round(lat * 1000) / 1000, lng: Math.round(lng * 1000) / 1000, accuracyM: Math.round(acc) || undefined };
      cachedAt = Date.now();
      resolve(cached);
    });
  });
}

// miles between two {lat, lng}
function miles(a, b) {
  const r = (d) => d * Math.PI / 180, R = 3958.8;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* A street address → {lat, lng}, from OpenStreetMap's geocoder (one at a time: its usage policy allows
   one request a second). Only theater addresses go out, never where he is. */
const geoCache = new Map();
let lastGeo = 0;
async function geocode(address) {
  const q = String(address || '').replace(/\s+/g, ' ').trim();
  if (!q) return null;
  if (geoCache.has(q)) return geoCache.get(q);
  const hit = await lookup(q) || await (async () => {
    // "Cinemark Springfield, 100 Main St, …": the geocoder wants the street address alone
    const parts = q.split(/,\s*/), i = parts.findIndex((p) => /^\d/.test(p));
    return i > 0 ? lookup(parts.slice(i).join(', ')) : null;
  })();
  geoCache.set(q, hit);
  return hit;
}
async function lookup(q) {
  const wait = lastGeo + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeo = Date.now();
  let hit = null;
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q), {
      headers: { 'User-Agent': 'TasksApp/1.0 (personal task app)' }, signal: AbortSignal.timeout(10000) });
    const j = r.ok ? await r.json() : [];
    if (Array.isArray(j) && j[0] && isFinite(+j[0].lat) && isFinite(+j[0].lon)) hit = { lat: +j[0].lat, lng: +j[0].lon };
  } catch (e) {}
  return hit;
}

module.exports = { hereNow, miles, geocode };
