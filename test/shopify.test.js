import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { createAdminClient } from '../src/adapters/shopify/adminClient.js';
import {
  UnauthorizedError,
  signMakeUp,
  verifyAppProxySignature,
  verifyMakeUpSignature,
  verifyWebhookHmac,
} from '../src/adapters/shopify/auth.js';
import { PROPERTY, auditLineItem, buildLineItemProperties } from '../src/adapters/shopify/lineItems.js';
import { toMetafieldConfig, toMinorUnits, toModuleProduct, toShopifyAmount } from '../src/adapters/shopify/productMapper.js';
import { createShopifyProductSource } from '../src/adapters/shopify/productSource.js';
import { auditOrder, handleOrdersCreate } from '../src/adapters/shopify/webhooks.js';
import { getProductBySlug } from '../src/modules/fitting-room/repository.js';
import * as fittingRoom from '../src/modules/fitting-room/service.js';
import { cartTransformRun } from '../shopify/extensions/fitting-room-pricing/src/run.js';

const SECRET = 'shpss_test_secret';

const signedQuery = (params, secret = SECRET) => {
  const query = new URLSearchParams(params);
  const grouped = new Map();
  for (const [key, value] of query) grouped.set(key, [...(grouped.get(key) ?? []), value]);
  const message = [...grouped.entries()].map(([key, values]) => `${key}=${values.join(',')}`).sort().join('');
  query.set('signature', createHmac('sha256', secret).update(message).digest('hex'));
  return query;
};

const shopifyProduct = (overrides = {}) => ({
  id: 'gid://shopify/Product/1',
  handle: 'beige-linen-shirt',
  title: 'Beige Linen Shirt',
  description: 'Washed European linen, cut in Portugal.\nMore copy here.',
  featuredImage: { url: 'https://cdn.shopify.com/shirt.jpg' },
  priceRangeV2: { minVariantPrice: { amount: '95.00', currencyCode: 'AUD' } },
  variants: { nodes: [{ id: 'gid://shopify/ProductVariant/11', price: '95.00' }] },
  metafield: {
    value: JSON.stringify({
      enabled: true,
      leadTimeDays: 4,
      sizeChartId: 'unisex-shirt-eu',
      monogram: { enabled: true },
      madeToMeasure: { enabled: true },
      groups: { size: { default: 'm' }, fit: { default: 'tailored' }, fabric: { default: 'beige-linen-160' } },
    }),
  },
  ...overrides,
});

describe('app proxy and webhook authentication', () => {
  it('accepts a request Shopify signed', () => {
    const query = signedQuery({ shop: 'tangelos.myshopify.com', path_prefix: '/apps/fitting-room', timestamp: '1317327555' });
    const result = verifyAppProxySignature(query, { secret: SECRET });
    assert.equal(result.shop, 'tangelos.myshopify.com');
  });

  it('joins repeated parameters with commas, as Shopify does', () => {
    const query = signedQuery([['extra', '1'], ['extra', '2'], ['shop', 'x.myshopify.com'], ['timestamp', '1317327555']]);
    assert.doesNotThrow(() => verifyAppProxySignature(query, { secret: SECRET }));
  });

  it('rejects a tampered parameter, a missing signature and the wrong secret', () => {
    const query = signedQuery({ shop: 'x.myshopify.com', timestamp: '1317327555' });
    query.set('shop', 'evil.myshopify.com');
    assert.throws(() => verifyAppProxySignature(query, { secret: SECRET }), UnauthorizedError);

    query.delete('signature');
    assert.throws(() => verifyAppProxySignature(query, { secret: SECRET }), UnauthorizedError);

    assert.throws(
      () => verifyAppProxySignature(signedQuery({ shop: 'x.myshopify.com' }), { secret: 'another-secret' }),
      UnauthorizedError,
    );
  });

  it('verifies a webhook over the raw body', () => {
    const body = JSON.stringify({ id: 1 });
    const hmac = createHmac('sha256', SECRET).update(body).digest('base64');
    assert.equal(verifyWebhookHmac(body, hmac, { secret: SECRET }), true);
    assert.throws(() => verifyWebhookHmac(`${body} `, hmac, { secret: SECRET }), UnauthorizedError);
    assert.throws(() => verifyWebhookHmac(body, '', { secret: SECRET }), UnauthorizedError);
  });

  it('signs a make-up so an edited price can be spotted', () => {
    const payload = { key: 'abc', unitPrice: 15300, quantity: 1, currency: 'AUD' };
    const signature = signMakeUp(payload, { secret: SECRET });
    assert.equal(verifyMakeUpSignature(payload, signature, { secret: SECRET }), true);
    assert.equal(verifyMakeUpSignature({ ...payload, unitPrice: 100 }, signature, { secret: SECRET }), false);
    assert.equal(verifyMakeUpSignature(payload, 'not-a-signature', { secret: SECRET }), false);
  });
});

