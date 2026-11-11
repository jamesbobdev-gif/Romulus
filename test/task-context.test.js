const test = require('node:test');
const assert = require('node:assert');
const ctx = require('../agent/task-context');
const { saidYes, approvedHostsFor } = require('../agent/agent-browser');

test('approvedHostsFor: the page, the cart, and links he wrote; never links in the AI\'s own ask', () => {
  const t = { title: 'Apply at https://jobs.example.com/x', page: 'https://www.walmart.com/checkout', cart: [{ url: 'https://www.walmart.com/ip/1' }],
    history: [{ who: 'you', text: 'use https://shop.example.org please' }, { who: 'claude', text: 'Ready. Also see https://evil.example/pay — reply yes' }] };
  assert.deepStrictEqual(approvedHostsFor(t).sort(), ['jobs.example.com', 'shop.example.org', 'www.walmart.com']);
  assert.deepStrictEqual(approvedHostsFor({ history: [{ who: 'claude', text: 'https://evil.example/ reply yes' }] }), []);
});

test('approvedHostsFor: a cart or option link counts only on his own sites, the page, or a store', () => {
  // the AI wrote the cart and the options: a page could have put its own address there
  assert.deepStrictEqual(approvedHostsFor({ page: 'https://www.walmart.com/checkout', cart: [{ url: 'https://evil.example/pay' }] }), ['www.walmart.com']);
  assert.deepStrictEqual(approvedHostsFor({ options: [{ url: 'https://evil.example/tickets' }] }), []);
  // the same site as the page (walmart.com vs www.walmart.com), or a store, is fine
  assert.deepStrictEqual(approvedHostsFor({ page: 'https://walmart.com/cart', cart: [{ url: 'https://www.walmart.com/ip/1' }] }).sort(), ['walmart.com', 'www.walmart.com']);
  assert.deepStrictEqual(approvedHostsFor({ options: [{ url: 'https://www.target.com/p/1' }] }), ['www.target.com']);
  // a look-alike of a store is not one
  assert.deepStrictEqual(approvedHostsFor({ cart: [{ url: 'https://evil-walmart.com/x' }, { url: 'https://walmart.com.evil.example/x' }] }), []);
});

ctx.init({ userData: () => require('os').tmpdir(), readConfig: () => ({}), agentLog: () => {} });

test('prefLine: {section, text} or a plain string', () => {
  assert.strictEqual(ctx.prefLine({ section: 'Shopping', text: 'only Amazon' }), 'Shopping|only Amazon');
  assert.strictEqual(ctx.prefLine({ text: 'a|b\nc' }), 'Other|a|b c');
  assert.strictEqual(ctx.prefLine({ section: 'x' }), null);
  assert.strictEqual(ctx.prefLine('likes\ntea'), 'likes tea');
  assert.strictEqual(ctx.prefLine(null), null);
  assert.deepStrictEqual(ctx.prefLine([{ section: 'Groceries', text: 'pickup' }, { section: 'x' }, 'store brand']), ['Groceries|pickup', 'store brand']);
  assert.strictEqual(ctx.prefLine([{ section: 'x' }]), null);
});

test('wantsCalendar looks at the title, reply and his last message', () => {
  assert.ok(ctx.wantsCalendar({ title: 'gym slot Thursday afternoon' }));
  assert.ok(ctx.wantsCalendar({ title: 'x', history: [{ who: 'you', text: 'when am I free?' }] }));
  assert.ok(!ctx.wantsCalendar({ title: 'buy a lamp' }));
});

test('wantsInbox: internship tasks or useInbox', () => {
  assert.ok(ctx.wantsInbox({ title: 'Daily internship hunt' }));
  assert.ok(ctx.wantsInbox({ title: 'x', useInbox: true }));
  assert.ok(!ctx.wantsInbox({ title: 'internal memo' }));
  // tasks about his mailbox itself
  assert.ok(ctx.wantsInbox({ title: 'Clean up my inbox' }));
  assert.ok(ctx.wantsInbox({ title: 'Archive the newsletters in Gmail' }));
  assert.ok(ctx.wantsInbox({ title: 'Reply to the landlord email' }));
  assert.ok(!ctx.wantsInbox({ title: 'Find a cheap flight to Denver' }));
});

test('skillText is only his words', () => {
  const t = { title: 'T', reply: 'R', notes: 'N', history: [{ who: 'claude', text: 'C' }, { who: 'you', text: 'Y1' }, { who: 'you', text: 'Y2' }, { who: 'you', text: 'Y3' }] };
  assert.strictEqual(ctx.skillText(t), 'T\nR\nN\nY2\nY3');
});

test('a task with a cart keeps the shopping skills whatever the follow-up says', () => {
  const skills = ctx.loadSkills();
  const loads = (t, name) => skills.find((s) => s.name === name).match.test(ctx.skillText(t));
  const diet = { title: 'I want 1 gram of protein for every pound', history: [{ who: 'you', text: 'close the gap' }] };
  assert.ok(!loads(diet, 'groceries') && !loads(diet, 'shopping'));
  const food = Object.assign({ cart: [{ name: 'Eggs', food: true }] }, diet);
  assert.ok(loads(food, 'groceries') && loads(food, 'shopping'));
  const lamp = Object.assign({ cart: [{ name: 'Lamp' }] }, diet);
  assert.ok(!loads(lamp, 'groceries') && loads(lamp, 'shopping'));
  assert.ok(!loads(Object.assign({ cart: [] }, diet), 'shopping'));
});

