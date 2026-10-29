/* Goals: a big ask that takes weeks, in steps. A task titled "Goal: get a summer internship" (or tagged
   #goal) isn't done in one run: the first run only PLANS it, 3–10 steps with an estimate, and stops for his
   yes. When he presses Start, each step becomes an ordinary Agent task of its own (goalId, goalStep) and
   they run one after another: the next one is queued when the one before finishes (its answer said
   nothing is left, or he checked it off), and a step that needs him waits like any other task. The goal
   task shows how far along it is. Every step carries his instructions for the whole goal (the task's notes),
   and final actions inside a step still wait for a yes in that step. Pure functions; no Electron, so it can
   be tested on its own. */

const TAG = /(^|\s)#goal\b/i;
const LEAD_IN = /^\s*goal\s*[:\-–]\s*/i;
const MAX_STEPS = 10, MIN_STEPS = 2;

const isGoal = (t) => !!t && (TAG.test(String(t.title || '')) || LEAD_IN.test(String(t.title || '')));
const topicOf = (t) => String((t && t.title) || '').replace(TAG, ' ').replace(LEAD_IN, '').replace(/\s+/g, ' ').trim();
// a goal task that still needs its plan: no plan yet, or he replied to the plan (changes) and it wasn't started
const needsPlan = (t) => isGoal(t) && !t.goalStarted;
// what a run with a goal-to-plan task is told (added to its instructions)
const PLAN_NOTE = '\n\n## A goal to plan (a task with `goal: "plan"`)\n' +
  'This task is a goal that will take several Agent tasks over days or weeks, not one run. Do NOT do the work ' +
  'now: plan it. Answer that task with status needs-you, a short note (what the plan does, how long it would take ' +
  'him and you, what you\'d need from him first), and `plan`: ' + MIN_STEPS + '–' + MAX_STEPS + ' steps in the order they must happen, each ' +
  '{"title": the step as an Agent task title, written the way he writes tasks ("Find 10 open software internships in Chicago"), ' +
  '"why": one line on what it gets him, "needs": what you\'d need from him for this step or "", "minutes": your estimate of the Agent\'s working time}. ' +
  'Later steps may depend on earlier ones (say so in why). Steps that end in a final action (apply, send, book, buy) still ' +
  'stop for his yes inside that step; plan them anyway. If his latest reply asks for changes to an earlier plan ' +
  '(see the conversation), answer with the changed plan. Research for the plan is fine; nothing else.';

// the model's plan → a clean one, or null
function cleanPlan(p) {
  if (!Array.isArray(p)) return null;
  const out = [];
  for (const s of p) {
    if (!s || out.length >= MAX_STEPS) continue;
    const title = String(s.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!title) continue;
    out.push({ title, why: String(s.why || '').replace(/\s+/g, ' ').trim().slice(0, 240), needs: String(s.needs || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      minutes: Math.min(240, Math.max(1, Math.round(Number(s.minutes) || 10))) });
  }
  return out.length >= MIN_STEPS ? out : null;
}
const totalMinutes = (plan) => (Array.isArray(plan) ? plan : []).reduce((n, s) => n + (s.minutes || 0), 0);
// the plan as text (the goal's conversation and the log)
function summary(plan) {
  if (!Array.isArray(plan) || !plan.length) return '';
  return plan.map((s, i) => (i + 1) + '. ' + s.title + (s.why ? ' — ' + s.why : '') + ' (≈' + s.minutes + ' min)' + (s.needs ? ' · needs: ' + s.needs : '')).join('\n') +
    '\nAbout ' + totalMinutes(plan) + ' minutes of Agent time across ' + plan.length + ' steps.';
}
// the step tasks for a plan he said Start to: the first queued, the rest waiting their turn (goalWait)
function stepTasks(goal, plan, { now = Date.now(), uid } = {}) {
  const n = plan.length, topic = topicOf(goal);
  return plan.map((s, i) => ({
    id: uid(), title: s.title, done: false, due: null, dueTime: null, tag: goal.tag || null, ws: 'agent', subs: [], googleEventId: null, created: now + i,
    status: i === 0 ? 'queued' : 'done', goalWait: i === 0 ? undefined : true, goalId: goal.id, goalStep: i + 1, note: null, reply: null, options: null,
    notes: 'Step ' + (i + 1) + ' of ' + n + ' toward his goal: "' + topic + '".' + (s.why ? ' ' + s.why : '') +
      (i > 0 ? '\nEarlier steps: ' + plan.slice(0, i).map((x, j) => (j + 1) + '. ' + x.title).join('; ') + '.' : '') +
      (goal.notes ? '\n\nHis instructions for the whole goal:\n' + String(goal.notes).slice(0, 1500) : ''),
    history: [{ who: 'sys', text: 'Step ' + (i + 1) + ' of ' + n + ' of the goal "' + topic + '"' + (i === 0 ? '' : ' — waits for step ' + i), at: now + i }],
  }));
}
const stepsOf = (goal, tasks) => (Array.isArray(tasks) ? tasks : []).filter((t) => t && t.goalId === goal.id && t.ws === 'agent').sort((a, b) => (a.goalStep || 0) - (b.goalStep || 0));
const finished = (t) => !!t.done || (t.status === 'done' && !t.goalWait);
const busy = (t) => !t.done && ['queued', 'working', 'needs-you'].includes(t.status);
// where a started goal stands: {total, finished, busy: the step going now (or waiting on him), next: the step to queue}
function progress(goal, tasks) {
  const steps = stepsOf(goal, tasks);
  const done = steps.filter(finished).length;
  const going = steps.find(busy) || null;
  const next = !going ? steps.find((t) => t.goalWait && !t.done) || null : null;
  return { total: steps.length, finished: done, busy: going, next, all: steps.length > 0 && done === steps.length };
}

module.exports = { isGoal, topicOf, needsPlan, PLAN_NOTE, cleanPlan, totalMinutes, summary, stepTasks, stepsOf, progress, MAX_STEPS, MIN_STEPS };
