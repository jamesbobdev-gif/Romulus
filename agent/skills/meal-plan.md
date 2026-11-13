---
name: meal-plan
description: Meal planning: a few tap questions, then a plan of meals with its per-day macros, which the app sets as his Food plan (Health tab) so grocery orders buy for it
match: \b(meal ?plan(ning|s|ned)?|meal ?prep(ping)?|plan (my|our|the|some) (meals|food|eating|diet)|diet plan|eating plan|what (should|do|can) i eat|macros?|calorie (goal|target|budget)|(lose|drop|cut) (weight|fat|pounds|lbs)|(gain|build|put on) (weight|muscle)|bulk(ing)?|cutting|high[- ]protein|eat (healthier|healthy|better|clean|more protein)|nutrition|how much (protein|calories|carbs|fat)|(\d+(\.\d+)?|one|a|half a) ?(g|grams?) (of )?(protein|carbs?|fat)|(protein|carbs?|fat|calories?|kcal) (goal|target|intake|a day|per day|every day|daily)|(\d[\d,]*) ?(calories|kcal) (a|per|every) day|(protein|carbs?|fat)\b[^.]{0,40}\b(per|for every|for each|each|a) (pound|lb|kilo|kg)s?( of (my )?(body ?)?weight)?)\b
---
# Meal plan

No web needed: this is worked out from his answers. The plan's numbers go to the app's Food plan
(Health tab) through `macros`, and from then on every grocery order is built to add up to them
(groceries skill, `macroPlan`). What he told you before is in his preferences (About him, Groceries).
His weight is the task's `bodyWeight` when there is one ({lb, kg, asOf, daysAgo, from}: the Health
tab's Weight, typed there or his phone's newest weigh-in). It beats a weight in his preferences or an
older reply unless he gives a new one in this task; never ask for it when it's there. Say which you
used ("1 g × 182 lb, your weight on the Health tab").

## One number, or a rule for one ("1 g of protein for every pound", "2,000 calories a day")
When the task only sets or changes a target, don't plan meals and don't ask the questions below:
- Work the number out. A per-pound or per-kilo rule needs his weight: from this task, his replies,
  `bodyWeight`, or his preferences (About him), in that order. Without any of them, set `needs-you` with "What do you weigh right now?" in
  `ask` (`choices: []`, any units) and nothing else; save the answer as a `pref` under "About him"
  and say in the note he can keep it on the Health tab (Weight) so it's never asked again.
  1 kg = 2.2 lb. Round to fives (protein, carbs, fat) or tens (calories). Keep it sane: protein
  2 g per pound at most; if the rule gives more, use that cap and say so.
- `macros`: only what changed, with `"keep":true`, e.g. {"protein":180,"keep":true}. The app changes
  that number in his Food plan (Health tab) and keeps the rest and its dates (`macroPlan` is what he
  has now; none = this starts one, until he changes it). Add `span` only if he gave a length.
- The note, two lines: the number and how ("180 g protein a day: 1 g × 180 lb."), and "Your Food plan
  (Health tab) now has it; the next grocery order buys for it." If `macroPlan` has calories and the
  new protein alone is over 40% of them, add one line saying so and offer to rebalance.
- Save the rule itself as a `pref` under "Groceries" ("Protein: 1 g per pound of body weight"), so a
  later weight change or meal plan uses it.
- `status: done`.

## Ask first (one `ask`, the questions together)
Unless this task, his replies or his preferences already answer them, don't write a plan yet: set
`needs-you` with a one-line note ("A few quick questions and I'll plan your meals") and send these
in `ask`, so he taps through them. Keep the order, and drop every question his preferences, this
task (its title counts: "1 g of protein per pound" sets the protein) or `whatHeEats` already answers. Drop
it, don't ask it with a reminder of the answer: if his preferences say he avoids gluten, grains and
dairy, there is no "Foods to skip?" question. Plan around his pantry and usual groceries (`whatHeEats`).
1. "What's the goal?" one of: "Lose fat", "Keep my weight", "Build muscle", "Just eat better" [Just eat better]
2. "Your height, weight and age? (and sex, for the numbers)" `choices: []` — one line, any units.
   With a `bodyWeight`, ask only "Your height and age? (and sex, for the numbers)". If he skips it,
   plan on general numbers and say so.
3. "How active are you?" one of: "Mostly sitting", "On my feet a lot", "Train 3+ times a week" [On my feet a lot]
4. "Meals a day?" one of: "2", "3", "3 + snacks" [3]
5. "Foods to skip?" pick many: "None", "Dairy", "Gluten", "Nuts", "Pork", "Shellfish", "No meat", "Vegan" [None]
6. "Cooking?" one of: "Quick, 15 min meals", "Some cooking is fine", "I like to cook" [Quick, 15 min meals]
7. "How long should this plan run?" one of: "A week", "2 weeks", "A month", "Until I change it" [A week]
His answers come back as the reply, one line per question. Save the lasting ones as `pref` lines
(a list): goal and foods to skip under "Groceries", his body numbers and activity under "About him".

## The numbers
- Calories: Mifflin-St Jeor from his height, weight, age and sex, times activity (sitting 1.2, on
  his feet 1.45, training 1.6). Lose fat: minus 500 a day (never under 1,500 for a man, 1,200 for a
  woman). Build muscle: plus 300. Otherwise as is. No body numbers: 2,000 a day (1,800 to lose, 2,300
  to build), and say the plan is on general numbers.
- Protein: 0.8 g per pound of body weight to lose fat or build muscle (0.7 g otherwise), 2 g per
  pound at most; without a weight, 130 g. Fat: 30% of calories (÷ 9). Carbs: the calories left (÷ 4).
  Round everything to tens.
- Allergies and "foods to skip" (here, or in his preferences) rule everything below.

## The plan (in the note; it has room for about 1,200 characters, so keep it tight)
- First line: the per-day targets, "2,100 kcal · 160 g protein · 200 g carbs · 65 g fat a day", and
  one clause on why (the goal, the deficit or surplus).
- Then a rotation, not a calendar: 2–3 options for each meal of the day (breakfast, lunch, dinner,
  and snacks if he has them), each one line with portions in household amounts ("2 eggs + 2 toast
  + 1 banana · 450 kcal, 24 g protein"). Any day made of one of each lands within about 10% of the
  targets: check one example day adds up and show its total in one line. Quick meals when he asked
  for quick ones; foods that repeat across meals (one chicken, one rice, one vegetable) so the
  shopping stays small and cheap; store-brand staples when his preferences say so.
- End with: "Your Food plan (Health tab) is set to this; the next grocery order buys for it. Reply
  with changes, or 'order groceries' to shop for it now."
- `macros`: {"kcal":2100,"protein":160,"carbs":200,"fat":65,"span":"week"|"2weeks"|"month"|"open"}
  (span from question 7: a week → week, 2 weeks → 2weeks, a month → month, until I change it →
  open). Send it with the plan, and again, updated, with every later change he asks for
  ("more carbs", "make it 2,300"); never without a plan in the note.
- `status: done` once the plan is in the note. Don't touch his grocery list (`list`): the groceries
  skill shops to the plan on its own, and he can ask for the order from here.
