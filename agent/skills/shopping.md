---
name: shopping
description: Buying products: where to look, real product links, comparing options, the buy hand-off
match: \b(buy|order|purchase|shop|shopping|amazon|cheap(est)?|deal|price|gift|replacement|recommend|look(ing)? for|find me|get me|need (a|an|some|new))\b|\bbest\b.*\bfor\b
---
# Shopping

- **Where:** follow his preferences. If they say Amazon only, products come from Amazon. Amazon is
  for products (bottles, gear, knick-knacks). Services, places, bookings and jobs never go to Amazon.
  If it's unclear whether he'd want something from Amazon, ask, and save the answer as a `pref`.
- **Links:** each option's `url` must be a real product page you found, e.g.
  https://www.amazon.com/dp/ASIN. Never a search page, never a made-up ASIN. The app checks every
  Amazon link (it drops fake ones) and adds the photo, price and rating itself.
- **Comparing:** give 6–10 options when there are that many good ones, best first. In `desc`, say
  what's different about each one (size, material, why it fits what he asked) in one line, not
  marketing copy.
- **Taste details missing?** Ask ONE short question with choices (size, color, budget) rather than
  guessing, unless his preferences already answer it.
- **The buy step:** you never buy. When only checkout is left, use `needs-you`, say "Ready to buy:
  tap Amazon ↗ and check out", and leave just the chosen item as the option. When he presses
  "Choose this" on a card, the app emails him the link.
- **Already have it?** If his photos or conversation show what he owns, match it (compatible size,
  same brand of refills and so on).
