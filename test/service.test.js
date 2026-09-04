import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { NotFoundError, ValidationError } from '../src/modules/fitting-room/errors.js';
import { InMemorySessionStore, setSessionStore, sweepSessions } from '../src/modules/fitting-room/session.js';
import * as service from '../src/modules/fitting-room/service.js';

const madeToMeasureBody = {
  neck: 39,
  chest: 100,
  waist: 88,
  hips: 99,
  shoulder: 46,
  sleeveLength: 64,
  shirtLength: 76,
};

beforeEach(() => setSessionStore(new InMemorySessionStore()));

describe('getFittingRoom', () => {
  it('returns the steps, groups, catalogues and an opening price', () => {
    const room = service.getFittingRoom('beige-linen-shirt');

    assert.equal(room.product.slug, 'beige-linen-shirt');
    assert.deepEqual(room.steps.map((step) => step.id), ['size', 'fit', 'fabric', 'details', 'monogram', 'review']);
    assert.equal(room.groups.length, 10);
    assert.equal(room.monogram.enabled, true);
    assert.equal(room.madeToMeasure.fields.length, 7);
    assert.equal(room.price.unitPrice, room.product.basePrice);
  });

  it('formats the surcharge shown next to each option', () => {
    const fabric = service.getFittingRoom('beige-linen-shirt').groups.find((group) => group.id === 'fabric');
    assert.equal(fabric.values.find((value) => value.id === 'beige-linen-160').formattedPriceDelta, null);
    assert.ok(fabric.values.find((value) => value.id === 'belgian-linen-180').formattedPriceDelta.startsWith('+'));
    assert.ok(fabric.values.find((value) => value.id === 'linen-cotton-blend').formattedPriceDelta.startsWith('−'));
  });

  it('hides the monogram step on a product that does not offer one', () => {
    const room = service.getFittingRoom('stone-linen-trousers');
    assert.equal(room.monogram.enabled, false);
    assert.ok(!room.steps.some((step) => step.id === 'monogram'));
  });

  it('refuses an unknown product', () => {
    assert.throws(() => service.getFittingRoom('no-such-product'), NotFoundError);
  });
});

describe('quoteSelection', () => {
  it('prices a valid make-up', () => {
    const { price } = service.quoteSelection('beige-linen-shirt', {
      options: { size: 'l', fit: 'tailored', fabric: 'stone-washed-linen', collar: 'cutaway', sleeve: 'long', cuff: 'french', placket: 'standard', pocket: 'none', buttons: 'horn-dark', hem: 'curved' },
      quantity: 2,
    });
    assert.equal(price.customisationTotal, 1500 + 500 + 1200 + 900);
    assert.equal(price.quantity, 2);
  });

  it('throws with every issue listed when the make-up is impossible', () => {
    assert.throws(
      () => service.quoteSelection('beige-linen-shirt', { options: { sleeve: 'short', cuff: 'french' } }),
      (error) => {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.status, 422);
        assert.ok(error.details.some((detail) => detail.code === 'rule_violation'));
        return true;
      },
    );
  });
});

describe('previewSelection', () => {
  it('still prices an invalid make-up so the UI can update live', () => {
    const { price, validation } = service.previewSelection('beige-linen-shirt', {
      options: { size: 'made-to-measure', fit: 'tailored', fabric: 'beige-linen-160', collar: 'classic', sleeve: 'long', cuff: 'french', placket: 'standard', pocket: 'none', buttons: 'corozo-natural', hem: 'curved' },
    });
    assert.equal(validation.valid, false);
    assert.ok(price.unitPrice > 0);
  });
});

