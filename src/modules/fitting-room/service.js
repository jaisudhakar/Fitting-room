import { createHash } from 'node:crypto';

import config from '../../config/index.js';
import {
  MEASUREMENT_FIELDS,
  MONOGRAM_FEE,
  MONOGRAM_FONTS,
  MONOGRAM_POSITIONS,
  MONOGRAM_THREADS,
  OPTION_RULES,
  BODY_TYPES,
  FIT_PREFERENCES,
} from './catalog.js';
import { ValidationError } from './errors.js';
import { formatMoney, priceSelection } from './pricing.js';
import {
  defaultSelection,
  getProductBySlug,
  getSizeChart,
  listProducts,
  resolveGroups,
  resolveSteps,
} from './repository.js';
import { recommendSize } from './sizing.js';
import { createSession, deleteSession, readSession, saveSession } from './session.js';
import { normalizeSelection, validateSelection } from './validator.js';

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Everything the storefront needs to render the fitting room in one payload. */
export const getFittingRoom = (slug) => {
  const product = getProductBySlug(slug);
  const currency = product.currency ?? config.currency;
  const selection = normalizeSelection(defaultSelection(product));

  const groups = resolveGroups(product).map((group) => ({
    id: group.id,
    label: group.label,
    step: group.step,
    type: group.type,
    required: group.required,
    description: group.description,
    default: group.default,
    values: group.values.map((value) => ({
      ...value,
      formattedPriceDelta:
        value.priceDelta === 0
          ? null
          : `${value.priceDelta > 0 ? '+' : '−'}${formatMoney(Math.abs(value.priceDelta), currency)}`,
    })),
  }));

  return {
    product: {
      id: product.id,
      slug: product.slug,
      title: product.title,
      subtitle: product.subtitle,
      currency,
      basePrice: product.basePrice,
      formattedBasePrice: formatMoney(product.basePrice, currency),
      images: product.images,
    },
    steps: resolveSteps(product),
    groups,
    rules: OPTION_RULES,
    monogram: product.fittingRoom.monogram?.enabled
      ? {
          enabled: true,
          fee: MONOGRAM_FEE,
          formattedFee: formatMoney(MONOGRAM_FEE, currency),
          maxLength: 4,
          positions: MONOGRAM_POSITIONS,
          fonts: MONOGRAM_FONTS,
          threads: MONOGRAM_THREADS,
        }
      : { enabled: false },
    madeToMeasure: {
      enabled: Boolean(product.fittingRoom.madeToMeasure?.enabled),
      fields: MEASUREMENT_FIELDS,
    },
    sizeChart: getSizeChart(product.fittingRoom.sizeChartId),
    bodyProfile: { bodyTypes: BODY_TYPES, fitPreferences: FIT_PREFERENCES },
    defaultSelection: selection,
    price: priceSelection(product, selection),
  };
};

export const listFittingRoomProducts = () => listProducts();

export const recommendSizeFor = (slug, profile) => recommendSize(getProductBySlug(slug), profile ?? {});

/**
 * Lenient evaluation: always returns the price so the UI can update live, plus
 * whatever is still wrong with the make-up.
 */
export const previewSelection = (slug, rawSelection) => {
  const product = getProductBySlug(slug);
  const selection = normalizeSelection(rawSelection);
  const validation = validateSelection(product, selection);
  return { product, selection, validation, price: priceSelection(product, selection) };
};

/** Strict evaluation: throws when the make-up cannot be manufactured. */
export const quoteSelection = (slug, rawSelection) => {
  const { selection, validation, price, product } = previewSelection(slug, rawSelection);
  if (!validation.valid) throw new ValidationError(validation.issues);
  return { product, selection, validation, price };
};

