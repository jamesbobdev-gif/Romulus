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

/* About to ask him for what's on the class site ("I need the actual questions", "What exactly do you need?"):
   Holo4 did that four times without opening the class. The nudge sends it there first, once. visited: the
   hosts it reached this run. → the nudge, or null */
const ASKS_HIM = /\b(i need (more|the|you to (share|send|paste|give|provide|tell))|could you (please )?(share|provide|send|paste|give|tell)|can you (share|provide|send|paste)|what exactly|which (assignment|class|course|quiz|chapter)|more (details|info(rmation)?)( about)?)\b/i;
function lookFirst(note, { site, visited } = {}) {
  if (!ASKS_HIM.test(String(note || ''))) return null;
  const seen = [...(visited || [])];
  if (site ? seen.includes(site.host) : seen.some((h) => siteKind(h))) return null; // it did look
  return 'Before asking him: you haven\'t opened the class site in this run. ' +
    (site ? 'Open ' + site.kind + ' (https://' + site.host + '), go to the class, ' : 'Open the class on the site "Where each of his classes is" names, ') +
    'and find the assignment yourself: its page, its questions, the instructions and attached files. Ask him only for what really isn\'t there, and say where you looked.';
}

// a due date that has passed → what the model is told first (it spent whole runs on quizzes that had closed)
function pastDue(due, today) {
  if (!due || !today || due >= today) return null;
  const days = Math.round((new Date(today + 'T12:00') - new Date(due + 'T12:00')) / 864e5);
  return 'This was due ' + due + ' (' + days + ' day' + (days === 1 ? '' : 's') + ' ago). First check on its page whether it can still be done or submitted late. If it is closed, stop and say so right away (status "needs-you"), without doing the work.';
}

module.exports = { siteKind, courseSites, show, relevant, lookFirst, pastDue };
