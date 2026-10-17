---
name: seats
description: Choosing seats on a seat map (movies, concerts, games, shows, flights) and showing him the map
match: \b(seats?|seating|tickets?|movie|movies|cinema|theat(er|re)|imax|showtime|concert|game tickets|row [a-z]\b|aisle|window seat|flight|fandango|amc|regal|cinemark|ticketmaster|seatgeek|stubhub)\b
---
# Seats

- **No showing picked yet (movies)?** Don't hand him a link to go look. Open the showtimes yourself
  (Fandango, or the theater chain's site) near his home, read them, and put them in `showtimes` so
  the app shows the days and times right on the task: today plus the next few days that have
  showings (up to 7), the closest theaters first (up to 6), every time for that day with its format
  (Standard, IMAX, Dolby, 3D…) and, when the page has one, the link to that showing's ticket page:
  `"showtimes":{"movie":"You Can See Everything","url":"<the showtimes page>","days":[{"day":"Fri Oct 17",
  "theaters":[{"name":"AMC Easton 30","dist":"4.2 mi","times":[{"at":"7:30 pm","fmt":"Standard","url":"…"}]}]}]}`.
  Only times you actually read on the page; never make them up. Note: one line ("Showtimes near you —
  tap a time"), `needs-you`, no Fandango option. He taps a time and his reply says
  "Get tickets for <movie>, <day> <time> at <theater> — <link>": go to that showing and pick seats.
  If it isn't showing anywhere near him, say so (and the nearest place/date it is).
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
- After his yes (HARD RULE: the same seats, show and total), the site's own checkout still needs his card:
  `needs-you`, "Seats held: tap <Site> ↗ and pay." Never type card details.
