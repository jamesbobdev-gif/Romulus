/* Course calendar feeds: the private iCal links Blackboard (Calendar → settings → Share Calendar) and
   D2L/Brightspace (Calendar → Subscribe) give out. Read straight from the school, no login or browser
   needed, and turned into due items for the School list. The links work like a password: they live in
   this computer's config only and are never synced or shown to a model. */

// one .ics file → [{uid, title, course, due:'YYYY-MM-DD', dueTime:'HH:MM'|null, notes, url}]
function parse(text, now = new Date()) {
  // unfold continuation lines (RFC 5545: a line starting with a space or tab continues the previous one)
  const lines = String(text || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const out = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = {}; continue; }
    if (line === 'END:VEVENT') { if (ev) { const e = toItem(ev, now); if (e) out.push(e); } ev = null; continue; }
    if (!ev) continue;
    const m = line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/);
    if (m && !(m[1] in ev)) ev[m[1]] = { params: m[2], value: m[3] };
  }
  return out;
}

const unescape = (s) => String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();
const pad = (n) => String(n).padStart(2, '0');

// DTEND/DTSTART → local {due, dueTime}; UTC times ("…Z") are shown in this computer's time zone
function when(p) {
  if (!p) return null;
  const v = p.value.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || /VALUE=DATE(?!-)/.test(p.params)) { m = m || v.match(/^(\d{4})(\d{2})(\d{2})/); return m && { due: m[1] + '-' + m[2] + '-' + m[3], dueTime: null, at: new Date(+m[1], m[2] - 1, +m[3], 23, 59) }; }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  // a zoned time (TZID=America/New_York) is taken as local: his schools are in his own time zone
  const d = m[7] ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return { due: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), dueTime: pad(d.getHours()) + ':' + pad(d.getMinutes()), at: d };
}

// "1170-UNIV-BIO101-2411: Fall 26 (1) BIO 101 Intro to Biology" → "BIO 101"
function courseCode(s) {
  const m = String(s || '').match(/\b([A-Z]{2,5})[ -]?(\d{3,4}[A-Z]?)\b/g);
  if (!m) return String(s || '').trim().slice(0, 40) || null;
  return m[m.length - 1].replace(/^([A-Z]+)[ -]?/, '$1 ');
}

function toItem(ev, now) {
  const uid = ev.UID && ev.UID.value.trim();
  let title = unescape(ev.SUMMARY && ev.SUMMARY.value);
  if (!uid || !title) return null;
  // a due item is a moment, so its end is the deadline (Blackboard puts the same time in both)
  const t = when(ev.DTEND) || when(ev.DTSTART);
  if (!t || t.at < new Date(now.getTime() - 2 * 864e5)) return null; // already past: nothing to do
  let course = unescape((ev.LOCATION && ev.LOCATION.value) || (ev.CATEGORIES && ev.CATEGORIES.value) || '');
  // "BIO 101: Chapter 19" / "[BIO 101] Chapter 19" / "HIS 210 - Sec 510 - Deliverable" carry the course in the title
  const pre = title.match(/^\[([^\]]+)\]\s*(.+)$/) || title.match(/^([A-Z]{2,5}[ -]?\d{3,4}[A-Z]?[^:]*):\s*(.+)$/) ||
    title.match(/^([A-Z]{2,5}[ -]?\d{3,4}[A-Z]?)\s+-\s+(.+)$/);
  if (pre) { course = course || pre[1]; title = pre[2]; }
  // D2L sends an item up to three times: "… - Due", "… - Availability Ends", and "… - Available" when it opens
  const ph = title.match(/\s+-\s+(Due|Availability Ends|Ends|Available)$/i);
  const phase = ph ? (/^due$/i.test(ph[1]) ? 'due' : /^available$/i.test(ph[1]) ? 'available' : 'ends') : null;
  if (ph) title = title.slice(0, ph.index);
  title = cleanTitle(title);
  const notes = unescape(ev.DESCRIPTION && ev.DESCRIPTION.value).replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').slice(0, 2000);
  return { uid, title: title.slice(0, 200), course: course ? courseCode(course) : null, courseName: courseName(course),
    due: t.due, dueTime: t.dueTime, phase, notes: notes || null, url: ev.URL ? ev.URL.value.trim() : null };
}

