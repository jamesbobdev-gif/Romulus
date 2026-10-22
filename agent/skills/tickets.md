---
name: tickets
description: Buying tickets: flights, games, concerts and shows — finding the options, the review stop, and booking after his yes
browser: yes
match: \b(flights?|fly(ing)?|airfare|airline|plane|round ?trip|one[- ]way|layover|nonstop|delta|united|american airlines|southwest|jetblue|spirit|frontier|alaska air|google flights|kayak|expedia|tickets? (to|for)|game tickets|concert tickets|season tickets|ticketmaster|seatgeek|stubhub|vivid ?seats|axs|box office)\b
---
# Tickets (flights, games, concerts, shows)

Tickets are bought the way Amazon orders are: you get all the way to the review page, stop and show
him exactly what he'd pay, and book it yourself after his **yes**, with the card the site already has
on file. The card number itself is never yours to type.

## What to ask first (once)
- **Flights:** from where (his home airport from his preferences, else ask), to where, dates (or
  "flexible"), how many travelers, one-way or round trip. Bags and seat preference come from his
  preferences (window unless he said aisle; carry-on only unless he said otherwise).
- **Games, concerts, shows:** which event (team/artist, the date if there are several), how many
  tickets, and a budget per ticket (ask with choices: "Under $50", "$50–100", "$100–200", "Best seats
  under $300"). His seating preferences apply (seats skill).
- Ask everything that's missing in one `ask` with choices, `needs-you`; save lasting answers (home
  airport, bag habits, favorite teams) as a `pref`. Don't search until you have the basics.

## Finding the options
- **Flights:** compare on Google Flights (google.com/travel/flights) or Kayak first: it shows every
  airline at once. Then open the airline's own site (Delta, United, American, Southwest, JetBlue…) to
  book — that is where his account and saved card are, and it's cheaper to change later than a
  third-party booking. Southwest doesn't show on Google Flights: check it yourself for domestic trips.
  - Go straight to the results, airport codes and YYYY-MM-DD filled in, cheapest first:
    `https://www.kayak.com/flights/CLE-FRA/2026-10-23?sort=price_a` (round trip: `/CLE-FRA/2026-10-23/2026-10-30`;
    2 travelers: `/2adults` before `?`) or
    `https://www.google.com/travel/flights?q=Flights%20to%20FRA%20from%20CLE%20on%202026-10-23%20oneway&curr=USD`.
  - Fares load a few seconds after the page opens: if the first look shows no prices, wait
    (browser_wait_for) and look again. If one site blocks you or shows nothing, use the other. Don't
    give up on a flight search until you've seen both, and never just from web search results.
  - A fare on the results page is real enough to show: its price, airline, times and stops are what
    he picks from. When the fare has no page of its own to link, `url` can be that results page; the
    exact fare gets checked on the airline's site after he picks.
- **Events:** the venue's official seller first (Ticketmaster or AXS for most arenas, the team's own
  site), then resale (SeatGeek, StubHub, Vivid Seats) when it's sold out or cheaper. Resale listings
  show the price before fees: open one to see the all-in total before comparing.
- Give **4–8 options** in `options`, best value first, each with a real `url` to that fare or listing
  (never a search page), `price` = the all-in total for everyone traveling (fees, taxes, bags he'll
  need), and a one-line `desc` with what's different: times, stops, airline, basic economy vs main
  (basic can't pick seats or bring a carry-on on some airlines — say so), section and row, how the
  view is. The app's cards show "Buy this" for ticket sites: his tap is his pick, not his yes.
- If his date or time is sold out, or every option is over his budget, say so and show the nearest
  dates/prices instead of picking for him.

## Booking (after he picks)
1. Open the pick in the agent browser (signed in to the airline or ticket site). Check it's the same
   flight/seats, date, count and price he picked. Pick seats per the seats skill (free ones unless he
   asked for paid seats; a group together). Turn down every add-on: trip insurance, upgrades, priority
   boarding, "flexible ticket", premium delivery, parking, merch, the site's credit card.
2. Flights need the travelers' details: full name as on ID, date of birth, gender, and sometimes a
   known traveler / phone / email. Fill them from his preferences and his Form answers (the profile on
   the mini PC). Anything missing → `needs-you`, ask for it once, and save it with `pref` (section
   "About me" or "Travel") so it never asks again. Never type a passport number or a password.
3. **Stop on the review page** (the one with Place order / Purchase / Pay now / Book): `needs-you`, with
   `cart` = one line per ticket or fare {name = "Browns vs Steelers · Sec 118 Row 12 · 2 tickets" or
   "CLE → DEN, Dec 20 7:05 am, United 1234, main cabin · 1 traveler", qty, price for that line, url,
   image when the page has one} and a short note: date and time, seats or section (flights: times,
   stops, bag allowance), the total with every fee, how it's paid as the site shows it ("Visa ending
   1234"), delivery (mobile tickets / e-ticket), the refund rule in a few words, then
   "Reply **yes** to book this."
   - No saved card, or the site insists on re-typing one: stop with "Ready at checkout — the site wants
     your card: tap <Site> ↗, enter it and tap Pay." Never type a card number, security code or PIN,
     even after a yes.
   - Sign-in page: "Log in to <Site>: tap ◉ Watch on this task, sign in there, then reply done."
   - **Holds run out.** Ticket sites keep seats only a few minutes (the page shows a timer). Get to
     the review page and send the note in one go: don't browse other options with seats on hold. If
     the hold expired by the time he says yes, grab the same seats again (or the closest ones at the
     same price, and say so) and ask for the yes again only if the total or seats changed.
4. **After his yes:** check the total, seats/flight, date, count and traveler names are still what he
   saw (a few cents of tax is fine), then press the final button (Place order / Purchase / Pay now /
   Book). Put the confirmation number, the ticket delivery (where the tickets are: the site's app, his
   email) and the date in the note, and use `done`. If anything changed, don't book: show the new
   review and ask again. "done, …" or a swap is not a yes: change it and ask again.
- Add it to his calendar (the calendar tools) once it's booked: the flight with its times and
  confirmation number, or the game with the venue and seats.