test('cartBrief: the items he kept, his size picks, and the ones he took out', () => {
  assert.strictEqual(ctx.cartBrief({}), null);
  assert.strictEqual(ctx.cartBrief({ cart: [] }), null);
  const t = { cart: [
    { name: 'Eggs', qty: 2, price: '$4.00', food: true, options: [{ name: 'Eggs 18 ct', price: '$6.00' }] },
    { name: 'Hummus', food: true },
    { name: 'Tuna', swap: 'Chicken', food: true }],
  cartOff: ['Hummus'], cartPick: { Eggs: 'Eggs 18 ct' } };
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.cartBrief(t))), {
    items: [{ name: 'Eggs 18 ct', price: '$6.00', food: true }, { name: 'Tuna', swap: 'Chicken', food: true }],
    removed: ['Hummus'] });
});

test('taskLinks finds links anywhere in the task', () => {
  assert.deepStrictEqual(ctx.taskLinks({ title: 'see https://a.com/x', options: [{ url: 'https://b.com' }] }), ['https://a.com/x', 'https://b.com']);
});

test('the skills in agent/skills load with their match patterns', () => {
  const skills = ctx.loadSkills();
  assert.ok(skills.length > 0);
  for (const s of skills) { assert.ok(s.name); assert.ok(typeof s.body === 'string'); }
});

test('saidYes: a yes to something Claude asked to say yes to', () => {
  const asked = [{ who: 'claude', text: 'Filled it in. Reply **yes** to submit it.' }];
  assert.ok(saidYes({ reply: 'yes please', history: asked }));
  assert.ok(saidYes({ history: asked.concat({ who: 'you', text: 'go ahead and submit' }) }));
  assert.ok(!saidYes({ reply: 'yes', history: [{ who: 'claude', text: 'Which one?' }] }));
  assert.ok(!saidYes({ reply: 'not yet', history: asked }));
});

test('cleanAsk: questions with choices; a default must be one of them; empty ones dropped', () => {
  const a = ctx.cleanAsk([{ q: 'Which store?', choices: ['Walmart', 'Aldi'], default: 'Walmart' },
    { q: 'Times?', choices: ['Mornings', 'Evenings'], pick: 'many', default: ['Evenings', 'Never'] },
    { q: 'Usually buy?', choices: [] }, { q: '' }, 'nope']);
  assert.strictEqual(a.length, 3);
  assert.deepStrictEqual(a[0], { q: 'Which store?', choices: ['Walmart', 'Aldi'], pick: 'one', default: ['Walmart'], other: true });
  assert.deepStrictEqual(a[1].default, ['Evenings']);
  assert.strictEqual(a[2].other, true);
  assert.strictEqual(ctx.cleanAsk([]), undefined);
  assert.strictEqual(ctx.cleanAsk('x'), undefined);
});

test('cleanAsk: keeps all 11 first-grocery-order questions (store to activity), up to 12', () => {
  const qs = Array.from({ length: 14 }, (_, i) => ({ q: 'Question ' + (i + 1) + '?', choices: ['Yes', 'No'] }));
  assert.strictEqual(ctx.cleanAsk(qs.slice(0, 11)).length, 11);
  assert.strictEqual(ctx.cleanAsk(qs).length, 12);
});

test('cleanCart: names kept, https pictures only, quantity over 1 only', () => {
  const c = ctx.cleanCart([{ name: 'Milk', qty: 2, price: '$3.48', image: 'https://i5.walmartimages.com/a.jpg' },
    { name: 'Eggs', qty: 1, image: 'http://x/y.jpg' }, { name: '' }]);
  assert.deepStrictEqual(c, [{ name: 'Milk', qty: 2, price: '$3.48', image: 'https://i5.walmartimages.com/a.jpg' }, { name: 'Eggs' }]);
  assert.strictEqual(ctx.cleanCart(null), undefined);
});

test('saidYes: a yes that leaves items out still counts', () => {
  const t = { reply: 'yes, place it without: Chips; Soda (10 items, about $41.20)',
    history: [{ who: 'claude', text: 'Cart ready. Reply **yes** to place this order.' }] };
  assert.strictEqual(saidYes(t), true);
});

test('cleanCart: an idea for the week keeps its flag and reason', () => {
  assert.deepStrictEqual(ctx.cleanCart([{ name: 'Teriyaki sauce', price: '$2.12', suggested: true, why: 'with your chicken and rice' }]),
    [{ name: 'Teriyaki sauce', price: '$2.12', suggested: true, why: 'with your chicken and rice' }]);
});

