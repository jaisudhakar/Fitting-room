import config from '../../config/index.js';
import { MONOGRAM_FEE, MONOGRAM_LEAD_TIME_DAYS, getMonogramPosition } from './catalog.js';
import { resolveGroups } from './repository.js';

/** Half-up rounding on integer minor units — never trust binary floats with money. */
const roundMinor = (amount) => Math.round(amount);

export const formatMoney = (amountMinor, currency = config.currency, locale = config.locale) =>
  new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amountMinor / 100);

const addDays = (date, days) => {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
};

/**
 * Price one customised garment.
 *
 * Lead times accumulate: every make-up step that needs extra work in the
 * atelier (special fabric, French cuff, monogram, made to measure) is added on
 * top of the product's stock lead time.
 *
 * @param {object} product
 * @param {{options: Record<string,string>, monogram: object|null, quantity: number}} selection
 * @param {{now?: Date}} [options]
 */
export const priceSelection = (product, selection, { now = new Date() } = {}) => {
  const groups = resolveGroups(product);
  const currency = product.currency ?? config.currency;
  const quantity = Number.isInteger(selection.quantity) && selection.quantity > 0 ? selection.quantity : 1;

  const lines = [
    { code: 'base', group: null, value: null, label: product.title, amount: product.basePrice },
  ];
  let leadTimeDays = product.leadTimeDays ?? config.baseLeadTimeDays;

  for (const group of groups) {
    const valueId = selection.options?.[group.id];
    if (!valueId) continue;

    const value = group.values.find((candidate) => candidate.id === valueId);
    if (!value) continue;

    leadTimeDays += value.leadTimeDays ?? 0;
    if (value.priceDelta === 0) continue;

    lines.push({
      code: 'option',
      group: group.id,
      value: value.id,
      label: `${group.label}: ${value.label}`,
      amount: value.priceDelta,
    });
  }

  if (selection.monogram?.enabled) {
    const position = getMonogramPosition(selection.monogram.position);
    lines.push({
      code: 'monogram',
      group: 'monogram',
      value: selection.monogram.text,
      label: `Monogram "${selection.monogram.text}"${position ? ` — ${position.label}` : ''}`,
      amount: MONOGRAM_FEE,
    });
    leadTimeDays += MONOGRAM_LEAD_TIME_DAYS;
  }

  const unitPrice = lines.reduce((total, line) => total + line.amount, 0);
  const subtotal = unitPrice * quantity;
  const tax = roundMinor(subtotal * config.taxRate);
  const total = subtotal + tax;
  const customisationTotal = unitPrice - product.basePrice;

  return {
    currency,
    quantity,
    lines: lines.map((line) => ({ ...line, formattedAmount: formatMoney(line.amount, currency) })),
    basePrice: product.basePrice,
    customisationTotal,
    unitPrice,
    subtotal,
    taxRate: config.taxRate,
    tax,
    total,
    formatted: {
      basePrice: formatMoney(product.basePrice, currency),
      customisationTotal: formatMoney(customisationTotal, currency),
      unitPrice: formatMoney(unitPrice, currency),
      subtotal: formatMoney(subtotal, currency),
      tax: formatMoney(tax, currency),
      total: formatMoney(total, currency),
    },
    leadTimeDays,
    estimatedShipDate: addDays(now, leadTimeDays).toISOString().slice(0, 10),
  };
};

export default priceSelection;