// "Proctoring Enabled: Quiz 2" → "Quiz 2"; "Sec 510 - Research Deliverable #1 - Assignment" → "Research Deliverable #1"
function cleanTitle(s) {
  return String(s || '').replace(/^Proctoring Enabled:\s*/i, '').replace(/^\s*[-–:]\s*/, '')
    .replace(/^Sec(?:tion)?\.?\s*\d+\s*[-–:]\s*/i, '').replace(/(.{3,})\s+[-–]\s+Assignment$/i, '$1').trim();
}

// "PHYS-1010-(83263)-Astronomy-Fall 2026" → "Astronomy": the course's name, so a task tagged by name finds its code
function courseName(s) {
  s = String(s || '').trim();
  if (!/\b[A-Z]{2,5}[ -]?\d{3,4}[A-Z]?\b/.test(s)) return null;
  const n = s.replace(/\b[A-Z]{2,5}[ -]?\d{3,4}[A-Z]?\b/g, ' ').replace(/\([^)]*\)/g, ' ')
    .replace(/\b(fall|spring|summer|winter)\s*\d{2,4}\b/gi, ' ').replace(/\b\d{2,}\b/g, ' ').replace(/[-_:|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return n && n.length <= 60 ? n : null;
}

// exam / project / regular, the School list's types (they decide when it joins the Human list)
function kindOf(title) {
  // "Exam Reflection", "Test Review", "Exam Corrections" are ordinary assignments about an exam
  if (/\b(exam|midterm|final|test)\b/i.test(title) && !/\b(reflection|review|wrapper|corrections?|prep|practice|sign[- ]?up)\b/i.test(title)) return 'exam';
  if (/\b(project|paper|essay|deliverable|presentation|research)\b/i.test(title)) return 'project';
  return 'regular';
}

// a stable task id per feed item, so re-imports update the same task instead of adding copies
function taskId(uid) {
  return 'ics-' + require('crypto').createHash('sha1').update(uid).digest('hex').slice(0, 20);
}

// webcal:// is how schools often hand these out; it's the same address over https
function normalUrl(u) {
  const s = String(u || '').trim().replace(/^webcals?:\/\//i, 'https://');
  try { const x = new URL(s); return x.protocol === 'https:' ? x.href : null; } catch (e) { return null; }
}

async function fetchAll(urls) {
  const items = [], errors = [], dropped = [];
  for (const raw of urls) {
    const u = normalUrl(raw);
    if (!u) { errors.push(String(raw).slice(0, 40) + '…: not an https link'); continue; }
    const host = new URL(u).hostname;
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(20000), headers: { Accept: 'text/calendar' } });
      const text = await r.text();
      if (!r.ok || !/BEGIN:VCALENDAR/.test(text)) { errors.push(host + ': ' + (r.ok ? 'not a calendar' : 'HTTP ' + r.status)); continue; }
      const evs = parse(text).map((e) => Object.assign(e, { id: taskId(host + '|' + e.uid), kind: kindOf(e.title), source: host }));
      // one task per assignment: its "Due" entry, else its "Availability Ends"; "Available" (it opens) never is one
      const hasDue = new Set(evs.filter((e) => e.phase === 'due').map((e) => e.course + '|' + e.title));
      for (const e of evs) {
        if (e.phase === 'available' || (e.phase === 'ends' && hasDue.has(e.course + '|' + e.title))) dropped.push(e.id);
        else items.push(e);
      }
    } catch (e) { errors.push(host + ': ' + (e.name === 'TimeoutError' ? 'timed out' : e.message)); }
  }
  return { items, errors, dropped };
}

module.exports = { parse, fetchAll, normalUrl, courseCode, courseName, cleanTitle, kindOf, taskId };
