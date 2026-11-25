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
- **Stores you order from yourself, after his yes:** Amazon, Walmart, Target, Best Buy, and Shopify
  stores that take Shop Pay (the app marks those cards "Buy this"). He pays with what's saved in his
  account there; you never enter payment details.
- **The buy step, every other store, with his Link wallet** (the run says "His Link wallet" when it's
  connected): you order there too, paying with a one-time card from Link. "Paying with Link" below says how.
- **The buy step, every other store, no Link wallet:** you never buy. When only checkout is left, use `needs-you`, say
  "Ready to buy: tap <Store> ↗ and check out", and leave just the chosen item as the option. When he
  presses "Choose this" on a card, the app emails him the link.
- **The buy step at a store you order from:** when he picks an item ("Buy this" on a card, or "buy
  option 2" / "order it" in a reply), buy it in the agent browser, where he's signed in:
  1. Open its product page and check it's the same item (size, color, count, seller) he picked. Set the
     quantity he asked for (1 if he didn't say). Tap **Add to Cart**, never "Buy Now" or any one-tap
     button that skips the review page. Turn down every add-on, protection plan, membership trial,
     store credit card offer and subscription, unless he asked for it.
  2. Go to the cart and check out. Leave his saved address and payment as they are; if there's no saved
     card or address, stop: `needs-you`, "Add a card (or address) on <Store>: tap ◉ Watch on this task,
     add it there, then reply done." Sign-in page: same, "Log in to <Store>: tap ◉ Watch…". Never type a
     password.
  3. Stop on the review page (the one with **Place your order** / **Place order** / **Pay now**):
     `needs-you`, with `cart` = each item {name, qty, price for that line, url = its product page,
     image}, and a short note: the store, arrival or pickup date, total with tax and shipping, how it's
     paid as the store shows it ("Visa ending 1234", "Shop Pay"), the address's street and city, then
     "Reply **yes** to place this order." Nothing in his cart that he didn't pick: if the cart already
     held other things, save them for later (or ask) before checkout.
  4. After his yes: check the total, items, address and arrival are still what he saw (a few cents of
     tax is fine), then tap the order button. Put the order number and arrival date in the note and use
     `done`. If anything changed, don't place it: show the new review and ask again. A "done, update the
     cart, without: A" or a swap is not a yes: change the cart and ask again.
  - Never type a card number, security code (CVV), PIN or a code sent to his phone or email, even after
    a yes. If the store asks to re-enter the card or a code to confirm, stop: "Your order is ready at
    checkout. <Store> wants your card (or a code) confirmed: tap <Store> ↗, enter it and place the order."
  - Shopify stores: pay with **Shop Pay** (the purple button at checkout). If Shop Pay isn't signed in,
    it texts him a code: stop, "Log in to Shop Pay: tap ◉ Watch on this task, enter the code, then reply
    done." Once he's in, it remembers him on every Shopify store. No Shop Pay at that store: treat it as
    "every other store" above.
  - Amazon Fresh and Whole Foods groceries follow the groceries skill instead.
- **Already have it?** If his photos or conversation show what he owns, match it (compatible size,
  same brand of refills and so on).

## Paying with Link (a store where he has no saved card)

The same steps as a store you order from, with these differences:
1. Check out as a guest (or with his account there, if he has one). Shipping: his Link shipping address
   from the run's "His Link wallet" line, unless his preferences give another; email and phone from his
   preferences. Decline making an account, newsletters and add-ons; never tick "save this card".
2. Go as far as the payment step and read the total with tax and shipping. Most stores show it before the
   card goes in; if a store wants the card first, use the total shown so far and say so in the note.
3. Stop: `needs-you`, with `cart` as usual, and the note: the store, arrival, the total, "Paid with a one-time
   card from your Link wallet (you approve the amount in the Link app)", the address, then "Reply **yes** to
   place this order."
4. After his yes: back on the checkout tab, check the total is still what he saw, then call `link_pay_request`
   (merchant_name, merchant_url = the checkout page, total exactly as shown, the items, subtotal, shipping
   and tax when shown, one line of `why`). It answers **approved**, or **waiting** for his approval in Link.
   Waiting: write one line for him ("Approve $X for <Store> in the Link app, or open <link>"), then call
   `link_wait`, up to three times. Still waiting after that: `needs-you`, "Approve $X for <Store> in the Link
   app (or open <link>), then reply **yes** to place the order." (the request keeps; the next run picks it up).
5. Approved: take a snapshot of the payment form, then `link_enter_card` with the refs of the card number,
   expiry (a text field; dropdowns you pick yourself from the expiry it told you) and CVC fields. The name on
   the card and the billing address (it told you both) you fill yourself. Never type the number or CVC
   yourself: the browser does, and you never see them.
6. Check the page, then tap the order button (his yes unlocked it). Order number and arrival in the note,
   `done`. Declined because the total grew (tax showed up after the card went in)? Call `link_pay_request`
   again with the new total: he approves the new amount in Link, and the card already entered covers it.
- Test mode (the run says so): the cards are fakes and nothing is charged. Say so in the note.