/** Stable key for a make-up, so identical customisations merge in the basket. */
export const variantKey = (product, selection) => {
  const payload = JSON.stringify({
    slug: product.slug,
    options: Object.fromEntries(Object.entries(selection.options).sort(([a], [b]) => a.localeCompare(b))),
    measurements: selection.measurements ?? null,
    monogram: selection.monogram ?? null,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
};

/** A basket line the checkout can consume as-is. */
export const buildCartLine = (product, selection, price) => ({
  productId: product.id,
  slug: product.slug,
  title: product.title,
  variantKey: variantKey(product, selection),
  quantity: price.quantity,
  currency: price.currency,
  unitPrice: price.unitPrice,
  subtotal: price.subtotal,
  tax: price.tax,
  total: price.total,
  formatted: price.formatted,
  leadTimeDays: price.leadTimeDays,
  estimatedShipDate: price.estimatedShipDate,
  customisation: {
    options: selection.options,
    measurements: selection.measurements,
    monogram: selection.monogram,
  },
  priceBreakdown: price.lines,
});

/**
 * Merge a PATCH body into the stored selection. Keys that are absent are left
 * alone; an explicit `null` clears the monogram or the measurements.
 */
export const mergeSelection = (current, patch = {}) => {
  const source = isPlainObject(patch) ? patch : {};
  const next = {
    options: { ...current.options },
    measurements: current.measurements ? { ...current.measurements } : null,
    monogram: current.monogram ? { ...current.monogram } : null,
    quantity: current.quantity,
  };

  if ('options' in source) {
    if (source.options === null) next.options = {};
    else if (isPlainObject(source.options)) Object.assign(next.options, source.options);
  }
  if ('measurements' in source) {
    if (source.measurements === null) next.measurements = null;
    else if (isPlainObject(source.measurements)) next.measurements = { ...(next.measurements ?? {}), ...source.measurements };
  }
  if ('monogram' in source) {
    next.monogram = source.monogram === null ? null : source.monogram;
  }
  if ('quantity' in source) next.quantity = source.quantity;

  return normalizeSelection(next);
};

const sessionView = (session) => {
  const { selection, validation, price, product } = previewSelection(session.productSlug, session.selection);
  return {
    session: {
      id: session.id,
      productSlug: session.productSlug,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: new Date(session.expiresAt).toISOString(),
    },
    selection,
    validation,
    price,
    readyToAdd: validation.valid,
    summary: summarize(product, selection),
  };
};

/** Human-readable recap of the make-up, for the review step and order emails. */
export const summarize = (product, selection) => {
  const lines = resolveGroups(product)
    .filter((group) => selection.options[group.id])
    .map((group) => {
      const value = group.values.find((candidate) => candidate.id === selection.options[group.id]);
      return { label: group.label, value: value ? value.label : selection.options[group.id] };
    });

  if (selection.measurements) {
    lines.push({
      label: 'Measurements',
      value: MEASUREMENT_FIELDS.filter((field) => selection.measurements[field.id] !== undefined)
        .map((field) => `${field.label} ${selection.measurements[field.id]} ${field.unit}`)
        .join(', '),
    });
  }

  if (selection.monogram?.enabled) {
    const position = MONOGRAM_POSITIONS.find((item) => item.id === selection.monogram.position);
    lines.push({
      label: 'Monogram',
      value: `${selection.monogram.text} — ${position ? position.label : selection.monogram.position}, ${selection.monogram.font}, ${selection.monogram.thread}`,
    });
  }

  return lines;
};

export const startSession = (slug, rawSelection) => {
  const product = getProductBySlug(slug);
  const base = defaultSelection(product);
  const selection = rawSelection ? mergeSelection(normalizeSelection(base), rawSelection) : normalizeSelection(base);
  const session = createSession({ productSlug: product.slug, selection });
  return sessionView(session);
};

export const getSession = (sessionId) => sessionView(readSession(sessionId));

export const updateSession = (sessionId, patch) => {
  const session = readSession(sessionId);
  const selection = mergeSelection(session.selection, patch);
  return sessionView(saveSession(session, { selection }));
};

export const abandonSession = (sessionId) => {
  readSession(sessionId);
  deleteSession(sessionId);
  return { deleted: true, id: sessionId };
};

/** Turn a finished fitting room into a basket line and close the draft. */
export const completeSession = (sessionId) => {
  const session = readSession(sessionId);
  const { product, selection, price } = quoteSelection(session.productSlug, session.selection);
  const cartLine = buildCartLine(product, selection, price);
  deleteSession(sessionId);
  return { cartLine, summary: summarize(product, selection) };
};

/** One-shot add to basket, for shoppers who never opened a draft session. */
export const addToCart = (slug, rawSelection) => {
  const { product, selection, price } = quoteSelection(slug, rawSelection);
  return { cartLine: buildCartLine(product, selection, price), summary: summarize(product, selection) };
};
