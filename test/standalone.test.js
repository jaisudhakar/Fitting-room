import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PAGE,
  createApp,
  estimateMeasurements,
  getFittingRoom,
  getProductBySlug,
  normalizeSelection,
  previewSelection,
  priceSelection,
  recommendSize,
  validateSelection,
} from '../standalone/fitting-room.js';

/** Boot the single-file app on an ephemeral port for the HTTP tests. */
const withServer = async (run) => {
  const { server } = createApp({ sweepIntervalMs: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const json = async (base, path, { method = 'GET', body } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const shirt = () => getProductBySlug('beige-linen-shirt');

const makeUp = ({ options, ...rest } = {}) =>
  normalizeSelection({
    options: {
      size: 'm', fit: 'tailored', fabric: 'beige-linen-160', collar: 'classic', sleeve: 'long',
      cuff: 'barrel-single', placket: 'standard', pocket: 'none', buttons: 'corozo-natural', hem: 'curved',
      ...options,
    },
    ...rest,
  });

test('the default make-up is valid and priced at the base price', () => {
  const room = getFittingRoom('beige-linen-shirt');
  const { validation, price } = previewSelection('beige-linen-shirt', room.defaultSelection);
  assert.equal(validation.valid, true);
  assert.equal(price.unitPrice, 8900);
  assert.equal(price.tax, 1780);
  assert.equal(price.total, 10680);
  assert.equal(price.leadTimeDays, 3);
});

test('option surcharges and lead times accumulate', () => {
  const price = priceSelection(shirt(), makeUp({
    options: { fabric: 'belgian-linen-180', cuff: 'french', buttons: 'mother-of-pearl' },
    monogram: { enabled: true, text: 'JS', position: 'cuff-left', font: 'script', thread: 'navy' },
  }), { now: new Date('2026-01-01T00:00:00Z') });

  // 8900 + 3500 fabric + 1200 cuff + 1400 buttons + 1200 monogram
  assert.equal(price.unitPrice, 16200);
  // 3 base + 4 fabric + 1 cuff + 1 buttons + 2 monogram
  assert.equal(price.leadTimeDays, 11);
  assert.equal(price.estimatedShipDate, '2026-01-12');
});

test('a short sleeve cannot take a cuff', () => {
  const result = validateSelection(shirt(), makeUp({ options: { sleeve: 'short' } }));
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].rule, 'short-sleeve-has-no-cuff');
});

test('a made-to-measure order needs all seven measurements in range', () => {
  const missing = validateSelection(shirt(), makeUp({ options: { size: 'made-to-measure' } }));
  assert.equal(missing.issues.length, 7);
  assert.ok(missing.issues.every((item) => item.code === 'missing_measurement'));

  const complete = validateSelection(shirt(), makeUp({
    options: { size: 'made-to-measure' },
    measurements: { neck: 40, chest: 102, waist: 88, hips: 100, shoulder: 46, sleeveLength: 64, shirtLength: 74 },
  }));
  assert.equal(complete.valid, true);

  const outOfRange = validateSelection(shirt(), makeUp({
    options: { size: 'made-to-measure' },
    measurements: { neck: 40, chest: 300, waist: 88, hips: 100, shoulder: 46, sleeveLength: 64, shirtLength: 74 },
  }));
  assert.equal(outOfRange.issues[0].code, 'measurement_out_of_range');
});

test('a cuff monogram needs a long sleeve, and the text must be one to four letters', () => {
  const badText = validateSelection(shirt(), makeUp({
    monogram: { enabled: true, text: 'TOOLONG', position: 'chest-left', font: 'script', thread: 'navy' },
  }));
  assert.equal(badText.issues[0].code, 'invalid_monogram_text');

  const badPosition = validateSelection(shirt(), makeUp({
    options: { sleeve: 'short', cuff: 'none' },
    monogram: { enabled: true, text: 'JS', position: 'cuff-left', font: 'script', thread: 'navy' },
  }));
  assert.ok(badPosition.issues.some((item) => item.code === 'invalid_monogram_position'));
});

test('the trousers hide the groups they do not offer', () => {
  const room = getFittingRoom('stone-linen-trousers');
  assert.deepEqual(room.groups.map((group) => group.id), ['size', 'fit', 'fabric', 'buttons', 'hem']);
  assert.equal(room.monogram.enabled, false);
  assert.deepEqual(room.groups.find((group) => group.id === 'fit').values.map((v) => v.id), ['tailored', 'relaxed', 'oversized']);
});

test('the size recommender answers with a size, a confidence and its reasoning', () => {
  const result = recommendSize(shirt(), { heightCm: 178, weightKg: 78, bodyType: 'regular', fitPreference: 'regular' });
  assert.equal(result.recommendedSize, 'm');
  assert.ok(result.confidence > 0.5);
  assert.ok(result.rationale.length >= 3);

  const measured = recommendSize(shirt(), { heightCm: 186, weightKg: 95, chestCm: 114 });
  assert.equal(measured.recommendedSize, 'xl');
  assert.ok(measured.confidence >= 0.7);

  assert.throws(() => recommendSize(shirt(), { heightCm: 90, weightKg: 78 }), /body profile is not valid/);
});

test('measurement estimates move with weight and build', () => {
  const light = estimateMeasurements({ heightCm: 178, weightKg: 65, bodyType: 'slim' });
  const heavy = estimateMeasurements({ heightCm: 178, weightKg: 95, bodyType: 'broad' });
  assert.ok(heavy.chest > light.chest + 15);
});

test('the API serves the page, the catalogue and a live quote', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal((await page.text()).length, PAGE.length);

    const products = await json(base, '/api/products');
    assert.equal(products.body.products.length, 2);

    const room = await json(base, '/api/products/beige-linen-shirt/fitting-room');
    assert.equal(room.status, 200);
    assert.equal(room.body.product.formattedBasePrice, '€89.00');

    const quote = await json(base, '/api/products/beige-linen-shirt/fitting-room/quote', {
      method: 'POST',
      body: { options: { ...room.body.defaultSelection.options, fabric: 'belgian-linen-180' } },
    });
    assert.equal(quote.body.price.unitPrice, 12400);
    assert.equal(quote.body.validation.valid, true);

    const size = await json(base, '/api/products/beige-linen-shirt/fitting-room/size-recommendation', {
      method: 'POST',
      body: { heightCm: 178, weightKg: 78 },
    });
    assert.equal(size.body.recommendedSize, 'm');

    const missing = await json(base, '/api/products/nope/fitting-room');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not_found');
  });
});