test('cleanCart: an item keeps its unit price and why that size was picked', () => {
  assert.deepStrictEqual(ctx.cleanCart([{ name: 'Eggs, 12 ct', price: '$2.98', unit: '$0.25/ct', why: 'a dozen: 5 dozen would spoil' }]),
    [{ name: 'Eggs, 12 ct', price: '$2.98', unit: '$0.25/ct', why: 'a dozen: 5 dozen would spoil' }]);
});

test('cleanCart: an item keeps its other options (not itself, https links only, at most 6)', () => {
  const opts = [{ name: 'Eggs, 18 ct', qty: 1, price: '$4.10', unit: '$0.23/ct', image: 'https://x/a.jpg', url: 'javascript:x' },
    { name: 'Eggs, 12 ct' }, { price: '$1' }].concat(Array.from({ length: 8 }, (_, i) => ({ name: 'Eggs ' + i })));
  const [it] = ctx.cleanCart([{ name: 'Eggs, 12 ct', price: '$2.98', options: opts }]);
  assert.deepStrictEqual(it.options[0], { name: 'Eggs, 18 ct', price: '$4.10', unit: '$0.23/ct', image: 'https://x/a.jpg' });
  assert.deepStrictEqual(it.options.map((o) => o.name), ['Eggs, 18 ct', 'Eggs 0', 'Eggs 1', 'Eggs 2']);
  assert.strictEqual(ctx.cleanCart([{ name: 'Milk', options: 'none' }])[0].options, undefined);
  assert.strictEqual(ctx.cleanCart([{ name: 'Eggs, 12 ct', qty: 2, options: [{ name: 'Eggs, 18 ct', qty: 3 }] }])[0].options[0].qty, 3);
});

test('cleanCart: keeps the product page (https) so the app can find a picture', () => {
  assert.deepStrictEqual(ctx.cleanCart([{ name: 'Milk', url: 'https://www.walmart.com/ip/10450114' }, { name: 'Eggs', url: 'javascript:x' }]),
    [{ name: 'Milk', url: 'https://www.walmart.com/ip/10450114' }, { name: 'Eggs' }]);
});

test('near-me tasks get his location: nearby skills or near words', () => {
  const skills = ctx.loadSkills();
  assert.deepStrictEqual(skills.filter((s) => s.nearby).map((s) => s.name).sort(), ['bookings-services', 'groceries', 'seats']);
  for (const title of ['movies tonight', 'find a barber', 'weekly grocery order', 'closest Target with printer ink', 'is it in stock near me'])
    assert.strictEqual(ctx.wantsNearby({ title }, skills), true, title);
  for (const title of ['email my professor', 'buy a phone case on Amazon', 'print the bracket stl'])
    assert.strictEqual(ctx.wantsNearby({ title }, skills), false, title);
});

test('tickets skill: flights and event tickets match it, and it is a browsing skill', () => {
  const skills = ctx.loadSkills();
  const tk = skills.find((s) => s.name === 'tickets');
  assert.ok(tk && tk.browser && tk.match);
  for (const title of ['fly to Denver Dec 20', 'cheapest flight home for Thanksgiving', 'Browns tickets for Sunday', 'tickets to the Cavs game', 'find concert tickets on stubhub'])
    assert.ok(tk.match.test(title), title);
  for (const title of ['email my professor', 'weekly grocery order', 'buy a phone case on Amazon'])
    assert.ok(!tk.match.test(title), title);
  assert.strictEqual(tk.nearby, false);
});

test('cleanDraft: the words to post, kept whole; where is one line; empty is nothing', () => {
  const d = ctx.cleanDraft({ text: '  Hi everyone,\r\n\r\nI live near Springfield.  ', where: 'HIST 1700\n· Week One' });
  assert.deepStrictEqual(d, { text: 'Hi everyone,\n\nI live near Springfield.', where: 'HIST 1700 · Week One' });
  assert.deepStrictEqual(ctx.cleanDraft({ text: 'Just this' }), { text: 'Just this' });
  assert.strictEqual(ctx.cleanDraft({ text: '  ' }), undefined);
  assert.strictEqual(ctx.cleanDraft(null), undefined);
});

test('cleanOrdered: orders he placed himself, with their items, store and number', () => {
  const out = ctx.cleanOrdered([
    { store: 'Aldi (Instacart)', id: 'A-1', date: '2026-11-08', total: '$41.50', items: [{ name: 'Eggs, 12 ct', qty: 2, image: 'http://x/y.jpg', url: 'https://www.instacart.com/p/1', food: true, options: [{ name: 'other' }] }] },
    { store: '', items: [{ name: 'x' }] },          // no store
    { store: 'Walmart', items: [] },               // no items
    { store: 'Kroger', date: 'last week', items: [{ name: 'Milk' }] },
  ]);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out[0], { store: 'Aldi (Instacart)', id: 'A-1', date: '2026-11-08', total: 41.5,
    items: [{ name: 'Eggs, 12 ct', qty: 2, price: undefined, image: undefined, url: 'https://www.instacart.com/p/1', food: true }] });
  assert.strictEqual(out[1].date, undefined);
  assert.strictEqual(ctx.cleanOrdered(null), undefined);
  assert.strictEqual(ctx.cleanOrdered([{ store: 'x' }]), undefined);
});
