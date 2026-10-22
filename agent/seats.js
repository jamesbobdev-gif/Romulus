/* A seat map it read off a ticket site (agent/skills/seats.md), drawn on the task by renderer/js/seat-map.js:
   {where, screen, picked: ["F7"], price, url, rows: [{row: "A", seats: "oox_xpp", first}]}
   seats = one character per spot, left to right as he faces the screen: o open, x taken, p its pick,
   a wheelchair/companion, _ an aisle or gap. Seats count up from `first` (1 if left out), skipping gaps. */
const txt = (x, n) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);

function cleanSeats(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.rows)) return undefined;
  const rows = s.rows.slice(0, 40).map((r) => {
    if (!r || typeof r !== 'object') return null;
    const seats = String(r.seats || '').toLowerCase().replace(/[^oxpa_]/g, '').replace(/^_+|_+$/g, '').slice(0, 60);
    if (!/[oxpa]/.test(seats)) return null;
    const row = { row: txt(r.row, 4), seats };
    const f = Math.round(Number(r.first)); if (f > 1 && f < 1000) row.first = f;
    return row;
  }).filter(Boolean);
  if (!rows.length) return undefined;
  const out = { screen: txt(s.screen, 20) || 'Screen', rows };
  if (txt(s.where, 120)) out.where = txt(s.where, 120);
  const picked = (Array.isArray(s.picked) ? s.picked : []).map((p) => txt(p, 12)).filter(Boolean).slice(0, 20);
  if (picked.length) out.picked = picked;
  if (txt(s.price, 40)) out.price = txt(s.price, 40);
  if (/^https:\/\//i.test(String(s.url || ''))) out.url = String(s.url).slice(0, 500);
  return out;
}

/* Showtimes it read off a ticket site, drawn on the task as day tabs and time buttons (seat-map.js):
   {movie, url, days: [{day: "Fri Oct 17", theaters: [{name, dist, url, times: [{at: "7:30 pm", fmt: "IMAX", url}]}]}]} */
const link = (u) => (/^https:\/\//i.test(String(u || '')) ? String(u).slice(0, 500) : undefined);
function cleanShowtimes(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.days)) return undefined;
  const days = s.days.slice(0, 10).map((d) => {
    if (!d || typeof d !== 'object' || !txt(d.day, 30) || !Array.isArray(d.theaters)) return null;
    const theaters = d.theaters.slice(0, 8).map((th) => {
      if (!th || typeof th !== 'object' || !txt(th.name, 80) || !Array.isArray(th.times)) return null;
      const times = th.times.slice(0, 20).map((x) => {
        const at = txt(x && typeof x === 'object' ? x.at : x, 12);
        if (!at) return null;
        const t = { at };
        if (x && typeof x === 'object') { if (txt(x.fmt, 24)) t.fmt = txt(x.fmt, 24); if (link(x.url)) t.url = link(x.url); }
        return t;
      }).filter(Boolean);
      if (!times.length) return null;
      const out = { name: txt(th.name, 80), times };
      if (txt(th.dist, 20)) out.dist = txt(th.dist, 20);
      if (link(th.url)) out.url = link(th.url);
      return out;
    }).filter(Boolean);
    return theaters.length ? { day: txt(d.day, 30), theaters } : null;
  }).filter(Boolean);
  if (!days.length) return undefined;
  const out = { days };
  if (txt(s.movie, 80)) out.movie = txt(s.movie, 80);
  if (link(s.url)) out.url = link(s.url);
  return out;
}

/* The theaters showing a movie on the days he's free, drawn on the task as a map with a pin each (seat-map.js):
   {movie, days: ["Sat Oct 17"], theaters: [{name, address, lat, lng, dist, days: ["Sat Oct 17"], url}]}
   `here` (where he is) is added by the runner, never taken from the AI. */
const coord = (x, lim) => { const n = Number(x); return isFinite(n) && Math.abs(n) <= lim && n !== 0 ? Math.round(n * 1e5) / 1e5 : undefined; };
function cleanTheaters(s) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.theaters)) return undefined;
  const theaters = s.theaters.slice(0, 10).map((th) => {
    if (!th || typeof th !== 'object' || !txt(th.name, 80)) return null;
    const out = { name: txt(th.name, 80) };
    if (txt(th.address, 160)) out.address = txt(th.address, 160);
    const lat = coord(th.lat, 90), lng = coord(th.lng, 180);
    if (lat !== undefined && lng !== undefined) { out.lat = lat; out.lng = lng; }
    if (txt(th.dist, 20)) out.dist = txt(th.dist, 20);
    const days = (Array.isArray(th.days) ? th.days : []).map((d) => txt(d, 30)).filter(Boolean).slice(0, 10);
    if (days.length) out.days = days;
    if (link(th.url)) out.url = link(th.url);
    return out;
  }).filter(Boolean);
  if (!theaters.length) return undefined;
  const out = { theaters };
  if (txt(s.movie, 80)) out.movie = txt(s.movie, 80);
  const days = (Array.isArray(s.days) ? s.days : []).map((d) => txt(d, 30)).filter(Boolean).slice(0, 10);
  if (days.length) out.days = days;
  return out;
}

/* Pins where OpenStreetMap puts each address (an AI's own coordinates are often off), his distance to each,
   and the list closest first. */
async function placeTheaters(s, here, { geocode, miles }) {
  for (const th of s.theaters) {
    const p = th.address ? await geocode(th.address) : null;
    if (p) { th.lat = Math.round(p.lat * 1e5) / 1e5; th.lng = Math.round(p.lng * 1e5) / 1e5; }
  }
  if (here) {
    s.here = { lat: here.lat, lng: here.lng };
    for (const th of s.theaters) if (th.lat !== undefined) th.dist = miles(here, th).toFixed(1) + ' mi';
    s.theaters.sort((a, b) => (a.lat === undefined) - (b.lat === undefined) || (parseFloat(a.dist) || 0) - (parseFloat(b.dist) || 0));
  }
  return s;
}

module.exports = { cleanSeats, cleanShowtimes, cleanTheaters, placeTheaters };