describe('fitting room sessions', () => {
  it('opens a draft on the product defaults', () => {
    const started = service.startSession('beige-linen-shirt');
    assert.match(started.session.id, /^frs_[0-9a-f]{32}$/);
    assert.equal(started.readyToAdd, true);
    assert.equal(started.selection.options.fabric, 'beige-linen-160');
    assert.ok(started.summary.length > 0);
  });

  it('merges patches instead of replacing the whole selection', () => {
    const { session } = service.startSession('beige-linen-shirt');
    const patched = service.updateSession(session.id, { options: { fabric: 'stone-washed-linen' } });

    assert.equal(patched.selection.options.fabric, 'stone-washed-linen');
    assert.equal(patched.selection.options.collar, 'classic');
    assert.equal(patched.price.customisationTotal, 1500);
  });

  it('accumulates measurements across patches and clears them with null', () => {
    const { session } = service.startSession('beige-linen-shirt');
    service.updateSession(session.id, { options: { size: 'made-to-measure' }, measurements: { neck: 39, chest: 100 } });
    const partial = service.updateSession(session.id, { measurements: { waist: 88 } });
    assert.deepEqual(partial.selection.measurements, { neck: 39, chest: 100, waist: 88 });
    assert.equal(partial.readyToAdd, false);

    const cleared = service.updateSession(session.id, { measurements: null });
    assert.equal(cleared.selection.measurements, null);
  });

  it('adds and removes the monogram', () => {
    const { session } = service.startSession('beige-linen-shirt');
    const withMonogram = service.updateSession(session.id, {
      monogram: { text: 'jd', position: 'cuff-left', font: 'script', thread: 'navy' },
    });
    assert.equal(withMonogram.selection.monogram.text, 'JD');
    assert.equal(withMonogram.price.customisationTotal, 1200);

    const without = service.updateSession(session.id, { monogram: null });
    assert.equal(without.selection.monogram, null);
    assert.equal(without.price.customisationTotal, 0);
  });

  it('reports why a draft is not ready to add', () => {
    const { session } = service.startSession('beige-linen-shirt');
    const state = service.updateSession(session.id, { options: { sleeve: 'short' } });
    assert.equal(state.readyToAdd, false);
    assert.equal(state.validation.issues[0].rule, 'short-sleeve-has-no-cuff');
  });

  it('completes into a cart line and closes the draft', () => {
    const { session } = service.startSession('beige-linen-shirt');
    service.updateSession(session.id, {
      options: { size: 'made-to-measure', fabric: 'belgian-linen-180' },
      measurements: madeToMeasureBody,
      monogram: { text: 'JD', position: 'chest-left', font: 'block-sans', thread: 'ivory' },
      quantity: 2,
    });

    const { cartLine, summary } = service.completeSession(session.id);
    assert.equal(cartLine.slug, 'beige-linen-shirt');
    assert.equal(cartLine.quantity, 2);
    assert.equal(cartLine.customisation.monogram.text, 'JD');
    assert.deepEqual(cartLine.customisation.measurements, madeToMeasureBody);
    assert.ok(cartLine.leadTimeDays >= 15);
    assert.ok(summary.some((line) => line.label === 'Monogram'));
    assert.throws(() => service.getSession(session.id), NotFoundError);
  });

  it('refuses to complete a draft that breaks a rule', () => {
    const { session } = service.startSession('beige-linen-shirt');
    service.updateSession(session.id, { options: { sleeve: 'short' } });
    assert.throws(() => service.completeSession(session.id), ValidationError);
    // the draft survives so the shopper can fix it
    assert.equal(service.getSession(session.id).session.id, session.id);
  });

  it('gives identical make-ups the same variant key and different ones a different key', () => {
    const first = service.addToCart('beige-linen-shirt', service.startSession('beige-linen-shirt').selection);
    const second = service.addToCart('beige-linen-shirt', service.startSession('beige-linen-shirt').selection);
    const third = service.addToCart('beige-linen-shirt', {
      ...service.startSession('beige-linen-shirt').selection,
      options: { ...service.startSession('beige-linen-shirt').selection.options, fabric: 'stone-washed-linen' },
    });

    assert.equal(first.cartLine.variantKey, second.cartLine.variantKey);
    assert.notEqual(first.cartLine.variantKey, third.cartLine.variantKey);
  });

  it('forgets an abandoned draft', () => {
    const { session } = service.startSession('beige-linen-shirt');
    assert.deepEqual(service.abandonSession(session.id), { deleted: true, id: session.id });
    assert.throws(() => service.getSession(session.id), NotFoundError);
  });

  it('expires drafts and sweeps them away', () => {
    const store = new InMemorySessionStore();
    setSessionStore(store);
    const { session } = service.startSession('beige-linen-shirt');
    assert.equal(store.size, 1);
    assert.equal(sweepSessions(Date.now() + 1000 * 60 * 60 * 25), 1);
    assert.equal(store.size, 0);
    assert.throws(() => service.getSession(session.id), NotFoundError);
  });
});
