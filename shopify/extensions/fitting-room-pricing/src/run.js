// @ts-check
/**
 * Cart transform: charge what the fitting room quoted.
 *
 * The service prices a make-up and writes it onto the line as
 * `_fitting_room_unit` (minor units) and `_fitting_room_summary`. This function
 * turns that into the line's price and title, so the cart, the checkout and the
 * order all show the customised garment rather than the base product.
 *
 * It deliberately does no arithmetic of its own: pricing lives in one place,
 * `src/modules/fitting-room/pricing.js`. A function cannot verify the signature
 * on the line (no crypto, no network), so the orders/create webhook re-prices
 * every customised line and flags any that disagree.
 *
 * @typedef {import("../generated/api").Input} Input
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 * @typedef {import("../generated/api").Operation} Operation
 */

/** @type {CartTransformRunResult} */
const NO_CHANGES = { operations: [] };

/** Minor units on the line ("15300") to the shop's decimal amount (153.00). */
const toAmount = (minorUnits) => Math.round(minorUnits) / 100;

/** @param {Input['cart']['lines'][number]} line */
function buildUpdate(line) {
  const raw = line.unitPrice?.value;
  if (!raw) return null;

  const minorUnits = Number.parseInt(raw, 10);
  if (!Number.isFinite(minorUnits) || minorUnits <= 0) return null;

  const amount = toAmount(minorUnits);
  // Nothing to do when the line already costs what the make-up costs.
  if (amount === Number(line.cost.amountPerQuantity.amount)) return null;

  const summary = line.summary?.value;

  return {
    cartLineId: line.id,
    price: { adjustment: { fixedPricePerUnit: { amount } } },
    ...(summary ? { title: summary.length > 100 ? `${summary.slice(0, 97)}...` : summary } : {}),
  };
}

/**
 * @param {Input} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  const operations = input.cart.lines.reduce((acc, line) => {
    const lineUpdate = buildUpdate(line);
    return lineUpdate ? [...acc, { lineUpdate }] : acc;
  }, /** @type {Operation[]} */ ([]));

  return operations.length > 0 ? { operations } : NO_CHANGES;
}
