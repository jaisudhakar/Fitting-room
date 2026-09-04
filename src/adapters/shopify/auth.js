import { createHmac, timingSafeEqual } from 'node:crypto';

import { FittingRoomError } from '../../modules/fitting-room/errors.js';
import { shopifyConfig } from './config.js';

export class UnauthorizedError extends FittingRoomError {
  constructor(message = 'This request did not come from Shopify.') {
    super(message, { status: 401, code: 'unauthorized' });
  }
}

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Verify an app proxy request.
 *
 * Shopify signs the query string: drop `signature`, sort the remaining
 * `key=value` pairs (repeated values joined with commas), concatenate them with
 * no separator, and HMAC-SHA256 with the app secret.
 *
 * @param {URLSearchParams} query
 * @param {{secret?: string}} [options]
 */
export const verifyAppProxySignature = (query, { secret = shopifyConfig.appSecret } = {}) => {
  if (!secret) throw new UnauthorizedError('The app secret is not configured, so proxy requests cannot be verified.');

  const signature = query.get('signature');
  if (!signature) throw new UnauthorizedError('The request carries no signature.');

  const grouped = new Map();
  for (const [key, value] of query) {
    if (key === 'signature') continue;
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }

  const message = [...grouped.entries()]
    .map(([key, values]) => `${key}=${values.join(',')}`)
    .sort()
    .join('');

  const expected = createHmac('sha256', secret).update(message).digest('hex');
  if (!safeEqual(signature, expected)) throw new UnauthorizedError();

  return { shop: query.get('shop'), loggedInCustomerId: query.get('logged_in_customer_id') || null };
};

/**
 * Verify a webhook: base64 HMAC-SHA256 of the raw body in `x-shopify-hmac-sha256`.
 *
 * @param {Buffer|string} rawBody
 * @param {string} headerValue
 */
export const verifyWebhookHmac = (rawBody, headerValue, { secret = shopifyConfig.appSecret } = {}) => {
  if (!secret) throw new UnauthorizedError('The app secret is not configured, so webhooks cannot be verified.');
  if (!headerValue) throw new UnauthorizedError('The webhook carries no HMAC header.');

  const expected = createHmac('sha256', secret).update(Buffer.from(rawBody)).digest('base64');
  if (!safeEqual(headerValue, expected)) throw new UnauthorizedError('The webhook HMAC does not match.');

  return true;
};

/**
 * Sign a priced make-up so the cart can be checked for tampering later. Cart
 * line properties are written by the browser, so the price that reaches the
 * cart is only trustworthy if it comes back with this signature intact.
 */
export const signMakeUp = (payload, { secret = shopifyConfig.appSecret } = {}) =>
  createHmac('sha256', secret).update(canonical(payload)).digest('hex').slice(0, 32);

export const verifyMakeUpSignature = (payload, signature, { secret = shopifyConfig.appSecret } = {}) =>
  Boolean(signature) && safeEqual(signature, signMakeUp(payload, { secret }));

/** Stable string for a payload, so the signature does not depend on key order. */
const canonical = ({ key, unitPrice, quantity = 1, currency }) => `${key}|${unitPrice}|${quantity}|${currency}`;
