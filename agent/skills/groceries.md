---
name: groceries
description: Grocery orders with EBT (he picks the store each time): his grocery list, the weekly order, checkout up to the order button, placing it after his yes
match: \b(grocer(y|ies)|food|walmart|instacart|doordash|uber ?eats|amazon fresh|whole foods|ebt|snap|milk|eggs|bread|meat|chicken|produce|fruit|veggies|vegetables|snacks|restock|pantry|fridge)\b
---
# Groceries

- **Where: he picks, every time.** He pays with EBT (SNAP), and several stores take it online. Unless
  this task, his latest reply or the conversation so far already names a store for this order, your
  FIRST answer on a new grocery task is one tap question in `ask` (nothing shopped yet):
  {"q":"Which store this time?","choices":["Walmart","Amazon Fresh", then one "<Store> (Instacart)" for
  every Instacart store you found],"pick":"one","default":<your recommendation, below>}, with a short
  note. A saved store in his preferences is never a reason to skip the question.
- **Instacart is many stores, not one.** It delivers from lots of grocers, and many of them take EBT
  there. Before asking, open Instacart for his address and read its store list: every store marked as
  taking EBT/SNAP is its own choice, "<Store> (Instacart)". Never offer just one Instacart store, never
  just "Instacart", and never assume Instacart means Aldi. Up to 8 choices in all: if there are more,
  keep the cheapest ones to get delivered.
- **Comparing stores: three helpers at once.** Whenever you check prices, fees or deals at more than
  one store, don't visit them one by one: split the stores into up to three groups and send
  store-checker-1, -2 and -3 in ONE message (several Agent calls together), each with its stores and
  his items with sizes (his grocery list, or what this order needs). They work at the same time in
  their own tabs of the agent browser, signed in where he is, and only look. Use their reports for
  the store question, its recommendation and each item's `options`; open a store yourself only to
  build the actual cart. If a helper couldn't check something (sign-in, captcha), say so in the note.
- **Recommend one.** Before asking, check what this order would cost him outside EBT at each store,
  since EBT can't pay fees or tips: delivery fee, service fee, minimum order, and any deal his own
  accounts get. Look at what each site shows when he's signed in: Amazon Fresh (Prime or the
  discounted EBT Prime, free Fresh delivery over a set amount), Instacart+ or a store's free-delivery
  offer ("$0 delivery"), Walmart+. Also note any deal from his Groceries preferences ("Deals: …").
  Watch for free delivery that is really a paid trial and count its price. Make the cheapest choice
  overall the `default` (fees plus roughly what his list costs there), and give the reason in one line
  of the note: "Amazon Fresh is cheapest: $0 delivery with your Prime over $35, about $4 less than
  Walmart." Name a store's deal only if you saw it; if you couldn't check one, say so.
  The 2-week order (`scheduledRun`) is the one exception: build it at the store he used last, and end
  the note with "Want another store this time? Reply with its name."
- **Use his account:** shop in the agent browser, logged in to the store. If you hit a sign-in page,
  stop: `needs-you`, "Log in to <store>: tap ◉ Watch on this task, sign in there, then reply." Never type
  a password. If he already tried and the store won't let him in (the conversation says so, or this
  is the second time you've hit its sign-in page), don't just ask again: put the other EBT stores in
  `ask` ("Walmart won't let you sign in from here. Try another store?") with "Keep trying <store>"
  as one of the choices.

## Grocery setup (first time only)
- Before the first order, check his preferences for a **Groceries** section. If there isn't one
  (and the conversation hasn't already covered it), don't shop yet: set `needs-you` with a one-line
  note ("A few quick questions before your first order") and send the questions in `ask`, so he taps
  through them one at a time. Check first which stores really take EBT online and deliver to his
  address, and offer only those. The default is the usual answer:
  1. "Which store?" choices: the EBT-online stores that deliver to him (Walmart, Amazon Fresh, and
     every EBT store on Instacart at his address) [the one he mentioned, else your recommendation].
     Always include this one, even if he already named a store: the choices are how he sees what
     else there is.
  1b. "Any grocery deals or memberships?" pick many: "Amazon Prime (or EBT Prime)", "Instacart+",
     "Walmart+", "None" [None]. Save it as "Deals: …" under Groceries: it decides which store you recommend.
  2. "Delivery or pickup?" [Delivery]
  3. "EBT can't pay the delivery fee or tip. How should that be paid?" choices: "Debit/credit card
     saved on the store", "I have Walmart+ (no fees)", "Neither: use pickup" [Debit/credit card saved
     on the store]
  4. "Good delivery times?" pick many: Mornings, Afternoons, Evenings, Weekends, Any time [Any time]
  5. "Allergies or foods you avoid?" pick many: None, Dairy, Gluten, Nuts, Pork, Shellfish [None]
  6. "Brands?" Store brand to save money, Name brands, Mix [Store brand]
  7. "If something's out of stock?" Closest match, Ask me, Skip it [Closest match]
  Then one more message only if his list is empty: "What do you usually buy?" (`choices: []`).
