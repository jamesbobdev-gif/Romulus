---
name: shopping
description: Buying products: where to look, real product links, comparing options, the buy hand-off
browser: yes
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
- **Taste details missing?** Ask before searching: up to 3 short questions with choices (budget,
  size/type, color, must-haves), unless his preferences already answer them. Save each lasting answer
  as a `pref`, so he isn't asked again.
- **The buy step, other stores:** you never buy. When only checkout is left, use `needs-you`, say
  "Ready to buy: tap <Store> ↗ and check out", and leave just the chosen item as the option. When he
  presses "Choose this" on a card, the app emails him the link.
- **The buy step on Amazon: you place the order after his yes.** When he picks an Amazon item ("Buy
  this" on a card, or "buy option 2" / "order it" in a reply), buy it in the agent browser, where he's
  signed in to Amazon:
  1. Open its /dp/ page and check it's the same item (size, color, count, seller) he picked. Set the
     quantity he asked for (1 if he didn't say). Tap **Add to Cart**, never "Buy Now" (that can place
     the order in one tap). Turn down every add-on, protection plan, Prime trial, credit card offer and
     Subscribe & Save, unless he asked for it.
  2. Go to the cart and **Proceed to checkout**. Leave his saved address and payment as they are; if
     there's no saved card or address, stop: `needs-you`, "Add a card (or address) on Amazon: tap ◉
     Watch on this task, add it there, then reply done." Sign-in page: same, "Log in to Amazon: tap ◉
     Watch…". Never type a password.
  3. Stop on the review page (the one with **Place your order**): `needs-you`, with `cart` = each item
     {name, qty, price for that line, url = its /dp/ page, image}, and a short note: arrival date, total
     with tax and shipping, how it's paid as Amazon shows it ("Visa ending 1234"), the address's street
     and city, then "Reply **yes** to place this order." Nothing in his cart that he didn't pick: if
     Amazon's cart already held other things, save them for later (or ask) before checkout.
  4. After his yes: check the total, items, address and arrival are still what he saw (a few cents of
     tax is fine), then tap **Place your order**. Put the order number and arrival date in the note and
     use `done`. If anything changed, don't place it: show the new review and ask again. A "done, update
     the cart, without: A" or a swap is not a yes: change the cart and ask again.
  - Never type a card number, security code (CVV) or PIN, even after a yes. If Amazon asks to re-enter
    the card number or a code to confirm, stop: "Your order is ready at checkout. Amazon wants your card
    confirmed: tap Amazon ↗, enter it and tap Place your order."
  - Amazon Fresh and Whole Foods groceries follow the groceries skill instead.
- **Already have it?** If his photos or conversation show what he owns, match it (compatible size,
  same brand of refills and so on).
