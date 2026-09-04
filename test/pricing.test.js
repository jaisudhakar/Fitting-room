import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import config from '../src/config/index.js';
import { formatMoney, priceSelection } from '../src/modules/fitting-room/pricing.js';
import { defaultSelection, getProductBySlug } from '../src/modules/fitting-room/repository.js';
import { normalizeSelection } from '../src/modules/fitting-room/validator.js';

const product = getProductBySlug('beige-linen-shirt');
const now = new Date('2026-09-04T00:00:00Z');
const price = (overrides = {}) =>
  priceSelection(
    product,
    normalizeSelection({
      ...defaultSelection(product),
      ...overrides,
      options: { ...defaultSelection(product).options, ...(overrides.options ?? {}) },
    }),
    { now },
  );

describe('priceSelection', () => {
  it('prices the default make-up at the base price', () => {
    const quote = price();
    assert.equal(quote.unitPrice, product.basePrice);
    assert.equal(quote.customisationTotal, 0);
    assert.deepEqual(quote.lines.map((line) => line.code), ['base']);
  });

  it('adds a line per surcharged option and leaves free options out', () => {
    const quote = price({ options: { fabric: 'belgian-linen-180', cuff: 'french', collar: 'classic' } });
    assert.deepEqual(quote.lines.map((line) => line.value), [null, 'belgian-linen-180', 'french']);
    assert.equal(quote.customisationTotal, 3500 + 1200);
    assert.equal(quote.unitPrice, product.basePrice + 4700);
  });

  it('applies a negative delta for a cheaper make-up', () => {
    const quote = price({ options: { fabric: 'linen-cotton-blend', sleeve: 'short', cuff: 'none' } });
    assert.equal(quote.customisationTotal, -1800);
    assert.equal(quote.unitPrice, product.basePrice - 1800);
  });

  it('charges the monogram fee once, whatever the quantity', () => {
    const quote = price({ monogram: { text: 'JD', position: 'chest-left', font: 'script', thread: 'navy' }, quantity: 3 });
    const monogramLines = quote.lines.filter((line) => line.code === 'monogram');
    assert.equal(monogramLines.length, 1);
    assert.equal(monogramLines[0].amount, 1200);
    assert.equal(quote.subtotal, quote.unitPrice * 3);
  });

  it('computes tax and total in integer minor units', () => {
    const quote = price({ quantity: 2 });
    assert.equal(quote.subtotal, product.basePrice * 2);
    assert.equal(quote.tax, Math.round(quote.subtotal * config.taxRate));
    assert.equal(quote.total, quote.subtotal + quote.tax);
    assert.ok(Number.isInteger(quote.tax));
  });

  it('accumulates lead time across the atelier steps', () => {
    const stock = price();
    assert.equal(stock.leadTimeDays, product.leadTimeDays);

    const madeToMeasure = price({
      options: { size: 'made-to-measure', fabric: 'belgian-linen-180', cuff: 'french' },
      monogram: { text: 'JD', position: 'cuff-left', font: 'script', thread: 'navy' },
    });
    // 3 stock + 10 made to measure + 4 Belgian linen + 1 French cuff + 2 monogram
    assert.equal(madeToMeasure.leadTimeDays, 20);
    assert.equal(madeToMeasure.estimatedShipDate, '2026-09-24');
  });

  it('formats every money field in the product currency', () => {
    const quote = price();
    assert.equal(quote.formatted.unitPrice, formatMoney(quote.unitPrice, 'EUR'));
    assert.ok(quote.formatted.total.includes('€'));
  });

  it('ignores options the product does not offer when pricing', () => {
    const quote = price({ options: { collar: 'not-a-collar' } });
    assert.equal(quote.unitPrice, product.basePrice);
  });
});