- His answers come back as the reply. Save each as a `pref` line under section "Groceries" (send
  `pref` as a list), e.g. {"section":"Groceries","text":"Brands: store brand"}. His usual items go on
  his list with `list.add`, not in prefs. Then go straight on to building the first order.
- After that, follow the Groceries section of his preferences every time, and never re-ask it. If he
  changes one later ("switch to pickup"), save the new line under Groceries.

## His grocery list
- The task's `groceryList` is what he buys regularly. The app doesn't show it as a list: he sees each
  order as picture cards and changes it there, or by telling you ("we're out of eggs", "stop getting kiwis").
  `due: true` means it goes on this order: he ran out (`ranOut`), it's new, or its weeks are up
  (`every`). Items that aren't due stay off the cart unless he asks for them.
- **He asks what's on his list** (or what he usually gets / got last time): answer with `cards`, the
  items from `lastOrder` exactly as given (name, qty, price, image, url), so he sees the pictures. No
  `lastOrder` yet: `cards` = his list items by name only. The note is one or two lines (how many items,
  what's due, "notPlacedYet" = that order isn't placed yet), never the item list itself. Don't shop.
  Every later answer in that conversation ("add hummus", "stop getting kiwis") sends `cards` again,
  updated: added items by name (with a picture and url only if you looked one up), removed ones gone.
- After an order, send `list.bought` with the names of the list items in it (exactly as the list has
  them). New things he wants regularly → `list.add` (name with brand and size, e.g.
  "Eggs, Great Value large, 18 ct", and `every` = weeks between orders). Remove items only when he
  asks, with `list.remove`.
- Missing sizes or brands that matter ("milk": what kind?) → ask once with choices, unless the list,
  his preferences or earlier orders answer it.

## Building an order
- **The 2-week order** (`scheduledRun`: the app opens a new Groceries task every 2 weeks, counted
  from the last time he asked for groceries; or he asks for "the usual"): don't ask what to get. Put every due
  item in the cart, plus anything in his latest reply. No `groceryList` yet? Ask once what he
  usually buys, and `list.add` his answer.
- **Best deal for one person:** he lives alone. For every item, compare the store's options (sizes,
  store brand vs name brand, sale/rollback prices, multi-packs) by **unit price** (per oz, lb, ct), then
  pick the cheapest one he'll actually finish before it goes bad:
  - Perishables (fresh produce, eggs, fresh meat): the amount one person uses up before the next
    order (a dozen eggs, not five dozen; a 2 lb bag of apples, not a 10 lb box), and meat he can freeze
    in portions.
  - Frozen, canned and shelf-stable food (frozen veggies and fruit, canned beans and tomatoes, nuts):
    the bigger size is fine when its unit price is clearly lower and it still fits his EBT balance.
  - A bigger pack that costs less in total than a smaller one: take the bigger one.
  In `cart`, give each item's unit price (`unit`, e.g. "$0.12/oz") and, where you picked it over another
  option, a few words on why in `why` ("cheapest per oz", "smaller: you'd waste the gallon"). End the
  note with what you saved compared with the default picks, if anything.
- **He sees every option.** For each item, keep the other real choices you compared (other sizes,
  brands, store brand vs name brand, sale items): up to 4, best value first, each one EBT-eligible and
  in stock. Put them in that item's `options` ([{name with brand and size, qty = how many of it to
  cover about the same amount (one 18 ct instead of two dozen), price for that line, unit, image,
  url}], with pictures like the item itself). The item is your pick; the app shows the
  rest in a menu on its card so he can switch before checkout. Skip `options` only when the store has
  nothing else close (one kind of limes).
- **EBT-eligible only:** with EBT as his only payment, keep the cart to SNAP-eligible food (Walmart
  marks it "EBT eligible"). Leave out non-eligible items (hot food, household, paper goods) and tell
  him which ones you left out.
- **EBT balance:** checkout shows his EBT balance. If the cart is over it, take off the least
  essential items until it fits (snacks before staples; items that just came due before items he ran
  out of) and say what you took off. Put the balance left after this order in the note.
- **Swaps:** out of stock → pick the closest match (same size, similar price) and list every swap in
  the note. Allow the store's own substitutions only if he said so.
- **Delivery:** he wants it delivered to his door. EBT usually can't pay the delivery fee or tip:
  if delivery needs a payment he doesn't have on file, say so and offer pickup instead of guessing.
  Check the store's minimum order and say if the cart is under it.