test('a strict quote refuses a make-up that cannot be manufactured', async () => {
  await withServer(async (base) => {
    const strict = await json(base, '/api/products/beige-linen-shirt/fitting-room/quote?strict=true', {
      method: 'POST',
      body: { options: { size: 'm', fit: 'tailored', fabric: 'beige-linen-160', collar: 'classic', sleeve: 'short',
        cuff: 'french', placket: 'standard', pocket: 'none', buttons: 'corozo-natural', hem: 'curved' } },
    });
    assert.equal(strict.status, 422);
    assert.equal(strict.body.error.code, 'invalid_selection');
  });
});

test('a draft session survives edits and turns into a basket line', async () => {
  await withServer(async (base) => {
    const started = await json(base, '/api/products/beige-linen-shirt/fitting-room/sessions', { method: 'POST', body: {} });
    assert.equal(started.status, 201);
    const id = started.body.session.id;
    assert.equal(started.body.readyToAdd, true);

    const broken = await json(base, `/api/fitting-room/sessions/${id}`, {
      method: 'PATCH',
      body: { options: { sleeve: 'short' } },
    });
    assert.equal(broken.body.readyToAdd, false);
    assert.equal(broken.body.validation.issues[0].rule, 'short-sleeve-has-no-cuff');

    const fixed = await json(base, `/api/fitting-room/sessions/${id}`, {
      method: 'PATCH',
      body: { options: { cuff: 'none' }, monogram: { enabled: true, text: 'js', position: 'chest-left', font: 'script', thread: 'navy' } },
    });
    assert.equal(fixed.body.readyToAdd, true);
    assert.equal(fixed.body.selection.monogram.text, 'JS');
    // 8900 − 800 short sleeve + 1200 monogram
    assert.equal(fixed.body.price.unitPrice, 9300);

    const reread = await json(base, `/api/fitting-room/sessions/${id}`);
    assert.equal(reread.body.selection.options.cuff, 'none');

    const completed = await json(base, `/api/fitting-room/sessions/${id}/complete`, { method: 'POST' });
    assert.equal(completed.status, 201);
    assert.equal(completed.body.cartLine.unitPrice, 9300);
    assert.match(completed.body.cartLine.variantKey, /^[0-9a-f]{16}$/);
    assert.ok(completed.body.summary.some((line) => line.label === 'Monogram'));

    // Completing the draft closes it.
    const gone = await json(base, `/api/fitting-room/sessions/${id}`);
    assert.equal(gone.status, 404);
  });
});

test('identical make-ups share a variant key, different ones do not', async () => {
  await withServer(async (base) => {
    const add = (options) => json(base, '/api/products/beige-linen-shirt/fitting-room/add-to-cart', { method: 'POST', body: { options } });
    const base10 = { size: 'm', fit: 'tailored', fabric: 'beige-linen-160', collar: 'classic', sleeve: 'long',
      cuff: 'barrel-single', placket: 'standard', pocket: 'none', buttons: 'corozo-natural', hem: 'curved' };

    const first = await add(base10);
    const same = await add({ ...base10 });
    const different = await add({ ...base10, collar: 'cutaway' });

    assert.equal(first.status, 201);
    assert.equal(first.body.cartLine.variantKey, same.body.cartLine.variantKey);
    assert.notEqual(first.body.cartLine.variantKey, different.body.cartLine.variantKey);
  });
});

test('the router reports unknown routes and wrong methods honestly', async () => {
  await withServer(async (base) => {
    const notFound = await json(base, '/api/nothing-here');
    assert.equal(notFound.status, 404);

    const wrongMethod = await json(base, '/api/products', { method: 'POST', body: {} });
    assert.equal(wrongMethod.status, 405);
    assert.deepEqual(wrongMethod.body.error.details[0].allow, ['GET']);

    const badJson = await fetch(`${base}/api/products/beige-linen-shirt/fitting-room/quote`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
    });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error.code, 'invalid_json');
  });
});
