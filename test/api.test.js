import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { InMemorySessionStore, setSessionStore } from '../src/modules/fitting-room/session.js';

let server;
let baseUrl;

const request = async (method, path, body) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
};

before(async () => {
  setSessionStore(new InMemorySessionStore());
  ({ server } = createApp({ sweepIntervalMs: 0 }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

describe('fitting room API', () => {
  it('answers a health check', async () => {
    const { status, body } = await request('GET', '/api/fitting-room/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
  });

  it('lists the products with a fitting room', async () => {
    const { body } = await request('GET', '/api/products');
    assert.ok(body.products.some((product) => product.slug === 'beige-linen-shirt'));
  });

  it('serves the fitting room configuration', async () => {
    const { status, body } = await request('GET', '/api/products/beige-linen-shirt/fitting-room');
    assert.equal(status, 200);
    assert.equal(body.product.title, 'Beige Linen Shirt');
    assert.ok(body.groups.length > 0);
    assert.ok(body.sizeChart.sizes.length > 0);
  });

  it('404s an unknown product', async () => {
    const { status, body } = await request('GET', '/api/products/nope/fitting-room');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'not_found');
  });

  it('recommends a size', async () => {
    const { status, body } = await request('POST', '/api/products/beige-linen-shirt/fitting-room/size-recommendation', {
      heightCm: 178,
      weightKg: 75,
      bodyType: 'regular',
      fitPreference: 'regular',
    });
    assert.equal(status, 200);
    assert.equal(body.recommendedSize, 'm');
    assert.ok(body.confidence > 0);
  });

  it('400s an implausible body profile', async () => {
    const { status, body } = await request('POST', '/api/products/beige-linen-shirt/fitting-room/size-recommendation', {
      heightCm: 12,
      weightKg: 75,
    });
    assert.equal(status, 400);
    assert.equal(body.error.details[0].field, 'heightCm');
  });

  it('validates a make-up and reports the rule that failed', async () => {
    const { status, body } = await request('POST', '/api/products/beige-linen-shirt/fitting-room/validate', {
      options: { size: 'm', fit: 'tailored', fabric: 'beige-linen-160', collar: 'classic', sleeve: 'short', cuff: 'french', placket: 'standard', pocket: 'none', buttons: 'corozo-natural', hem: 'curved' },
    });
    assert.equal(status, 200);
    assert.equal(body.valid, false);
    assert.equal(body.issues[0].code, 'rule_violation');
  });

  it('quotes leniently by default and strictly on request', async () => {
    const payload = { options: { size: 'm', sleeve: 'short', cuff: 'french' } };
    const lenient = await request('POST', '/api/products/beige-linen-shirt/fitting-room/quote', payload);
    assert.equal(lenient.status, 200);
    assert.equal(lenient.body.validation.valid, false);
    assert.ok(lenient.body.price.total > 0);

    const strict = await request('POST', '/api/products/beige-linen-shirt/fitting-room/quote?strict=true', payload);
    assert.equal(strict.status, 422);
    assert.equal(strict.body.error.code, 'invalid_selection');
  });

  it('walks a session from draft to cart line', async () => {
    const created = await request('POST', '/api/products/beige-linen-shirt/fitting-room/sessions');
    assert.equal(created.status, 201);
    const { id } = created.body.session;

    const patched = await request('PATCH', `/api/fitting-room/sessions/${id}`, {
      options: { fabric: 'stone-washed-linen', cuff: 'french' },
      monogram: { text: 'jd', position: 'cuff-left', font: 'script', thread: 'navy' },
      quantity: 2,
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.readyToAdd, true);
    assert.equal(patched.body.selection.monogram.text, 'JD');

    const fetched = await request('GET', `/api/fitting-room/sessions/${id}`);
    assert.equal(fetched.body.selection.options.fabric, 'stone-washed-linen');

    const completed = await request('POST', `/api/fitting-room/sessions/${id}/complete`);
    assert.equal(completed.status, 201);
    assert.equal(completed.body.cartLine.quantity, 2);
    assert.ok(completed.body.cartLine.variantKey);

    const gone = await request('GET', `/api/fitting-room/sessions/${id}`);
    assert.equal(gone.status, 404);
  });

  it('adds to cart in one call', async () => {
    const { status, body } = await request('POST', '/api/products/beige-linen-shirt/fitting-room/add-to-cart', {
      options: { size: 'l', fit: 'tailored', fabric: 'beige-linen-160', collar: 'classic', sleeve: 'long', cuff: 'barrel-single', placket: 'standard', pocket: 'none', buttons: 'corozo-natural', hem: 'curved' },
    });
    assert.equal(status, 201);
    assert.equal(body.cartLine.customisation.options.size, 'l');
  });

  it('deletes an abandoned draft', async () => {
    const created = await request('POST', '/api/products/beige-linen-shirt/fitting-room/sessions');
    const { status } = await request('DELETE', `/api/fitting-room/sessions/${created.body.session.id}`);
    assert.equal(status, 200);
  });

  it('rejects a malformed JSON body', async () => {
    const response = await fetch(`${baseUrl}/api/products/beige-linen-shirt/fitting-room/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_json');
  });

  it('405s a known path with the wrong method', async () => {
    const { status, body } = await request('DELETE', '/api/products/beige-linen-shirt/fitting-room');
    assert.equal(status, 405);
    assert.deepEqual(body.error.details[0].allow, ['GET']);
  });

  it('404s an unknown path', async () => {
    const { status } = await request('GET', '/api/nothing-here');
    assert.equal(status, 404);
  });
});
