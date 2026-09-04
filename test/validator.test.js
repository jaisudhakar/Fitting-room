import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { defaultSelection, getProductBySlug } from '../src/modules/fitting-room/repository.js';
import { normalizeSelection, validateSelection } from '../src/modules/fitting-room/validator.js';

const product = getProductBySlug('beige-linen-shirt');
const base = (overrides = {}) =>
  normalizeSelection({ ...defaultSelection(product), ...overrides, options: { ...defaultSelection(product).options, ...(overrides.options ?? {}) } });

const codes = (result) => result.issues.map((issue) => issue.code);

describe('normalizeSelection', () => {
  it('coerces monogram text to upper case and measurements to numbers', () => {
    const selection = normalizeSelection({
      options: { size: ' m ' },
      measurements: { chest: '100' },
      monogram: { text: ' jd ', position: 'chest-left' },
      quantity: '3',
    });

    assert.equal(selection.options.size, 'm');
    assert.equal(selection.measurements.chest, 100);
    assert.equal(selection.monogram.text, 'JD');
    assert.equal(selection.quantity, 3);
  });

  it('treats monogram.enabled === false as no monogram', () => {
    assert.equal(normalizeSelection({ monogram: { enabled: false, text: 'JD' } }).monogram, null);
  });

  it('defaults an empty payload to a quantity of one', () => {
    assert.deepEqual(normalizeSelection(), { options: {}, measurements: null, monogram: null, quantity: 1 });
  });
});

describe('validateSelection', () => {
  it('accepts the product defaults', () => {
    assert.equal(validateSelection(product, base()).valid, true);
  });

  it('rejects a value that is not in the catalogue', () => {
    const result = validateSelection(product, base({ options: { fabric: 'silk-twill' } }));
    assert.equal(result.valid, false);
    assert.deepEqual(codes(result), ['invalid_option_value']);
    assert.ok(result.issues[0].allowed.includes('beige-linen-160'));
  });

  it('rejects a group the product does not customise', () => {
    const trousers = getProductBySlug('stone-linen-trousers');
    const result = validateSelection(trousers, normalizeSelection({ ...defaultSelection(trousers), options: { ...defaultSelection(trousers).options, collar: 'classic' } }));
    assert.deepEqual(codes(result), ['unknown_option_group']);
  });

  it('reports a missing required option', () => {
    const selection = base();
    delete selection.options.collar;
    assert.deepEqual(codes(validateSelection(product, selection)), ['missing_option']);
  });

  it('enforces the short-sleeve / cuff rule', () => {
    const result = validateSelection(product, base({ options: { sleeve: 'short' } }));
    assert.deepEqual(codes(result), ['rule_violation']);
    assert.equal(result.issues[0].rule, 'short-sleeve-has-no-cuff');
  });

  it('accepts a short sleeve without a cuff', () => {
    assert.equal(validateSelection(product, base({ options: { sleeve: 'short', cuff: 'none' } })).valid, true);
  });

  it('only offers double pockets on roomier blocks', () => {
    assert.equal(validateSelection(product, base({ options: { pocket: 'double-patch' } })).valid, false);
    assert.equal(
      validateSelection(product, base({ options: { pocket: 'double-patch', fit: 'relaxed' } })).valid,
      true,
    );
  });

  it('skips rules whose groups the product does not offer', () => {
    const trousers = getProductBySlug('stone-linen-trousers');
    // The trousers have no sleeve or cuff group, so the sleeve rules must not fire.
    const result = validateSelection(trousers, normalizeSelection(defaultSelection(trousers)));
    assert.equal(result.valid, true);
  });

  it('requires every measurement for made to measure', () => {
    const result = validateSelection(product, base({ options: { size: 'made-to-measure' } }));
    assert.equal(result.issues.length, 7);
    assert.ok(result.issues.every((issue) => issue.code === 'missing_measurement'));
  });

  it('range-checks measurements and rejects unknown ones', () => {
    const result = validateSelection(
      product,
      base({
        options: { size: 'made-to-measure' },
        measurements: { neck: 39, chest: 300, waist: 88, hips: 99, shoulder: 46, sleeveLength: 64, shirtLength: 76, tail: 12 },
      }),
    );
    assert.deepEqual(codes(result).sort(), ['measurement_out_of_range', 'unknown_measurement']);
  });

  it('warns instead of failing when measurements are sent with a stock size', () => {
    const result = validateSelection(product, base({ measurements: { chest: 100 } }));
    assert.equal(result.valid, true);
    assert.deepEqual(result.warnings.map((warning) => warning.code), ['measurements_ignored']);
  });

  it('checks the monogram text, position, font and thread', () => {
    const result = validateSelection(
      product,
      base({ monogram: { text: 'JOHNNY', position: 'sleeve-hem', font: 'comic', thread: 'lime' } }),
    );
    assert.deepEqual(codes(result).sort(), [
      'invalid_monogram_font',
      'invalid_monogram_position',
      'invalid_monogram_text',
      'invalid_monogram_thread',
    ]);
  });

  it('refuses a cuff monogram on a short sleeve', () => {
    const result = validateSelection(
      product,
      base({ options: { sleeve: 'short', cuff: 'none' }, monogram: { text: 'JD', position: 'cuff-left', font: 'script', thread: 'navy' } }),
    );
    assert.deepEqual(codes(result), ['invalid_monogram_position']);
  });

  it('refuses a monogram on a product that does not offer one', () => {
    const trousers = getProductBySlug('stone-linen-trousers');
    const selection = normalizeSelection({
      ...defaultSelection(trousers),
      monogram: { text: 'JD', position: 'hem-left', font: 'script', thread: 'navy' },
    });
    assert.deepEqual(codes(validateSelection(trousers, selection)), ['monogram_unavailable']);
  });

  it('bounds the quantity', () => {
    assert.deepEqual(codes(validateSelection(product, base({ quantity: 0 }))), ['invalid_quantity']);
    assert.deepEqual(codes(validateSelection(product, base({ quantity: 999 }))), ['invalid_quantity']);
  });
});