- **He checks his items first, before any ideas.** Once his items are in the store cart (no ideas yet,
  no checkout), stop: `needs-you`, with the whole `cart` (every item with its `url`, `options`, `unit`,
  `why`, as in Checkout below; nothing `suggested`). The note: one line with the store and about what
  it costs, then "Tap any to leave out or switch sizes, then tap Done. Next I'll add a few ideas for
  the week and go to checkout." Never "Reply yes" here. His answer is "done, keep the cart as it is" or
  "done, and update the cart, without: A, swap: B → C": change the store cart to exactly that, then
  add the ideas (below) and go on to checkout and the final review. Skip this stop only when the
  conversation shows he already went through it for this order.

## Ideas for the week (once he has a list)
- When his grocery list has items, add **3–6 ideas** to each order, after he's checked his items
  (the stop above): foods he doesn't usually buy that
  go with what's on his list, so the week's food fits together. Think in meals: chicken + rice +
  frozen broccoli → teriyaki sauce; bread + eggs → shredded cheese for breakfast sandwiches; pasta →
  sauce and ground turkey; tortillas → salsa and beans. Prefer things that use up what's already in the
  cart, and a little variety from last week (the conversation shows what you suggested before; don't
  repeat ones he skipped).
- Follow his Groceries preferences (foods he avoids, brands, budget). EBT-eligible only, and keep the
  whole cart, ideas included, inside his EBT balance.
- Put them in the store cart too, and in `cart` (with their picture and page, like every item) with `"suggested": true` and `why` = a few words on
  what it goes with ("with your chicken and rice"). The app shows them last, unselected: he taps the
  ones he wants. The note gives the total without the ideas. Ideas only come with the final review,
  never with the first stop where he checks his items.
- His yes names what he kept ("keeping the ideas: …") and what to take out ("take out the ideas I
  didn't pick: …"). Remove the ones he didn't pick before placing. An idea he keeps two orders in a row
  → `list.add` it (he can drop it from his list any time).

## Checkout and his yes
- **The cart always comes with you.** Whenever you stop with items in the store cart, for any reason
  (no payment method, a sign-in, an item question, the final review), send the whole `cart` exactly
  as below, `options` included. Without `cart` the app shows him only words, no order cards.
- **Read the cart in one look, don't click through it.** Never open item pages one by one to collect
  details: that runs out of time before you answer, and then he gets nothing. Take each item's name,
  count, price and product link (`url`) from ONE snapshot of the cart or checkout page; the app gets
  every picture from `url` itself, so `image` is optional. For `options`, use what the store checkers
  reported, or one search per item at most (the search results show sizes, prices and links). If the
  cart came from an earlier run, read it the same way. Running long? Send the `cart` you have rather
  than nothing.
- Go all the way to the final review page: delivery slot, address, payment (EBT card on file), and
  the total split by EBT and anything else. Then stop: `needs-you`. Put every item in `cart`
  ({name, qty, price for that line, image = the product photo's https address as the store shows
  it (on Walmart, the i5.walmartimages.com picture of that item), url = the item's product page,
  swap = what it replaced, unit, why, options = the other choices above}). Every item needs its `url` (and `image` when the cart page shows it): he picks by looking at the pictures, so the app shows them as cards he can deselect. The note is short (the
  pictures do the talking): one or two lines with the slot, the total, how it's paid, the EBT balance
  left and any swaps (never the item list), ending with "Reply **yes** to place this order."
- **Deselected items:** his answer may be "yes, place it without: A; B, and take out the ideas I didn't
  pick: C, keeping the ideas: D (N items, about $X)". That is a yes to this order minus exactly the
  items it names to take out: remove them, check nothing else changed (same slot, address and
  payment, and the total is the "about $X" he saw, give or take a few cents), then place it. If
  anything else changed, don't place it: show the new cart and ask again.
- **Swaps he picked:** either answer can end with "swap: A → B; C → D": he chose option B instead of
  your pick A ("2× B" = two of them). Take A out of the store cart and add B in that quantity (one if
  no count is given). With a yes, place it only if
  the total is still the "about $X" he saw, give or take a few cents; otherwise show the new cart and
  ask again.
- **"done" with picks:** when you asked him to do something first (add a payment method, sign in),
  his answer may be "done, and update the cart, without: A, and take out the ideas I didn't pick: C,
  keeping the ideas: D (N items, about $X)" or "done, keep the cart as it is". That is not a yes to
  place it: check what he did, change the cart to exactly his picks, then stop at the review page with
  the updated `cart` and ask for the yes as usual.
- **After his yes:** if the order button works without typing anything secret, place the order,
  put the order number and delivery time in the note, and send `list.bought`. If anything changed
  since he said yes (total, items, slot), don't place it. Ask again.
- **PIN or card number:** never type an EBT PIN, a card number or a security code, even after a
  yes. If checkout asks for one, stop: `needs-you`, "Your cart is ready at checkout. Enter your
  EBT PIN and tap Place order. Open Walmart ↗ (the cart is also in the Walmart app on your
  phone)." Leave the cart as it is, and send `list.bought` for its list items, since he's finishing
  the order himself.
