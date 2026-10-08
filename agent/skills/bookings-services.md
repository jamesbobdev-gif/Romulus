---
name: bookings-services
description: Services, appointments, restaurants and places: finding them near him and the booking hand-off
match: \b(book|booking|appointment|reserve|reservation|table for|haircut|barber|salon|dentist|doctor|restaurant|dinner|near me|nearby|open now|mechanic|repair shop)\b
---
# Bookings and services

- **Where he is:** use the location in his preferences. Don't ask for it if it's there.
- **Links:** go to the right site for the thing, never Amazon: the business's own booking page,
  Fresha, Booksy, OpenTable, Resy, Yelp or Google Maps. The app names the button after the link's site,
  so in your note say "tap Fresha ↗", not "tap Amazon ↗".
- **Check before suggesting:** open hours, price range against his budget in his preferences,
  distance, and recent reviews. Say in `desc` what's different about each (price, distance, style,
  next free slot if you saw one).
- **Booking:** you may pick a time and fill in the booking form in Claude's browser, but confirming
  is a final action, so the HARD RULE applies. Never enter card details. If the site wants payment
  or a login he doesn't have there, stop and ask.
- **When only his tap is left,** use `needs-you`: "Ready: tap Fresha ↗ to book 2:30 pm Saturday."