describe('mapping a Shopify product', () => {
  it('maps price, currency, image and the fitting room config', () => {
    const product = toModuleProduct(shopifyProduct());
    assert.equal(product.slug, 'beige-linen-shirt');
    assert.equal(product.basePrice, 9500);
    assert.equal(product.currency, 'AUD');
    assert.equal(product.leadTimeDays, 4);
    assert.equal(product.variantId, 'gid://shopify/ProductVariant/11');
    assert.equal(product.subtitle, 'Washed European linen, cut in Portugal.');
    assert.equal(product.fittingRoom.monogram.enabled, true);
  });

  it('treats a missing, disabled or malformed metafield as "no fitting room"', () => {
    assert.equal(toModuleProduct(shopifyProduct({ metafield: null })), null);
    assert.equal(toModuleProduct(shopifyProduct({ metafield: { value: '{"enabled":false}' } })), null);
    assert.equal(toModuleProduct(shopifyProduct({ metafield: { value: '{not json' } })), null);
    assert.equal(toModuleProduct(null), null);
  });

  it('converts money both ways without floating point drift', () => {
    assert.equal(toMinorUnits('95.00'), 9500);
    assert.equal(toMinorUnits('0.1'), 10);
    assert.equal(toShopifyAmount(15300), '153.00');
  });

  it('round-trips a module product back into a metafield value', () => {
    const config = toMetafieldConfig(getProductBySlug('beige-linen-shirt'));
    assert.equal(config.enabled, true);
    assert.equal(config.groups.fabric.default, 'beige-linen-160');
    assert.deepEqual(toModuleProduct(shopifyProduct({ metafield: { value: JSON.stringify(config) } })).fittingRoom.groups, config.groups);
  });
});

describe('the Shopify product source', () => {
  const clientReturning = (node, counter = { calls: 0 }) => ({
    request: async () => {
      counter.calls += 1;
      return { productByHandle: node };
    },
  });

  it('caches a product and serves it synchronously afterwards', async () => {
    const counter = { calls: 0 };
    const source = createShopifyProductSource({ client: clientReturning(shopifyProduct(), counter), ttlMs: 60000 });

    assert.equal(source.find('beige-linen-shirt'), null);
    await source.ensureProduct('beige-linen-shirt');
    assert.equal(source.find('beige-linen-shirt').title, 'Beige Linen Shirt');

    await source.ensureProduct('beige-linen-shirt');
    assert.equal(counter.calls, 1, 'a fresh product is not refetched');
  });

  it('refetches once the cache goes stale', async () => {
    const counter = { calls: 0 };
    let clock = 0;
    const source = createShopifyProductSource({
      client: clientReturning(shopifyProduct(), counter),
      ttlMs: 1000,
      now: () => clock,
    });

    await source.ensureProduct('beige-linen-shirt');
    clock = 5000;
    await source.ensureProduct('beige-linen-shirt');
    assert.equal(counter.calls, 2);
  });

  it('keeps serving a stale product when Shopify is down', async () => {
    let failing = false;
    const source = createShopifyProductSource({
      client: {
        request: async () => {
          if (failing) throw new Error('Shopify is down');
          return { productByHandle: shopifyProduct() };
        },
      },
      ttlMs: 0,
    });

    await source.ensureProduct('beige-linen-shirt');
    failing = true;
    const product = await source.ensureProduct('beige-linen-shirt');
    assert.equal(product.title, 'Beige Linen Shirt');
  });

  it('pages through every product when warming', async () => {
    const pages = [
      { products: { pageInfo: { hasNextPage: true, endCursor: 'a' }, nodes: [shopifyProduct()] } },
      { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [shopifyProduct({ handle: 'linen-trousers' })] } },
    ];
    const source = createShopifyProductSource({ client: { request: async () => pages.shift() } });
    assert.equal(await source.warm(), 2);
    assert.equal(source.size, 2);
  });
});

