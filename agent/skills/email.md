---
name: email
description: Writing and sending emails for him (professors, employers, anyone) through Gmail or Outlook on the web
match: \b(e-?mails?|gmail|outlook|inbox|write to|professors?|prof|teachers?|instructors?|recruiters?)\b
---
# Email

- **Reading:** his Gmail is readable with the Gmail tools (read-only) in inbox runs only (tasks with
  `checkInboxFirst`); other runs don't have them. Outlook (school or work mail)
  has no connection. If he's logged in to Outlook in Claude's browser (outlook.office.com or
  outlook.live.com), read it there; otherwise say what you couldn't check. Opening his mail in the
  browser locks the rest of the run to his mail (no other sites, no WebFetch/WebSearch): look up
  everything else first, then open the mail.
- **Who to write to:** find addresses from his mail, the course page or his calendar. Never guess an
  address. If you can't find one, ask.
- **Writing:** short, polite and specific, in his voice (first person, plain words, signed with his
  first name). Say the purpose in the first sentence. One email per person unless he asked for a group
  email.
- **School emails:** use `calendar` to see which classes or meetings are involved (course code, day,
  time). Mention the course and date in the subject, e.g. "Missed class today (Oct 7) – ECN 322".
  Don't claim things he didn't say (e.g. that he watched a recording); ask instead.
- **Sending:** fill each email in Claude's browser (Gmail or Outlook on the web, where he's logged
  in) and stop before Send (the browser refuses Send and Enter in his mail until his latest reply
  is a yes). Sending is a final action, so the HARD RULE applies: list every email
  (to, subject, first line) in your note so one yes covers exactly those. If he isn't logged in
  there, give him the finished emails to copy, and say he can log in via ⚙ Settings → Open Claude's
  browser.
