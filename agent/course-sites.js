/* Which school site each of his classes is on. He takes classes at two schools, one on Blackboard and one
   on D2L, and the local model used to guess, so it went looking for a D2L class on Blackboard. The School
   list already knows: a calendar item remembers the feed it came from (t.site, renderer/js/wiring.js), and
   D2L items carry their link. Each class goes to the site most of its items came from, and the model is
   told plainly where each one is. No Electron here, so it can be tested on its own. */

// a site's address → 'Blackboard' | 'D2L' | null
function siteKind(host) {
  const h = String(host || '').toLowerCase();
  if (/blackboard/.test(h)) return 'Blackboard';
  if (/d2l|brightspace|desire2learn/.test(h)) return 'D2L';
  return null;
}
const hostOf = (s) => { const m = String(s || '').match(/https?:\/\/([^/\s"'<>)]+)/i); return m ? m[1].toLowerCase() : null; };

// School tasks → [{course, kind, host}], one per class whose site is known, sorted by course
function courseSites(tasks) {
  const votes = {}; // course → host → count
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || t.ws !== 'school' || !t.tag) continue;
    const host = (t.site && siteKind(t.site) ? String(t.site).toLowerCase() : null) || (siteKind(hostOf(t.notes)) ? hostOf(t.notes) : null);
    if (!host) continue;
    const v = votes[t.tag] = votes[t.tag] || {};
    v[host] = (v[host] || 0) + 1;
  }
  return Object.keys(votes).sort().map((course) => {
    const host = Object.keys(votes[course]).sort((a, b) => votes[course][b] - votes[course][a])[0];
    return { course, kind: siteKind(host), host };
  });
}

// the model's section: the classes on each site, with the site's address
function show(list) {
  if (!list || !list.length) return '';
  const bySite = {};
  for (const c of list) (bySite[c.host] = bySite[c.host] || { kind: c.kind, courses: [] }).courses.push(c.course);
  return '\n\n## Where each of his classes is\n' +
    'He takes classes at more than one school. Each class is on exactly one site: go straight to that one, ' +
    'and never look for a class on the other site.\n' +
    Object.keys(bySite).map((h) => '- ' + bySite[h].kind + ' (https://' + h + '): ' + bySite[h].courses.join(', ')).join('\n');
}

// is the task about school? (coach tasks always are) Then the section comes with it
const SCHOOLISH = /\b(blackboard|d2l|brightspace|course|class(es)?|syllabus|quiz|homework|assignment|exam|midterm|final|discussion|module|lecture|professor|instructor|grade)\b/i;
function relevant(t, list, { coaching } = {}) {
  if (!list || !list.length) return false;
  if (coaching) return true;
  const text = [t && t.title, t && t.notes, t && t.tag, t && t.reply].filter(Boolean).join('\n');
  if (SCHOOLISH.test(text)) return true;
  const squash = text.toUpperCase().replace(/[\s-]+/g, '');
  return list.some((c) => squash.includes(c.course.toUpperCase().replace(/[\s-]+/g, '')));
}

module.exports = { siteKind, courseSites, show, relevant };