describe('the Admin client', () => {
  const client = (fetchImpl) =>
    createAdminClient({ shop: 'x.myshopify.com', adminToken: 't', fetchImpl, sleepImpl: async () => {} });

  const response = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name] ?? null },
    json: async () => body,
  });

  it('returns data on success', async () => {
    const data = await client(async () => response(200, { data: { shop: { name: 'Tangelos' } } })).request('{ shop { name } }');
    assert.equal(data.shop.name, 'Tangelos');
  });

  it('turns userErrors into a thrown error', async () => {
    await assert.rejects(
      () => client(async () => response(200, { data: { metafieldsSet: { userErrors: [{ message: 'Invalid value', code: 'INVALID' }] } } })).request('m'),
      (error) => {
        assert.equal(error.code, 'shopify_user_error');
        assert.equal(error.status, 422);
        return true;
      },
    );
  });

  it('retries a throttled request and then succeeds', async () => {
    let calls = 0;
    const data = await client(async () => {
      calls += 1;
      return calls === 1 ? response(429, {}, { 'retry-after': '0.01' }) : response(200, { data: { ok: true } });
    }).request('q');
    assert.equal(calls, 2);
    assert.equal(data.ok, true);
  });

  it('gives up after the retry budget', async () => {
    await assert.rejects(() => client(async () => response(500, {})).request('q'), (error) => {
      assert.equal(error.code, 'shopify_unavailable');
      return true;
    });
  });

  it('reports a bad access token as unauthorized', async () => {
    await assert.rejects(() => client(async () => response(401, { errors: [{ message: 'Invalid API key or access token' }] })).request('q'), (error) => {
      assert.equal(error.code, 'shopify_unauthorized');
      assert.equal(error.status, 401);
      return true;
    });
  });

  it('refuses to start without configuration', () => {
    assert.throws(() => createAdminClient({ shop: '', adminToken: '' }), /SHOPIFY_SHOP/);
  });
});

describe('cart line properties', () => {
  const makeUp = (overrides = {}) => {
    const draft = fittingRoom.startSession('beige-linen-shirt');
    return fittingRoom.updateSession(draft.session.id, overrides).selection;
  };

  it('carries the make-up in readable properties and the price in hidden ones', () => {
    const line = buildLineItemProperties('beige-linen-shirt', makeUp({ options: { fabric: 'stone-washed-linen' } }), { secret: SECRET });

    assert.equal(line.properties.Fabric, 'Stone-washed linen 170g');
    assert.equal(line.properties[PROPERTY.unit], String(line.price.unitPrice));
    assert.equal(line.properties[PROPERTY.delta], '1500');
    assert.ok(line.properties[PROPERTY.signature].length >= 16);
    assert.match(line.unitPriceAmount, /^\d+\.\d{2}$/);
  });

  it('attaches the drawn look when there is one', () => {
    const line = buildLineItemProperties('beige-linen-shirt', makeUp(), { lookUrl: 'https://cdn/look.png', secret: SECRET });
    assert.equal(line.properties[PROPERTY.look], 'https://cdn/look.png');
  });

  it('passes an honest line', () => {
    const line = buildLineItemProperties('beige-linen-shirt', makeUp({ options: { cuff: 'french' } }), { secret: SECRET });
    const audit = auditLineItem({ properties: line.properties, quantity: 1, handle: 'beige-linen-shirt' }, { secret: SECRET });
    assert.equal(audit.customised, true);
    assert.equal(audit.ok, true);
    assert.deepEqual(audit.reasons, []);
  });

  it('catches a price edited in the browser', () => {
    const line = buildLineItemProperties('beige-linen-shirt', makeUp(), { secret: SECRET });
    const tampered = { ...line.properties, [PROPERTY.unit]: '100' };
    const audit = auditLineItem({ properties: tampered, quantity: 1, handle: 'beige-linen-shirt' }, { secret: SECRET });

    assert.equal(audit.ok, false);
    assert.equal(audit.claimedUnitPrice, 100);
    assert.equal(audit.expectedUnitPrice, line.price.unitPrice);
    assert.ok(audit.reasons.some((reason) => reason.includes('prices at')));
    assert.ok(audit.reasons.some((reason) => reason.includes('signature')));
  });

  it('catches a make-up swapped for a dearer one under the same price', () => {
    const cheap = buildLineItemProperties('beige-linen-shirt', makeUp(), { secret: SECRET });
    const dear = buildLineItemProperties('beige-linen-shirt', makeUp({ options: { fabric: 'belgian-linen-180' } }), { secret: SECRET });
    const swapped = { ...cheap.properties, [PROPERTY.payload]: dear.properties[PROPERTY.payload] };

    const audit = auditLineItem({ properties: swapped, quantity: 1, handle: 'beige-linen-shirt' }, { secret: SECRET });
    assert.equal(audit.ok, false);
  });

  it('accepts Shopify\'s array-of-name-value property shape', () => {
    const line = buildLineItemProperties('beige-linen-shirt', makeUp(), { secret: SECRET });
    const asArray = Object.entries(line.properties).map(([name, value]) => ({ name, value }));
    assert.equal(auditLineItem({ properties: asArray, quantity: 1, handle: 'beige-linen-shirt' }, { secret: SECRET }).ok, true);
  });

  it('leaves an ordinary line alone', () => {
    const audit = auditLineItem({ properties: { Gift: 'yes' }, quantity: 1, handle: 'beige-linen-shirt' });
    assert.deepEqual(audit, { customised: false, ok: true, reasons: [], expectedUnitPrice: null, claimedUnitPrice: null });
  });
});

