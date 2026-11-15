/* Standing jobs: once a calendar or a mailbox is connected and the Agent list is still empty, the app queues one
   setup task, "Suggest jobs from my calendar and inbox". That run looks at the next two weeks on his calendar
   and the last week of his inbox (an inbox run: the app's mail tools, no web) and proposes two to four jobs the
   Agent could do for him on a schedule, each with its own Start button in the conversation. Start makes an
   ordinary Agent task with a repeat (t.repeat, agent-chat.js) and queues its first run; the setup run does
   none of the jobs itself, and nothing starts without his tap. Like a goal's plan (agent/goals.js): the run
   answers with `jobs` and status needs-you. Pure functions; no Electron, so it can be tested on its own. */

const TITLE = 'Suggest jobs from my calendar and inbox';
const MIN = 1, MAX = 4;
const EVERY = ['day', 'weekday', 'week'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// the setup task the app made (renderer/js/jobs.js jobsSetupTask)
const isSetup = (t) => !!t && !!t.jobsSetup;
// what a run with the setup task is told (added to its instructions)
const JOBS_NOTE = '\n\n## Jobs to suggest (a task with `setup: "jobs"`)\n' +
  'This task is a setup, not work to do. Look at his calendar (`calendar`: the next two weeks) and, when the mail tools ' +
  'are there, the last week of his inbox (subjects and senders are enough: one or two broad searches like newer_than:7d, ' +
  'and open only what you must), and at the skills you have, and propose 2 to 4 (usually 3) standing jobs the Agent ' +
  'could do for him on a schedule. Good jobs come round: a weekday-morning look at the inbox for what needs an answer, ' +
  'a Monday list of the week\'s deadlines and appointments, a weekly grocery order, a check on a bill or a subscription, ' +
  'a Friday look at an application or a refund he is waiting on. Each job: {"title": the job as an Agent task title, ' +
  'written the way he writes tasks ("Look at my inbox and list what needs an answer"), "why": one line on what you saw ' +
  'that suggests it (an event, a sender, a pattern; no details from an email), "every": "day" | "weekday" | "week", ' +
  '"day": 0-6 (Sunday = 0) when every is "week", else null, "at": "HH:MM" 24-hour, local time}. ' +
  'Do NOT do any of the jobs now, and suggest nothing that buys, sends or submits on its own (a job that ends in one ' +
  'still waits for his yes each time). Answer with status needs-you, `jobs`, and a note of one or two lines on what you ' +
  'looked at. Nothing worth suggesting, or nothing to look at: say so in the note and send `jobs` null.';

// the model's jobs → clean ones, or null
function cleanJobs(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const j of list) {
    if (!j || typeof j !== 'object' || out.length >= MAX) continue;
    const title = String(j.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const every = EVERY.includes(j.every) ? j.every : null;
    if (!title || !every) continue;
    const at = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(j.at || '')) ? String(j.at) : '08:00';
    const day = every === 'week' ? (Number.isInteger(j.day) && j.day >= 0 && j.day <= 6 ? j.day : 1) : null;
    out.push({ title, why: String(j.why || '').replace(/\s+/g, ' ').trim().slice(0, 240), every, day, at });
  }
  return out.length >= MIN ? out : null;
}
// "Every weekday at 8:00 AM" (the page shows the same through agent-chat.js repeatText)
function when(j) {
  const p = String(j.at || '08:00').split(':').map(Number);
  const h = p[0] % 12 || 12, time = h + ':' + String(p[1] || 0).padStart(2, '0') + ' ' + (p[0] < 12 ? 'AM' : 'PM');
  return (j.every === 'day' ? 'Every day' : j.every === 'weekday' ? 'Weekdays' : 'Every ' + DAYS[j.day == null ? 1 : j.day]) + ' at ' + time;
}
// the jobs as text (the log)
const summary = (jobs) => (Array.isArray(jobs) ? jobs : []).map((j, i) => (i + 1) + '. ' + j.title + ' (' + when(j) + ')' + (j.why ? ' — ' + j.why : '')).join('\n');
// the Agent task a Start makes: queued now, then on its schedule (nextRunAt = agent-chat.js nextRepeatAt)
function jobTask(setup, j, { now = Date.now(), uid, nextRunAt } = {}) {
  const repeat = { every: j.every, at: j.at || '08:00', day: j.every === 'week' ? (j.day == null ? 1 : j.day) : null };
  return { id: uid(), title: j.title, done: false, due: null, dueTime: null, tag: (setup && setup.tag) || null, ws: 'agent', subs: [], googleEventId: null, created: now,
    status: 'queued', note: null, reply: null, options: null, repeat, nextRun: nextRunAt ? nextRunAt(repeat, now) : null,
    notes: j.why ? 'Why the Agent suggested it: ' + j.why : null,
    history: [{ who: 'sys', text: 'Started from the Agent’s suggestions: runs now, then ' + when(j).toLowerCase() + '.', at: now }] };
}
// the setup task itself: queued on the cloud lane (it reads his mail through the app's own mail tools), an inbox run when a mailbox is connected
function setupTask({ uid, now = Date.now(), mail = true } = {}) {
  return { id: uid(), title: TITLE, done: false, due: null, dueTime: null, tag: null, ws: 'agent', subs: [], googleEventId: null, created: now,
    status: 'queued', note: null, reply: null, options: null, jobsSetup: true, useInbox: mail ? true : null, lane: 'claude', routedLane: 'claude', laneOk: true,
    history: [{ who: 'sys', text: 'The Agent looks at your calendar and inbox and suggests a few jobs it could do for you on a schedule. Nothing starts until you press Start on one.', at: now }] };
}

module.exports = { TITLE, isSetup, JOBS_NOTE, cleanJobs, when, summary, jobTask, setupTask, MIN, MAX };
