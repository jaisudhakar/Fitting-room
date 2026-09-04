import { priceSelection } from '../../modules/fitting-room/pricing.js';
import { getProductBySlug } from '../../modules/fitting-room/repository.js';
import * as fittingRoom from '../../modules/fitting-room/service.js';
import { normalizeSelection } from '../../modules/fitting-room/validator.js';
import { signMakeUp, verifyMakeUpSignature } from './auth.js';
import { toShopifyAmount } from './productMapper.js';

/**
 * Cart line properties.
 *
 * Properties whose name starts with `_` are hidden from the customer; the rest
 * show in the cart, at checkout and on the order, which is exactly where the
 * make-up belongs. The hidden ones carry the machine-readable version plus a
 * signature, because the browser writes these properties and could lie about
 * the price.
 */
export const PROPERTY = {
  key: '_fitting_room_key',
  unit: '_fitting_room_unit',
  delta: '_fitting_room_delta',
  summary: '_fitting_room_summary',
  payload: '_fitting_room_payload',
  signature: '_fitting_room_sig',
  look: '_fitting_room_look',
  leadTime: '_fitting_room_lead_days',
};

/**
 * Build the properties for one customised line.
 *
 * @param {string} slug
 * @param {object} rawSelection
 * @param {{lookUrl?: string|null, secret?: string}} [options]
 */
export const buildLineItemProperties = (slug, rawSelection, { lookUrl = null, secret } = {}) => {
  const { product, selection, price } = fittingRoom.quoteSelection(slug, rawSelection);
  const summary = fittingRoom.summarize(product, selection);
  const key = fittingRoom.variantKey(product, selection);

  const signature = signMakeUp(
    { key, unitPrice: price.unitPrice, quantity: price.quantity, currency: price.currency },
    secret ? { secret } : undefined,
  );

  const visible = Object.fromEntries(summary.map((line) => [line.label, line.value]));

  return {
    properties: {
      ...visible,
      [PROPERTY.key]: key,
      [PROPERTY.unit]: String(price.unitPrice),
      [PROPERTY.delta]: String(price.customisationTotal),
      [PROPERTY.summary]: summary.map((line) => `${line.label}: ${line.value}`).join(' · '),
      [PROPERTY.payload]: JSON.stringify({
        options: selection.options,
        measurements: selection.measurements,
        monogram: selection.monogram,
      }),
      [PROPERTY.signature]: signature,
      [PROPERTY.leadTime]: String(price.leadTimeDays),
      ...(lookUrl ? { [PROPERTY.look]: lookUrl } : {}),
    },
    variantId: product.variantId ?? null,
    quantity: price.quantity,
    price,
    /** What the cart transform will charge per unit, in the shop's decimal format. */
    unitPriceAmount: toShopifyAmount(price.unitPrice),
  };
};

const propertiesToObject = (properties) => {
  if (Array.isArray(properties)) {
    return Object.fromEntries(properties.map((entry) => [entry.name ?? entry.key, entry.value]));
  }
  return properties ?? {};
};

/**
 * Recompute a line from its own properties and say whether it can be trusted.
 *
 * Two independent checks: the signature must match (so nothing was edited in
 * the browser), and re-pricing the make-up server-side must agree with the
 * price the line claims.
 *
 * @returns {{customised: boolean, ok: boolean, reasons: string[], expectedUnitPrice: number|null, claimedUnitPrice: number|null}}
 */
export const auditLineItem = (lineItem, { slug, secret } = {}) => {
  const properties = propertiesToObject(lineItem.properties);
  const key = properties[PROPERTY.key];
  if (!key) return { customised: false, ok: true, reasons: [], expectedUnitPrice: null, claimedUnitPrice: null };

  const reasons = [];
  const claimedUnitPrice = Number.parseInt(properties[PROPERTY.unit] ?? '', 10);
  const handle = slug ?? lineItem.handle ?? lineItem.product?.handle ?? null;

  let expectedUnitPrice = null;
  let currency = null;

  try {
    const product = getProductBySlug(handle);
    const selection = normalizeSelection({
      ...JSON.parse(properties[PROPERTY.payload] ?? '{}'),
      quantity: lineItem.quantity ?? 1,
    });
    const price = priceSelection(product, selection);
    expectedUnitPrice = price.unitPrice;
    currency = price.currency;

    if (fittingRoom.variantKey(product, selection) !== key) reasons.push('The make-up does not match its key.');
    if (expectedUnitPrice !== claimedUnitPrice) {
      reasons.push(`The line claims ${claimedUnitPrice} but the make-up prices at ${expectedUnitPrice}.`);
    }
  } catch (error) {
    reasons.push(`The make-up could not be re-priced: ${error.message}`);
  }

  const signed = verifyMakeUpSignature(
    { key, unitPrice: claimedUnitPrice, quantity: lineItem.quantity ?? 1, currency: currency ?? 'EUR' },
    properties[PROPERTY.signature],
    secret ? { secret } : undefined,
  );
  if (!signed) reasons.push('The signature on the line does not match.');

  return { customised: true, ok: reasons.length === 0, reasons, expectedUnitPrice, claimedUnitPrice };
};
