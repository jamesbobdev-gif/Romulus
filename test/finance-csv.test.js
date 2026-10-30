const test = require('node:test');
const assert = require('node:assert');
const C = require('../renderer/js/finance-csv');

test('a checking CSV with one Amount column and a balance', () => {
  const r = C.readCsv('Date,Description,Amount,Balance\n10/02/2026,"COFFEE, SHOP",-4.50,995.50\n10/01/2026,PAYROLL,1000.00,1000.00\n');
  assert.ok(r.ok);
  assert.strictEqual(r.transactions.length, 2);
  assert.strictEqual(r.transactions[0].description, 'COFFEE, SHOP');
  assert.strictEqual(r.transactions[0].amount, -4.5);
  assert.strictEqual(r.flipped, false);
  assert.strictEqual(r.balance, 995.5);
});

test('a card that lists charges as positive is flipped', () => {
  const rows = ['Transaction Date,Post Date,Description,Category,Amount'];
  for (let i = 1; i <= 6; i++) rows.push('2026-09-0' + i + ',2026-09-0' + i + ',Store ' + i + ',Shopping,' + (10 * i).toFixed(2));
  rows.push('2026-09-07,2026-09-07,Payment Thank You,,-100.00');
  const r = C.readCsv(rows.join('\r\n'));
  assert.ok(r.ok && r.flipped);
  assert.ok(r.transactions.filter((t) => t.description.startsWith('Store')).every((t) => t.amount < 0));
  assert.strictEqual(r.transactions.find((t) => t.description === 'Payment Thank You').amount, 100);
});

test('debit and credit columns, junk lines above the header, money formats', () => {
  const r = C.readCsv('Account: ****1234\n\n"Date","Details","Withdrawals","Deposits"\n"Oct 3, 2026","RENT","$1,200.00",""\n"Oct 4, 2026","REFUND","","(5.00)"\n');
  assert.ok(r.ok);
  const rent = r.transactions.find((t) => t.description === 'RENT');
  assert.strictEqual(rent.amount, -1200);
  assert.strictEqual(r.transactions.find((t) => t.description === 'REFUND').amount, 5);
});

test('the same file twice adds nothing; two identical charges both count', () => {
  const csv = 'Date,Description,Amount\n2026-10-01,Coffee,-3\n2026-10-01,Coffee,-3\n2026-10-02,Lunch,-12\n';
  const a = { transactions: [] };
  assert.strictEqual(C.addTo(a, C.readCsv(csv).transactions), 3);
  assert.strictEqual(C.addTo(a, C.readCsv(csv).transactions), 0);
  assert.strictEqual(a.transactions.length, 3);
});

test('dates and amounts', () => {
  assert.strictEqual(new Date(C.parseDate('25/03/2026') * 1000).getDate(), 25);
  assert.strictEqual(new Date(C.parseDate('3/5/26') * 1000).getMonth(), 2);
  assert.strictEqual(C.parseDate('not a date'), 0);
  assert.strictEqual(C.parseAmount('1.234,56'), 1234.56);
  assert.strictEqual(C.parseAmount('12.00 DR'), -12);
  assert.strictEqual(C.parseAmount(''), null);
});

test('a file without date and amount columns says so', () => {
  const r = C.readCsv('Name,Email\nA,b@c.d\n');
  assert.strictEqual(r.ok, false);
});
