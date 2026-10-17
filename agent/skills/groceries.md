---
name: groceries
description: Grocery orders with EBT (he picks the store each time): his grocery list, the weekly order, checkout up to the order button, placing it after his yes
match: \b(grocer(y|ies)|food|walmart|instacart|doordash|uber ?eats|amazon fresh|whole foods|ebt|snap|milk|eggs|bread|meat|chicken|produce|fruit|veggies|vegetables|snacks|restock|pantry|fridge)\b
---
# Groceries

- **Where: he picks, every time.** He pays with EBT (SNAP), and several stores take it online. Unless
  this task, his latest reply or the conversation so far already names a store for this order, your
  FIRST answer on a new grocery task is one tap question in `ask` (nothing shopped yet):
  {"q":"Which store this time?","choices":[the stores that take EBT online and deliver to him, e.g.
  "Walmart","Amazon Fresh","Aldi (Instacart)","Giant Eagle (Instacart)"],"pick":"one","default":<the
  store he used last, from his Groceries preferences or the conversation>}, with a one-line note. A
  saved store in his preferences is only the default answer, never a reason to skip the question.
- **Instacart is many stores, not one.** It delivers from lots of grocers, and many of them take EBT
  there. Check Instacart for his address (stores marked as taking EBT/SNAP) and offer each one as its
  own choice, "<Store> (Instacart)". Never offer just "Instacart" or assume it means Aldi.
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
  1. "Which store?" choices: the EBT-online stores that deliver to him (e.g. Walmart, Amazon Fresh,
     and each EBT store on Instacart, like Aldi or Giant Eagle) [the one he mentioned, else Walmart]. Always include this one, even if he
     already named a store: the choices are how he sees what else there is.
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

## Ideas for the week (once he has a list)
- When his grocery list has items, add **3–6 ideas** to each order: foods he doesn't usually buy that
  go with what's on his list, so the week's food fits together. Think in meals: chicken + rice +
  frozen broccoli → teriyaki sauce; bread + eggs → shredded cheese for breakfast sandwiches; pasta →
  sauce and ground turkey; tortillas → salsa and beans. Prefer things that use up what's already in the
  cart, and a little variety from last week (the conversation shows what you suggested before; don't
  repeat ones he skipped).
- Follow his Groceries preferences (foods he avoids, brands, budget). EBT-eligible only, and keep the
  whole cart, ideas included, inside his EBT balance.
- Put them in the store cart too, and in `cart` (with their picture and page, like every item) with `"suggested": true` and `why` = a few words on
  what it goes with ("with your chicken and rice"). The app shows them last, unselected: he taps the
  ones he wants. The note gives the total without the ideas.
- His yes names what he kept ("keeping the ideas: …") and what to take out ("take out the ideas I
  didn't pick: …"). Remove the ones he didn't pick before placing. An idea he keeps two orders in a row
  → `list.add` it (he can drop it from his list any time).

## Checkout and his yes
- Go all the way to the final review page: delivery slot, address, payment (EBT card on file), and
  the total split by EBT and anything else. Then stop: `needs-you`. Put every item in `cart`
  ({name, qty, price for that line, image = the product photo's https address as the store shows
  it (on Walmart, the i5.walmartimages.com picture of that item), url = the item's product page,
  swap = what it replaced, unit, why, options = the other choices above}). Every item needs its picture: he picks by looking at them, so the app shows them as cards he can deselect. The note is short (the
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