describe('the orders/create webhook', () => {
  const orderWith = (properties) => ({
    id: 4242,
    admin_graphql_api_id: 'gid://shopify/Order/4242',
    line_items: [{ id: 1, title: 'Beige Linen Shirt', quantity: 1, handle: 'beige-linen-shirt', properties }],
  });

  it('verifies the HMAC before it reads the body', async () => {
    const body = JSON.stringify(orderWith({}));
    await assert.rejects(
      () => handleOrdersCreate({ rawBody: body, headers: { 'x-shopify-hmac-sha256': 'wrong' }, secret: SECRET }),
      UnauthorizedError,
    );
  });

  it('passes a clean order and tags a tampered one', async () => {
    const draft = fittingRoom.startSession('beige-linen-shirt');
    const line = buildLineItemProperties('beige-linen-shirt', draft.selection, { secret: SECRET });

    const clean = await auditOrder(orderWith(line.properties), { secret: SECRET });
    assert.equal(clean.customisedLines, 1);
    assert.deepEqual(clean.mismatches, []);

    const tagged = [];
    const dirty = await auditOrder(orderWith({ ...line.properties, [PROPERTY.unit]: '1' }), {
      secret: SECRET,
      client: { request: async (_query, variables) => tagged.push(variables) },
    });
    assert.equal(dirty.mismatches.length, 1);
    assert.equal(dirty.tagged, true);
    assert.deepEqual(tagged[0].tags, ['fitting-room-price-mismatch']);
  });
});

describe('the cart transform function', () => {
  const line = (attributes, cost = '95.00', quantity = 1) => ({
    id: 'gid://shopify/CartLine/1',
    quantity,
    cost: { amountPerQuantity: { amount: cost } },
    ...attributes,
  });

  it('prices the line at what the fitting room quoted, and titles it', () => {
    const result = cartTransformRun({
      cart: { lines: [line({ unitPrice: { value: '15300' }, summary: { value: 'Fabric: Stone-washed linen 170g' } })] },
    });

    assert.deepEqual(result.operations, [
      {
        lineUpdate: {
          cartLineId: 'gid://shopify/CartLine/1',
          price: { adjustment: { fixedPricePerUnit: { amount: 153 } } },
          title: 'Fabric: Stone-washed linen 170g',
        },
      },
    ]);
  });

  it('leaves ordinary lines and already-correct lines alone', () => {
    assert.deepEqual(cartTransformRun({ cart: { lines: [line({})] } }), { operations: [] });
    assert.deepEqual(cartTransformRun({ cart: { lines: [line({ unitPrice: { value: '9500' } }, '95.00')] } }), { operations: [] });
    assert.deepEqual(cartTransformRun({ cart: { lines: [line({ unitPrice: { value: 'nonsense' } })] } }), { operations: [] });
    assert.deepEqual(cartTransformRun({ cart: { lines: [line({ unitPrice: { value: '-500' } })] } }), { operations: [] });
  });

  it('truncates a long title rather than letting Shopify reject it', () => {
    const summary = 'Fabric: Stone-washed linen 170g · Collar: Cutaway · Cuff: French cuff · Buttons: Mother of pearl · Hem: Straight hem';
    const [operation] = cartTransformRun({ cart: { lines: [line({ unitPrice: { value: '15300' }, summary: { value: summary } })] } }).operations;
    assert.equal(operation.lineUpdate.title.length, 100);
    assert.ok(operation.lineUpdate.title.endsWith('...'));
  });
});
