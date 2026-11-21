const assert = require('node:assert/strict');
const test = require('node:test');
const invoice = require('../lib/invoice');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

function recordOrder(items, coupon) {
  const db = { nextOrderId: 1001, orders: [] };
  const billed = pricing.computeTotals(items, coupon);
  const order = orders.add(db, { date: '2021-11-30', items, coupon, ...billed });
  return { db, billed, order, figures: invoice.computeInvoiceFigures(order) };
}

test('printed invoice agrees with checkout for mixed GST slabs and a capped coupon', () => {
  const { order, figures } = recordOrder([
    { name: 'Rice', hsn: '1006', price: 640, qty: 3 },
    { name: 'Butter', hsn: '0405', price: 260, qty: 1 }
  ], 'SAVE10');

  assert.deepEqual([order.discount, order.tax, order.total], [150, 118.44, 2148.44]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [150, 118.44, 2148.44]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('default-rate order without a coupon matches the invoice', () => {
  const { order, figures } = recordOrder([{ name: 'Tea', price: 100, qty: 2 }]);

  assert.equal(order.total, 236);
  assert.deepEqual(figures, {
    subtotal: 200, discount: 0, tax: 36, cgst: 18, sgst: 18, total: 236,
    rows: [{ name: 'Tea', sku: '-', hsn: '-', qty: 2, price: 100,
      gstPercent: 18, line: 200, lineTax: 36 }]
  });
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice applies each HSN GST slab', () => {
  const { billed, order, figures } = recordOrder([
    { name: 'Rice', hsn: '1006', price: 100, qty: 1 },
    { name: 'Ghee', hsn: '0405', price: 100, qty: 1 }
  ]);

  assert.deepEqual(billed.lines.map(({ gstPercent, tax }) => [gstPercent, tax]), [[5, 5], [12, 12]]);
  assert.deepEqual([order.tax, billed.cgst, billed.sgst, order.total], [17, 8.5, 8.5, 217]);
  assert.deepEqual(figures.rows.map(({ hsn, gstPercent, lineTax }) => [hsn, gstPercent, lineTax]), [
    ['1006', 5, 5], ['0405', 12, 12]
  ]);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [17, 8.5, 8.5, 217]);

  const html = invoice.render(order);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">[^<]*17\.00<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">[^<]*217\.00<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice applies capped percentage discounts before GST', () => {
  const { billed, order, figures } = recordOrder([
    { name: 'Tea', price: 1000, qty: 1 },
    { name: 'Coffee', price: 1000, qty: 1 }
  ], 'SAVE10');

  assert.deepEqual(billed.lines.map(({ discount, taxable, tax }) => [discount, taxable, tax]), [
    [75, 925, 166.5], [75, 925, 166.5]
  ]);
  assert.deepEqual([order.discount, order.tax, order.total], [150, 333, 2183]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [150, 333, 2183]);
});

test('invoice applies flat discounts before GST', () => {
  const { order, figures } = recordOrder([{ name: 'Tea', price: 300, qty: 1 }], 'FLAT50');

  assert.deepEqual([order.discount, order.tax, order.total], [50, 45, 295]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [50, 45, 295]);
});

test('invoice honors fractional and zero GST rates', () => {
  const { billed, order, figures } = recordOrder([
    { name: 'Fractional rate', price: 100, qty: 1, gstRate: 0.05 },
    { name: 'Zero rate', price: 100, qty: 1, gstRate: 0 }
  ]);

  assert.deepEqual(billed.lines.map(({ gstPercent, tax }) => [gstPercent, tax]), [[5, 5], [0, 0]]);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [[5, 5], [0, 0]]);
  assert.equal(order.total, 205);
  assert.equal(figures.total, 205);
});

test('invoice GST sums the rounded line taxes', () => {
  const { billed, order, figures } = recordOrder([
    { name: 'First item', price: 0.03, qty: 1 },
    { name: 'Second item', price: 0.03, qty: 1 }
  ]);

  assert.deepEqual(figures.rows.map(({ lineTax }) => lineTax), [0.01, 0.01]);
  assert.deepEqual([figures.tax, figures.cgst, figures.sgst, figures.total], [0.02, 0.01, 0.01, 0.08]);
  assert.deepEqual([order.tax, billed.cgst, billed.sgst, order.total], [0.02, 0.01, 0.01, 0.08]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('reconciliation matches when the invoice agrees with recorded GST and total', () => {
  const { db, order, figures } = recordOrder([{ name: 'Tea', price: 100, qty: 1 }], 'WELCOME');

  assert.deepEqual([order.discount, order.tax, order.total], [5, 17.1, 112.1]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [5, 17.1, 112.1]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
  assert.deepEqual(reports.getGstReconciliation(db), {
    totalChecked: 1,
    mismatchCount: 0,
    totalDelta: 0,
    rows: [{
      orderId: 1001, date: '2021-11-30', customer: 'Walk-in', coupon: 'WELCOME',
      ledgerSubtotal: 100, ledgerDiscount: 5, ledgerTax: 17.1, ledgerTotal: 112.1,
      invoiceDiscount: 5, invoiceTax: 17.1, invoiceTotal: 112.1, delta: 0, matched: true
    }]
  });
});
