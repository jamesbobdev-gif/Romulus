---
name: study-plan
description: A study plan for a class's exam (final, midterm, quiz): what it covers comes from his class site (syllabus, schedule, review guide), never from asking him
browser: yes
---

# Study plan for a class exam

What the exam covers is on his class site, and you can open it. **Never ask him which chapters or
topics it covers**, or what the class uses: find it. Ask him only for what really isn't in the course,
and say where you looked.

## Without the browser
If you don't have the browser_* tools this run, don't guess the chapters and don't ask him: leave the
task out of `updates` so an AI with the browser takes it. If none comes after you, answer needs-you:
"This needs the browser to read your class site: turn on the browser for an AI in Settings, or start
your local model."

## Find it in the course
1. `classSites` in the task says which site each of his classes is on (his school's own address, never
   blackboard.com or d2l.com). Open the class the task names.
2. A sign-in page: stop. Never type his password. Answer needs-you: "Sign in to <site> in the agent
   browser window, then reply try again."
3. Look, in this order, and keep what each says:
   - the exam's own page or calendar item, and Announcements: date, time, where, length, format,
     open or closed book, cumulative or not, its weight;
   - the syllabus and the course schedule (often under Syllabus, Course Information or Start Here;
     open the file): which chapters were taught in which week;
   - Content / Modules: the chapters or modules this term, and any review or study guide, practice exam
     or sample questions;
   - a McGraw Hill Connect (or other publisher) link: which chapters have practice there.
4. Read only: never start, submit or post anything, not even a practice quiz that counts. Leave his
   grades alone: those stay on his own computer.
5. If the course really doesn't say what the final covers, use what was taught this term (the schedule
   and modules) and say so.

## Write the plan (in `note`, status needs-you so he sees it)
Markdown, from what the course says only (never a made-up chapter, date or rule):
- `# Study plan: <the exam> (<date and time>)`
- **What's on it:** the chapters and topics, and where that came from.
- **The exam:** format, length, what is allowed, its weight (skip what the course doesn't say).
- `## Day by day`: one line per day from today until the day before the exam: the date, the chapters
  or topics, what to do with them (which sections to re-read, which Connect practice, which review-guide
  questions) and about how long. Earlier chapters come back for a short review later; the last day or two
  are a full review and a practice run.
- `## Topic checklist`: every chapter or topic on it, with where its material is.
- `## Couldn't find`: anything that matters and wasn't in the course (skip if nothing).
- `## Where it came from`: the pages and files, one per line.
End with: Reply with changes ("I only have an hour a day") and I'll rewrite it.
No emoji.
