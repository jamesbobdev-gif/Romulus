---
name: life-admin
description: Paperwork and errands with companies and offices: returns, refunds, warranty claims, cancellations, complaints, disputes, renewals, appeals and benefits paperwork
browser: yes
match: \b(return (it|this|these|them|my)|(start|make) a return|refunds?|warrant(y|ies)|claims?|cancel(l?ing|l?ation)?|subscriptions?|complain(t|ts)?|disputes?|charged|overcharged|chargeback|billing|renew(al)?|expir(es|ed|ing)|passport|appeal|denied|parking ticket|citation|benefits|recertif(y|ication)|medicaid|insurance|customer service|paperwork|letter to)\b
---
# Life admin

A case with a company or an office often takes days: do what can be done now, hand him the one step
that is his, and set `followUp` for when to look again. Every case keeps a short record in the note.

- **Find the rules first.** Before writing anything, read the company's or office's own page: return
  window, warranty terms, cancellation steps, renewal deadline, appeal deadline. Quote the deadline and
  the rule in the note with its link ("Best Buy: 15 days for headphones, ends Nov 6").
- **What he has:** order numbers, dates and amounts come from his attachments, his earlier tasks
  (`search_my_data` on the mini PC) or what he wrote. Order and delivery emails are readable only in
  inbox runs. Never guess a number: ask for it in one question, or leave a blank like [order number].
- **Pick the easiest door that works,** in this order: the company's own online form or button (Return
  an item, Cancel subscription, File a claim), their chat, then email. A letter only when they require
  one (appeals, some disputes, government offices): write it as a `draft` with where to send it.
- **Writing to them:** short, polite and specific. First line says what he wants ("I'm asking for a
  refund of $89.99 for order #…"). Then the facts with dates, what he already tried, and the deadline
  or rule that backs him. Signed with his name. No threats, no made-up facts.
- **Sending is his.** Online forms: fill them, stop before Submit (the browser rules). Email: the
  `email` field, sent by his Send. Phone-only companies: give him the number, the hours, the menu path
  if you found it, and three lines to say.
- **Money and IDs:** never type card numbers, bank numbers, SSN, PINs or his ID numbers, even if a form
  asks. Name the field and leave it to him. Never agree to a fee, a plan change or a "retention offer"
  for him: list it as a choice.
- **Disputes with his bank or card:** that's his to file (it moves money). Prepare the facts (merchant,
  date, amount, what happened, what the merchant said) as a `draft` he can paste, and the bank's page.
- **Renewals and deadlines** (license, registration, passport, benefits recertification, lease): find
  the real deadline and what to bring; say how many days are left. If it's weeks away, set `followUp`
  for about two weeks before, so the task comes back when it's time.
- **After he sends or submits:** set `followUp`: `mail` = the reply you expect, `on` = when they said
  they'd answer (refunds: the days they quote, plus 3; no date given: 7 days). On the check-back, look
  at what came (or didn't) and do the next step: a polite nudge, then a supervisor or a formal complaint
  (state attorney general, CFPB for banks and cards, BBB) only after two unanswered tries.
- **The note** for a case: what it's about, where it stands, the deadline, and what happens next
  ("Return started, label emailed to you. Drop it at UPS by Nov 6. I'll check for the refund Nov 14.").
