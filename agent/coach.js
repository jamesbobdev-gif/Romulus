/* Coach: a task only he can do (record the video for class, give the presentation, the speech, the interview).
   The Agent can't do it for him, so instead of "I can't" it gets him ready: Lupa (the mini PC's model, the
   only one signed in to his Blackboard / D2L) opens the assignment, reads the instructions, the rubric and
   what it links to, sends the outside research to his cloud AIs the legion way (each gets one general question,
   none sees the assignment), and writes him a brief: what to do, step by step, and what to say, word for word.
   Tagged #coach, starting "Coach me:", or a human-only act in the title. No Electron here, so it can be tested on its own. */

const TAG = /(^|\s)#coach\b/i;
const LEAD_IN = /^\s*(coach me|help me (do|prep(are)?( for)?)|prep me( for)?|what do i (say|do) for)\s*[:\-–]?\s*/i;
/* what only he can do: be on camera or on the mic, stand up in front of people, show up in person.
   "make a video" counts, "find a video" or "watch the video" doesn't */
const HUMAN_ONLY = new RegExp([
  '\\b(record|film|shoot|make|create|do|tape|upload|submit|post)\\b[^.\\n]{0,40}\\b(videos?|vlogs?|video (essay|response|reflection|presentation)|recordings?|voice ?threads?|flip ?grids?|podcasts?|screencasts?)\\b',
  '\\b(video|oral|recorded|voice|audio) (presentation|reflection|response|introduction|intro|assignment|essay|pitch|report)s?\\b',
  '\\b(give|do|present|deliver|practice|prep(are)?( for)?)\\b[^.\\n]{0,30}\\b(presentation|speech|talk|pitch|demo|toast|eulogy|oral (exam|report))s?\\b',
  '\\b(present|presenting) (in|to) (class|the class)\\b',
  '\\b(job |mock |phone |video )?interview (prep|practice)\\b|\\bprep(are)? for (my |the |an? )?(job |phone |video )?interview\\b',
  '\\b(speech|presentation|oral exam|oral report|lab practical|in-person|in person)\\b[^.\\n]{0,20}\\b(due|today|tomorrow|on|for)\\b',
].join('|'), 'i');
// "Find a video on photosynthesis" is research, not something only he can do
const NOT_HIS = /^\s*(find|look up|search|research|watch|summari[sz]e|transcribe|download|compare)\b/i;

const isCoach = (t) => {
  const title = String((t && t.title) || '');
  if (TAG.test(title) || LEAD_IN.test(title)) return true;
  if (/(^|\s)#(legion|research|claude)\b/i.test(title) || NOT_HIS.test(title)) return false;
  return HUMAN_ONLY.test(title + '\n' + String((t && t.notes) || '').slice(0, 400));
};
// "Coach me: record the intro video #coach" → "record the intro video"
const topicOf = (t) => String((t && t.title) || '').replace(TAG, ' ').replace(LEAD_IN, '').replace(/(^|\s)#(local|coach)\b/gi, ' ').replace(/\s+/g, ' ').trim();

// his school sites, so their site notes come with the task even though it has no link to them yet
const SCHOOL_HOSTS = ['https://school.blackboard.com', 'https://school.brightspace.com'];

// what Lupa is told on top of its usual rules (agent/local-prompt.md)
const RULES = `

## This is something only he can do (coach mode)
He has to do this one himself (be on camera, speak, show up). You can't do it and must not say
"I can't": your job is to get him ready, so that all he has to do is follow your brief.

1. **Find the assignment.** It's in his course on Blackboard or D2L (his school's address is in his
   preferences; the site notes below say where things are). Use search_my_data first for the course
   name or code if the task doesn't give it. Open the assignment itself and read ALL of it: the
   instructions, the rubric or grading criteria, the length or time limit, the format (where and how
   to record, file type, camera on, slides or not), the due date, how to submit, and any reading,
   video or template it links to (open those too). Signed out? Answer needs-you: he signs in on the
   mini PC's browser, then replies "try again".
2. **Research the topic only if the course doesn't cover it.** Send that to ask_helpers, the legion
   way: each question general and on its own (a fact, a definition, an example), never the assignment
   itself, the course, the school or anything about him. Up to 4 questions. If the topic needs much
   more than that, say so at the end of the note (see below).
3. **Write the brief** as the note, Markdown, status "needs-you", in this order:
   # <what it is> (due <date>)
   **What they want:** 2–3 lines straight from the instructions (length, format, where it goes).
   ## Before you start
   (what to have ready: setup, notes, slides, a quiet room, which tool to record in)
   ## What to do
   (numbered steps, start to submitted)
   ## What to say
   (the script, word for word, split into the parts the instructions ask for, each with roughly how
   long it takes when spoken, ~130 words a minute; it must fit the time limit. Written as he'd say it:
   plain, first person, short sentences. Put [his own example] where only he can fill it in.)
   ## Rubric check
   (each criterion from the rubric → where in the script it's covered)
   ## Where it came from
   (the course page(s) you read, with their links)
   If the topic needed more research than the helpers could give, end with one line:
   "⚔ For a deeper look, add a #legion task: <a research question that names the topic, not the course>".
4. Never submit, upload, post or start anything on the course site. Read only.
5. If the instructions can't be found, say exactly where you looked, write the best brief you can from
   the task, and mark it "(not from the assignment: check the instructions)".`;

module.exports = { isCoach, topicOf, RULES, SCHOOL_HOSTS };
