---
name: seats
description: Choosing seats on a seat map (movies, concerts, games, shows, flights) and showing him the map
browser: yes
match: \b(seats?|seating|tickets?|movie|movies|cinema|theat(er|re)|imax|showtime|concert|game tickets|row [a-z]\b|aisle|window seat|flight|fandango|amc|regal|cinemark|ticketmaster|seatgeek|stubhub)\b
nearby: yes
---
# Seats

- **Movies go in four steps, one per run.** Skip a step only when the task or his replies already answer it.
  1. **Days and tickets:** `ask` both at once: "Which days are you free?" (`"pick":"many"`, the next 7 days
     the movie is playing near him, today first: "Today, Sat Oct 17", "Sun Oct 18"…, no default) and
     "How many tickets?" (1, 2, 3, 4; default from his preferences, else 1). Note "Which days work for
     you?", `needs-you`. Don't look up showtimes yet.
  2. **Theaters on a map:** the task carries `whereHeIsNow` (lat/lng from his computer); find the
     theaters nearest that spot (or the area the task names) showing it on any of his days, up to 8,
     and put them in `theaters`: each with its name, **full street address** (the app pins it on a map
     from that), the days of his that it's showing, and its showtimes page. No `whereHeIsNow` and no
     area in the task? Use his home city from his preferences, or ask where. Note "Showing at N theaters
     near you — tap the one you want.", `needs-you`, no `showtimes` yet. Only list theaters you actually
     found showing it; if none near him do, say so and name the nearest place/date it is.
     - **Don't stop at the first theater you find.** Check more than one source: Fandango (search near
       his city or ZIP), then the big chains' own sites (AMC, Regal, Cinemark, Marcus) and local chains
       (Atlas, local chains, independents). Aim for 5–8 theaters, closest first. A single theater
       30 miles out when he lives near a city almost always means the search was too narrow, not that
       nothing closer has it — keep looking.
     - A wide release that opens later (presales) is listed at most big theaters near him even if one
       site's search shows few. If a nearby theater's page shows the movie as "coming soon" without times
       for his days yet, still list it with `"days":[]` and say in the note that times aren't posted there
       yet.
     He taps one and his reply says "Go to <theater> — <address>".
  3. **Time:** open that theater's showtimes for his days and put them in `showtimes` (below): just that
     theater, one day tab per day of his it's playing. He taps a time.
  4. **Seats and checkout:** the rest of this skill (seat map, his yes, the site's checkout).
- **Showtimes (step 3):** Don't hand him a link to go look. Open the showtimes yourself
  (Fandango, or the theater chain's site) for the theater and days he picked, read them, and put them in
  `showtimes` so the app shows the times right on the task: every time those days with its format
  (Standard, IMAX, Dolby, 3D…) and, when the page has one, the link to that showing's ticket page:
  `"showtimes":{"movie":"You Can See Everything","url":"<the showtimes page>","days":[{"day":"Fri Oct 17",
  "theaters":[{"name":"AMC Easton 30","dist":"4.2 mi","times":[{"at":"7:30 pm","fmt":"Standard","url":"…"}]}]}]}`.
  Only times you actually read on the page; never make them up. Note: one line ("Times at <theater> —
  tap one"), `needs-you`, no Fandango option. He taps a time and his reply says
  "Get tickets for <movie>, <day> <time> at <theater> — <link>": go to that showing and pick seats.
- **That link opens the seat map.** A Fandango showing link (`tickets.fandango.com/…/jump.aspx…`) redirects
  through `/Checkout` to `seatselection` ("Choose Seats"), and it works in his agent browser. Open it with
  `browser_navigate` and read the map. Never say seat selection is "blocked" or send him to pick seats himself
  unless you opened the page in this run and saw a block or error page; then quote what it said. An earlier
  note in the conversation saying it was blocked is not proof: try it again.
- **Before the map:** pick the show/date/time and how many tickets from the task and his preferences.
  If the count or time is missing, ask (with choices) instead of guessing.
- **Choosing seats yourself:** follow his seating preferences first (e.g. aisle, back row, near an
  exit). Otherwise:
  - Movies: centered, about two-thirds of the way back, never the first 3 rows.
  - Concerts, games, shows: the best view for the price he gave; closer and centered beats far to the side.
  - Flights: window unless he said aisle; together for a group; never pay for a seat upgrade without asking.
  - A group sits **together in one row**, side by side. Leave wheelchair and companion seats free.
  - If the best seats cost more (premium, recliner, D-BOX), say so and pick the regular ones unless he asked.
- **Select them on the site** (clicking seats is fine), then stop before checkout or payment: buying the
  tickets is a final action (the HARD RULE). Never type a card number.
- **Show him the map in `seats`** (the app draws it like the site does, with your pick in blue). Read
  the site's seat map row by row, front (nearest the screen/stage) first:
  `"seats":{"where":"AMC Easton 30 · Dune · Fri 7:30 pm","screen":"Screen","picked":["F7","F8"],
  "price":"$31.98 with fees","url":"<the seat page>","rows":[{"row":"A","seats":"oooxx_xxooo"},…]}`
  - One character per spot, left to right as he faces the screen: `o` open, `x` taken, `p` your pick,
    `a` wheelchair/companion, `_` an aisle or gap. Seats in a row count up from 1 (skipping `_`); if
    the site's first seat in a row isn't 1, add `"first":<its number>`. `picked` = the seat names as
    the site shows them.
  - Up to 40 rows of 60 spots. A huge venue: just the section you picked from.
- **The note:** "Picked F7 and F8, center, row F of 12. $31.98 with fees. Reply **yes** to buy, or tap
  other seats on the map." He can tap seats on the map; his reply then says "Use seats …": select those
  instead (if one is gone, choose the closest free one and say so) and ask for the yes again.
- **After his yes** (HARD RULE: the same seats, show and total), go on through the site's checkout:
  - **Contact page** ("Send my confirmation to…", "Your details": full name, email, confirm email,
    sometimes phone): fill them yourself from his preferences / profile (his Form answers on the mini PC).
    Type the same email in "Email" and "Confirm email" by typing into each field (don't click a field
    whose label says "Confirm"). Tick the "I agree to the Terms & Conditions" box when the page has one:
    his yes to buy covers the theater's ticket terms. Leave newsletter / marketing / text-me boxes
    unticked. Then click "Continue to payment" (or "Continue"/"Next").
  - Only if his name or email isn't in his preferences: ask for them (`needs-you`, "What name and email
    should the tickets go to?") and add them with `pref` (section "About me") so it never asks again.
  - **Payment page:** stop. The card is his to type: `needs-you`, "Name and email filled — tap <Site> ↗
    and pay $<total>." Never type card details, and never press the final Pay / Complete purchase.
