#!/usr/bin/env node
/**
 * Fitting Room — the whole concept in one Node.js file.
 *
 * A shopper picks a size (or goes made-to-measure), chooses the cut and the
 * fabric, works through the make-up details, adds a monogram, and watches the
 * price, the lead time and the tailoring rules update live before the garment
 * goes in the basket.
 *
 * This file is the complete implementation: catalogue, manufacturing rules,
 * size recommendation, pricing, validation, draft sessions, the JSON API and
 * the browser UI. No dependencies, no build step, no database.
 *
 *   node standalone/fitting-room.js       →  http://localhost:3000
 *
 * The modular version of the same domain lives in `src/`; this file is the
 * self-contained one, meant to be read top to bottom or dropped into another
 * project whole.
 */

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Configuration — every value overridable from the environment.
 * ────────────────────────────────────────────────────────────────────────── */

const int = (value, fallback) => (Number.isFinite(Number.parseInt(value ?? '', 10)) ? Number.parseInt(value, 10) : fallback);
const float = (value, fallback) => (Number.isFinite(Number.parseFloat(value ?? '')) ? Number.parseFloat(value) : fallback);

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST ?? '0.0.0.0',
  currency: process.env.FITTING_ROOM_CURRENCY ?? 'EUR',
  locale: process.env.FITTING_ROOM_LOCALE ?? 'en',
  /** VAT applied on top of the customised line price. 0 disables tax lines. */
  taxRate: float(process.env.FITTING_ROOM_TAX_RATE, 0.2),
  /** Lead time of a stock garment, in days, before any option surcharge. */
  baseLeadTimeDays: int(process.env.FITTING_ROOM_BASE_LEAD_TIME_DAYS, 3),
  /** How long an abandoned draft is kept, in milliseconds. */
  sessionTtlMs: int(process.env.FITTING_ROOM_SESSION_TTL_MS, 1000 * 60 * 60 * 24),
  maxQuantity: int(process.env.FITTING_ROOM_MAX_QUANTITY, 10),
};

/* ────────────────────────────────────────────────────────────────────────────
 * 2. The catalogue — everything a shopper can change.
 *
 * Prices are integers in the minor unit of the shop currency (cents), so no
 * floating-point money ever reaches the basket. `leadTimeDays` on a value is
 * added on top of the product's own lead time when that value is chosen.
 * ────────────────────────────────────────────────────────────────────────── */

/** The ordered wizard the storefront renders, one screen per step. */
export const STEPS = [
  { id: 'size', label: 'Your size', description: 'Pick a stock size or have the shirt cut to your measurements.' },
  { id: 'fit', label: 'Fit', description: 'How close to the body the shirt should sit.' },
  { id: 'fabric', label: 'Fabric', description: 'Weight, weave and hand-feel of the linen.' },
  { id: 'details', label: 'Details', description: 'Collar, cuffs, placket, pocket and buttons.' },
  { id: 'monogram', label: 'Monogram', description: 'Optional embroidered initials.' },
  { id: 'review', label: 'Review', description: 'Confirm the make-up and the price.' },
];

export const OPTION_GROUPS = {
  size: {
    id: 'size', label: 'Size', step: 'size', type: 'single', required: true,
    description: 'Stock sizes ship from the warehouse; made-to-measure is cut for you.',
    values: [
      { id: 'xs', label: 'XS', priceDelta: 0 },
      { id: 's', label: 'S', priceDelta: 0 },
      { id: 'm', label: 'M', priceDelta: 0 },
      { id: 'l', label: 'L', priceDelta: 0 },
      { id: 'xl', label: 'XL', priceDelta: 0 },
      { id: 'xxl', label: 'XXL', priceDelta: 0 },
      { id: 'made-to-measure', label: 'Made to measure', priceDelta: 4500, leadTimeDays: 10, description: 'Cut to the seven measurements you provide.' },
    ],
  },
  fit: {
    id: 'fit', label: 'Fit', step: 'fit', type: 'single', required: true,
    values: [
      { id: 'slim', label: 'Slim', priceDelta: 0, description: 'Close through the chest and waist.' },
      { id: 'tailored', label: 'Tailored', priceDelta: 0, description: 'Light shaping, room to move.' },
      { id: 'relaxed', label: 'Relaxed', priceDelta: 0, description: 'Straight body, dropped shoulder.' },
      { id: 'oversized', label: 'Oversized', priceDelta: 0, description: 'Two sizes of extra volume.' },
    ],
  },
  fabric: {
    id: 'fabric', label: 'Fabric', step: 'fabric', type: 'single', required: true,
    values: [
      { id: 'beige-linen-160', label: 'Beige linen 160g', priceDelta: 0, swatch: '#D8CBB4', meta: { weightGsm: 160, composition: '100% European linen' } },
      { id: 'linen-cotton-blend', label: 'Linen / cotton blend 140g', priceDelta: -1000, swatch: '#E2D8C6', description: 'Softer and less prone to creasing.', meta: { weightGsm: 140, composition: '55% linen, 45% cotton' } },
      { id: 'stone-washed-linen', label: 'Stone-washed linen 170g', priceDelta: 1500, leadTimeDays: 2, swatch: '#CDBEA4', meta: { weightGsm: 170, composition: '100% washed linen' } },
      { id: 'garment-dyed-linen', label: 'Garment-dyed heavy linen 190g', priceDelta: 2500, leadTimeDays: 3, swatch: '#BFAE90', meta: { weightGsm: 190, composition: '100% linen, piece dyed' } },
      { id: 'belgian-linen-180', label: 'Premium Belgian linen 180g', priceDelta: 3500, leadTimeDays: 4, swatch: '#DCD2BE', meta: { weightGsm: 180, composition: '100% Belgian flax linen' } },
    ],
  },
  collar: {
    id: 'collar', label: 'Collar', step: 'details', type: 'single', required: true,
    values: [
      { id: 'classic', label: 'Classic point', priceDelta: 0 },
      { id: 'cutaway', label: 'Cutaway', priceDelta: 500 },
      { id: 'button-down', label: 'Button-down', priceDelta: 500 },
      { id: 'band', label: 'Band (collarless)', priceDelta: 500 },
    ],
  },
  sleeve: {
    id: 'sleeve', label: 'Sleeve length', step: 'details', type: 'single', required: true,
    values: [
      { id: 'long', label: 'Long sleeve', priceDelta: 0 },
      { id: 'short', label: 'Short sleeve', priceDelta: -800 },
    ],
  },
  cuff: {
    id: 'cuff', label: 'Cuff', step: 'details', type: 'single', required: true,
    values: [
      { id: 'none', label: 'No cuff (short sleeve)', priceDelta: 0 },
      { id: 'barrel-single', label: 'Single-button barrel', priceDelta: 0 },
      { id: 'barrel-double', label: 'Two-button barrel', priceDelta: 400 },
      { id: 'french', label: 'French cuff', priceDelta: 1200, leadTimeDays: 1 },
    ],
  },
  placket: {
    id: 'placket', label: 'Placket', step: 'details', type: 'single', required: true,
    values: [
      { id: 'standard', label: 'Standard placket', priceDelta: 0 },
      { id: 'hidden', label: 'Hidden placket', priceDelta: 900, leadTimeDays: 1 },
      { id: 'no-placket', label: 'No placket (French front)', priceDelta: 600 },
    ],
  },
  pocket: {
    id: 'pocket', label: 'Pocket', step: 'details', type: 'single', required: true,
    values: [
      { id: 'none', label: 'No pocket', priceDelta: 0 },
      { id: 'single-patch', label: 'Single patch pocket', priceDelta: 300 },
      { id: 'double-patch', label: 'Double patch pocket', priceDelta: 600 },
    ],
  },
  buttons: {
    id: 'buttons', label: 'Buttons', step: 'details', type: 'single', required: true,
    values: [
      { id: 'corozo-natural', label: 'Natural corozo', priceDelta: 0, swatch: '#E8E0CF' },
      { id: 'horn-dark', label: 'Dark horn', priceDelta: 900, swatch: '#4A3A2A' },
      { id: 'mother-of-pearl', label: 'Mother of pearl', priceDelta: 1400, leadTimeDays: 1, swatch: '#F2EFE6' },
    ],
  },
  hem: {
    id: 'hem', label: 'Hem', step: 'details', type: 'single', required: true,
    values: [
      { id: 'curved', label: 'Curved hem', priceDelta: 0, description: 'Made to be tucked in.' },
      { id: 'straight', label: 'Straight hem', priceDelta: 0, description: 'Made to be worn out.' },
    ],
  },
};

/**
 * Make-up rules the tailor cannot break. Each rule reads as: "when <when.group>
 * is one of <when.valueIn>, then <require.group> must be one of
 * <require.valueIn>".
 */
export const OPTION_RULES = [
  { id: 'short-sleeve-has-no-cuff', when: { group: 'sleeve', valueIn: ['short'] }, require: { group: 'cuff', valueIn: ['none'] },
    message: 'A short sleeve is finished with a turn-up, so it cannot take a cuff.' },
  { id: 'long-sleeve-needs-cuff', when: { group: 'sleeve', valueIn: ['long'] }, require: { group: 'cuff', valueIn: ['barrel-single', 'barrel-double', 'french'] },
    message: 'Choose a cuff for the long sleeve.' },
  { id: 'hidden-placket-needs-plain-collar', when: { group: 'placket', valueIn: ['hidden'] }, require: { group: 'collar', valueIn: ['classic', 'cutaway', 'band'] },
    message: 'A hidden placket is not made with a button-down collar.' },
  { id: 'double-pocket-needs-room', when: { group: 'pocket', valueIn: ['double-patch'] }, require: { group: 'fit', valueIn: ['relaxed', 'oversized'] },
    message: 'Double patch pockets are only cut on the relaxed and oversized blocks.' },
  { id: 'oversized-is-worn-out', when: { group: 'fit', valueIn: ['oversized'] }, require: { group: 'hem', valueIn: ['straight'] },
    message: 'The oversized block is finished with a straight hem.' },
];

/** Flat fee charged once when a monogram is embroidered. */
export const MONOGRAM_FEE = 1200;
export const MONOGRAM_LEAD_TIME_DAYS = 2;
export const MONOGRAM_TEXT_PATTERN = /^[A-Z]{1,4}$/;

export const MONOGRAM_POSITIONS = [
  { id: 'cuff-left', label: 'Left cuff', requiresSleeve: 'long' },
  { id: 'cuff-right', label: 'Right cuff', requiresSleeve: 'long' },
  { id: 'chest-left', label: 'Left chest' },
  { id: 'hem-left', label: 'Left hem' },
  { id: 'collar-inner', label: 'Inside the collar', forbiddenCollars: ['band'] },
];

export const MONOGRAM_FONTS = [
  { id: 'block-sans', label: 'Block sans' },
  { id: 'classic-serif', label: 'Classic serif' },
  { id: 'script', label: 'Script' },
];

export const MONOGRAM_THREADS = [
  { id: 'tonal-beige', label: 'Tonal beige', swatch: '#D8CBB4' },
  { id: 'ivory', label: 'Ivory', swatch: '#F5F0E6' },
  { id: 'navy', label: 'Navy', swatch: '#1F2A44' },
  { id: 'terracotta', label: 'Terracotta', swatch: '#B4573A' },
  { id: 'charcoal', label: 'Charcoal', swatch: '#3A3A3A' },
];

/** Body measurements collected when the shopper picks made-to-measure. */
export const MEASUREMENT_FIELDS = [
  { id: 'neck', label: 'Neck', unit: 'cm', min: 32, max: 52, required: true },
  { id: 'chest', label: 'Chest', unit: 'cm', min: 78, max: 145, required: true },
  { id: 'waist', label: 'Waist', unit: 'cm', min: 60, max: 140, required: true },
  { id: 'hips', label: 'Hips', unit: 'cm', min: 78, max: 145, required: true },
  { id: 'shoulder', label: 'Shoulder to shoulder', unit: 'cm', min: 36, max: 56, required: true },
  { id: 'sleeveLength', label: 'Sleeve length', unit: 'cm', min: 50, max: 75, required: true },
  { id: 'shirtLength', label: 'Shirt length', unit: 'cm', min: 60, max: 90, required: true },
];

/** Body-profile answers used by the size recommender. */
export const BODY_TYPES = ['slim', 'athletic', 'regular', 'broad'];
export const FIT_PREFERENCES = ['fitted', 'regular', 'loose'];

export const getMonogramPosition = (id) => MONOGRAM_POSITIONS.find((p) => p.id === id) ?? null;

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Size charts and products. In a real shop these come from the PIM or,
 *    on Shopify, from a product metafield — the shape is all that matters.
 * ────────────────────────────────────────────────────────────────────────── */

export const SIZE_CHARTS = {
  'unisex-shirt-eu': {
    id: 'unisex-shirt-eu', label: 'Shirts — EU sizing', unit: 'cm', measuredOn: 'body',
    sizes: [
      { size: 'xs', chest: [86, 92], neck: [35, 37], waist: [70, 78], height: [160, 172] },
      { size: 's', chest: [92, 98], neck: [37, 38], waist: [78, 84], height: [166, 178] },
      { size: 'm', chest: [98, 104], neck: [38, 39.5], waist: [84, 90], height: [172, 184] },
      { size: 'l', chest: [104, 112], neck: [39.5, 41], waist: [90, 98], height: [176, 188] },
      { size: 'xl', chest: [112, 120], neck: [41, 43], waist: [98, 106], height: [180, 194] },
      { size: 'xxl', chest: [120, 130], neck: [43, 45], waist: [106, 116], height: [184, 200] },
    ],
  },
};

export const PRODUCTS = [
  {
    id: 'prd_beige_linen_shirt',
    slug: 'beige-linen-shirt',
    title: 'Beige Linen Shirt',
    subtitle: 'Washed European linen, cut in Portugal',
    currency: 'EUR',
    basePrice: 8900,
    leadTimeDays: 3,
    images: { default: '/images/beige-linen-shirt/front.jpg', byFabric: {} },
    fittingRoom: {
      enabled: true,
      sizeChartId: 'unisex-shirt-eu',
      monogram: { enabled: true },
      madeToMeasure: { enabled: true },
      groups: {
        size: { default: 'm' },
        fit: { default: 'tailored' },
        fabric: { default: 'beige-linen-160' },
        collar: { default: 'classic' },
        sleeve: { default: 'long' },
        cuff: { default: 'barrel-single' },
        placket: { default: 'standard' },
        pocket: { default: 'none' },
        buttons: { default: 'corozo-natural' },
        hem: { default: 'curved' },
      },
    },
  },
  {
    id: 'prd_stone_linen_trousers',
    slug: 'stone-linen-trousers',
    title: 'Stone Linen Trousers',
    subtitle: 'Pleated, drawstring waist',
    currency: 'EUR',
    basePrice: 9900,
    leadTimeDays: 4,
    images: { default: '/images/stone-linen-trousers/front.jpg', byFabric: {} },
    fittingRoom: {
      enabled: true,
      sizeChartId: 'unisex-shirt-eu',
      monogram: { enabled: false },
      madeToMeasure: { enabled: true },
      groups: {
        size: { default: 'm' },
        fit: { default: 'relaxed', allow: ['tailored', 'relaxed', 'oversized'] },
        fabric: { default: 'stone-washed-linen', allow: ['stone-washed-linen', 'garment-dyed-linen', 'belgian-linen-180'] },
        buttons: { default: 'corozo-natural' },
        hem: { default: 'straight' },
      },
    },
  },
];

/* ────────────────────────────────────────────────────────────────────────────
 * 4. Errors — every failure the fitting room raises on purpose.
 * ────────────────────────────────────────────────────────────────────────── */

export class FittingRoomError extends Error {
  constructor(message, { status = 500, code = 'fitting_room_error', details = [] } = {}) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export class NotFoundError extends FittingRoomError {
  constructor(message = 'Not found') { super(message, { status: 404, code: 'not_found' }); }
}

/** Raised when a selection breaks the catalogue rules. `details` lists each issue. */
export class ValidationError extends FittingRoomError {
  constructor(details, message = 'The selection is not valid.') {
    super(message, { status: 422, code: 'invalid_selection', details });
  }
}

export class BadRequestError extends FittingRoomError {
  constructor(message = 'Bad request', details = []) { super(message, { status: 400, code: 'bad_request', details }); }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. Repository — the catalogue as this product offers it.
 *
 * A product may hide an option group entirely or allow only a subset of its
 * values, so the global catalogue is always read through these helpers.
 * ────────────────────────────────────────────────────────────────────────── */

export const listProducts = () =>
  PRODUCTS.map(({ id, slug, title, subtitle, currency, basePrice, fittingRoom }) => ({
    id, slug, title, subtitle, currency, basePrice, fittingRoomEnabled: Boolean(fittingRoom?.enabled),
  }));

export const findProductBySlug = (slug) => PRODUCTS.find((product) => product.slug === slug) ?? null;

export const getProductBySlug = (slug) => {
  const product = findProductBySlug(slug);
  if (!product) throw new NotFoundError(`No product with slug "${slug}".`);
  if (!product.fittingRoom?.enabled) throw new NotFoundError(`The fitting room is not available for "${slug}".`);
  return product;
};

export const getSizeChart = (sizeChartId) => {
  const chart = SIZE_CHARTS[sizeChartId];
  if (!chart) throw new NotFoundError(`No size chart with id "${sizeChartId}".`);
  return chart;
};

export const resolveGroups = (product) =>
  Object.entries(product.fittingRoom.groups ?? {})
    .filter(([groupId]) => Boolean(OPTION_GROUPS[groupId]))
    .map(([groupId, groupConfig]) => {
      const group = OPTION_GROUPS[groupId];
      const values = groupConfig.allow ? group.values.filter((value) => groupConfig.allow.includes(value.id)) : group.values;
      return { ...group, values, default: groupConfig.default ?? values[0]?.id ?? null };
    });

export const resolveGroup = (product, groupId) => resolveGroups(product).find((group) => group.id === groupId) ?? null;

/** The default make-up shown when the fitting room first opens. */
export const defaultSelection = (product) => {
  const options = {};
  for (const group of resolveGroups(product)) if (group.default) options[group.id] = group.default;
  return { options, measurements: null, monogram: null };
};

/** Only the wizard steps this product has something to show on. */
export const resolveSteps = (product) => {
  const used = new Set(resolveGroups(product).map((group) => group.step));
  return STEPS.filter(
    (step) => used.has(step.id) || step.id === 'review' || (step.id === 'monogram' && Boolean(product.fittingRoom.monogram?.enabled)),
  );
};

/* ────────────────────────────────────────────────────────────────────────────
 * 6. Validation — what the atelier will and will not cut.
 * ────────────────────────────────────────────────────────────────────────── */

const issue = (code, field, message, meta = {}) => ({ code, field, message, ...meta });
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Coerce whatever the storefront posted into the shape the rest of the module
 * expects: known keys only, trimmed strings, numeric measurements.
 */
export const normalizeSelection = (rawSelection = {}) => {
  const source = isPlainObject(rawSelection) ? rawSelection : {};

  const options = {};
  if (isPlainObject(source.options)) {
    for (const [groupId, valueId] of Object.entries(source.options)) {
      if (valueId === null || valueId === undefined || valueId === '') continue;
      options[String(groupId)] = String(valueId).trim();
    }
  }

  let measurements = null;
  if (isPlainObject(source.measurements)) {
    measurements = {};
    for (const [fieldId, value] of Object.entries(source.measurements)) {
      if (value === null || value === undefined || value === '') continue;
      const parsed = Number(value);
      measurements[String(fieldId)] = Number.isFinite(parsed) ? parsed : value;
    }
  }

  let monogram = null;
  if (isPlainObject(source.monogram)) {
    monogram = source.monogram.enabled !== false
      ? {
          enabled: true,
          text: String(source.monogram.text ?? '').trim().toUpperCase(),
          position: String(source.monogram.position ?? '').trim(),
          font: String(source.monogram.font ?? MONOGRAM_FONTS[0].id).trim(),
          thread: String(source.monogram.thread ?? MONOGRAM_THREADS[0].id).trim(),
        }
      : null;
  }

  const parsedQuantity = Number.parseInt(source.quantity ?? 1, 10);
  return { options, measurements, monogram, quantity: Number.isFinite(parsedQuantity) ? parsedQuantity : 1 };
};

const validateOptions = (product, selection, issues) => {
  const groups = resolveGroups(product);
  const groupsById = new Map(groups.map((group) => [group.id, group]));

  for (const [groupId, valueId] of Object.entries(selection.options)) {
    const group = groupsById.get(groupId);
    if (!group) {
      issues.push(issue('unknown_option_group', `options.${groupId}`, `"${groupId}" is not customisable on this product.`));
      continue;
    }
    if (!group.values.some((value) => value.id === valueId)) {
      issues.push(issue('invalid_option_value', `options.${groupId}`, `"${valueId}" is not available for ${group.label.toLowerCase()}.`,
        { allowed: group.values.map((value) => value.id) }));
    }
  }

  for (const group of groups) {
    if (group.required && !selection.options[group.id]) {
      issues.push(issue('missing_option', `options.${group.id}`, `${group.label} is required.`));
    }
  }
};

const validateRules = (product, selection, issues) => {
  const available = new Set(resolveGroups(product).map((group) => group.id));

  for (const rule of OPTION_RULES) {
    if (!available.has(rule.when.group) || !available.has(rule.require.group)) continue;
    if (!rule.when.valueIn.includes(selection.options[rule.when.group])) continue;
    if (!rule.require.valueIn.includes(selection.options[rule.require.group])) {
      issues.push(issue('rule_violation', `options.${rule.require.group}`, rule.message, { rule: rule.id, allowed: rule.require.valueIn }));
    }
  }
};

const validateMeasurements = (product, selection, issues, warnings) => {
  if (selection.options.size !== 'made-to-measure') {
    if (selection.measurements && Object.keys(selection.measurements).length > 0) {
      warnings.push(issue('measurements_ignored', 'measurements', 'Measurements are only used with the made-to-measure size.'));
    }
    return;
  }

  if (!product.fittingRoom.madeToMeasure?.enabled) {
    issues.push(issue('made_to_measure_unavailable', 'options.size', 'Made to measure is not offered on this product.'));
    return;
  }

  const measurements = selection.measurements ?? {};
  for (const field of MEASUREMENT_FIELDS) {
    const value = measurements[field.id];
    if (value === undefined) {
      if (field.required) issues.push(issue('missing_measurement', `measurements.${field.id}`, `${field.label} is required for made to measure.`));
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push(issue('invalid_measurement', `measurements.${field.id}`, `${field.label} must be a number in ${field.unit}.`));
      continue;
    }
    if (value < field.min || value > field.max) {
      issues.push(issue('measurement_out_of_range', `measurements.${field.id}`,
        `${field.label} must be between ${field.min} and ${field.max} ${field.unit}.`, { min: field.min, max: field.max }));
    }
  }

  for (const fieldId of Object.keys(measurements)) {
    if (!MEASUREMENT_FIELDS.some((field) => field.id === fieldId)) {
      issues.push(issue('unknown_measurement', `measurements.${fieldId}`, `"${fieldId}" is not a measurement we take.`));
    }
  }

  const { chest, waist } = measurements;
  if (typeof chest === 'number' && typeof waist === 'number' && waist > chest + 10) {
    warnings.push(issue('measurement_unusual', 'measurements.waist',
      'The waist is much larger than the chest — our tailor will call to confirm before cutting.'));
  }
};

const validateMonogram = (product, selection, issues) => {
  const { monogram } = selection;
  if (!monogram) return;

  if (!product.fittingRoom.monogram?.enabled) {
    issues.push(issue('monogram_unavailable', 'monogram', 'This product cannot be monogrammed.'));
    return;
  }

  if (!MONOGRAM_TEXT_PATTERN.test(monogram.text)) {
    issues.push(issue('invalid_monogram_text', 'monogram.text', 'Use one to four letters (A–Z).'));
  }

  const position = getMonogramPosition(monogram.position);
  if (!position) {
    issues.push(issue('invalid_monogram_position', 'monogram.position', 'Choose where the monogram goes.',
      { allowed: MONOGRAM_POSITIONS.map((item) => item.id) }));
  } else {
    if (position.requiresSleeve && selection.options.sleeve && selection.options.sleeve !== position.requiresSleeve) {
      issues.push(issue('invalid_monogram_position', 'monogram.position',
        `${position.label} is only embroidered on a ${position.requiresSleeve} sleeve.`));
    }
    if (position.forbiddenCollars?.includes(selection.options.collar)) {
      issues.push(issue('invalid_monogram_position', 'monogram.position', `${position.label} is not available with that collar.`));
    }
  }

  if (!MONOGRAM_FONTS.some((font) => font.id === monogram.font)) {
    issues.push(issue('invalid_monogram_font', 'monogram.font', `"${monogram.font}" is not one of our fonts.`,
      { allowed: MONOGRAM_FONTS.map((font) => font.id) }));
  }

  if (!MONOGRAM_THREADS.some((thread) => thread.id === monogram.thread)) {
    issues.push(issue('invalid_monogram_thread', 'monogram.thread', `"${monogram.thread}" is not one of our thread colours.`,
      { allowed: MONOGRAM_THREADS.map((thread) => thread.id) }));
  }
};

const validateQuantity = (selection, issues) => {
  const { quantity } = selection;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > config.maxQuantity) {
    issues.push(issue('invalid_quantity', 'quantity', `Quantity must be a whole number between 1 and ${config.maxQuantity}.`));
  }
};

/** Validate a normalized selection against one product. */
export const validateSelection = (product, selection) => {
  const issues = [];
  const warnings = [];
  validateOptions(product, selection, issues);
  validateRules(product, selection, issues);
  validateMeasurements(product, selection, issues, warnings);
  validateMonogram(product, selection, issues);
  validateQuantity(selection, issues);
  return { valid: issues.length === 0, issues, warnings };
};

/* ────────────────────────────────────────────────────────────────────────────
 * 7. Pricing — integer minor units, VAT, lead time, ship date.
 * ────────────────────────────────────────────────────────────────────────── */

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
 * Lead times accumulate: every step that needs extra work in the atelier
 * (special fabric, French cuff, monogram, made to measure) is added on top of
 * the product's stock lead time.
 */
export const priceSelection = (product, selection, { now = new Date() } = {}) => {
  const groups = resolveGroups(product);
  const currency = product.currency ?? config.currency;
  const quantity = Number.isInteger(selection.quantity) && selection.quantity > 0 ? selection.quantity : 1;

  const lines = [{ code: 'base', group: null, value: null, label: product.title, amount: product.basePrice }];
  let leadTimeDays = product.leadTimeDays ?? config.baseLeadTimeDays;

  for (const group of groups) {
    const valueId = selection.options?.[group.id];
    if (!valueId) continue;
    const value = group.values.find((candidate) => candidate.id === valueId);
    if (!value) continue;

    leadTimeDays += value.leadTimeDays ?? 0;
    if (value.priceDelta === 0) continue;
    lines.push({ code: 'option', group: group.id, value: value.id, label: `${group.label}: ${value.label}`, amount: value.priceDelta });
  }

  if (selection.monogram?.enabled) {
    const position = getMonogramPosition(selection.monogram.position);
    lines.push({
      code: 'monogram', group: 'monogram', value: selection.monogram.text,
      label: `Monogram "${selection.monogram.text}"${position ? ` — ${position.label}` : ''}`,
      amount: MONOGRAM_FEE,
    });
    leadTimeDays += MONOGRAM_LEAD_TIME_DAYS;
  }

  const unitPrice = lines.reduce((total, line) => total + line.amount, 0);
  const subtotal = unitPrice * quantity;
  const tax = Math.round(subtotal * config.taxRate);
  const total = subtotal + tax;
  const customisationTotal = unitPrice - product.basePrice;

  return {
    currency, quantity,
    lines: lines.map((line) => ({ ...line, formattedAmount: formatMoney(line.amount, currency) })),
    basePrice: product.basePrice,
    customisationTotal, unitPrice, subtotal,
    taxRate: config.taxRate, tax, total,
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

/* ────────────────────────────────────────────────────────────────────────────
 * 8. Size recommendation — a size, a confidence, and why.
 * ────────────────────────────────────────────────────────────────────────── */

const BODY_TYPE_CHEST_ADJUSTMENT = { slim: -3, athletic: 2, regular: 0, broad: 5 };
const BODY_TYPE_WAIST_ADJUSTMENT = { slim: -4, athletic: -2, regular: 0, broad: 4 };
/** Ease the shopper wants on top of their body chest measurement, in cm. */
const FIT_PREFERENCE_EASE = { fitted: -3, regular: 0, loose: 5 };
/** Ease built into each cut, in cm — a slim block needs a touch more body room. */
const FIT_BLOCK_EASE = { slim: -2, tailored: 0, relaxed: 3, oversized: 6 };

export const SIZING_CONSTANTS = {
  bodyTypeChestAdjustment: BODY_TYPE_CHEST_ADJUSTMENT,
  bodyTypeWaistAdjustment: BODY_TYPE_WAIST_ADJUSTMENT,
  fitPreferenceEase: FIT_PREFERENCE_EASE,
  fitBlockEase: FIT_BLOCK_EASE,
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const article = (word) => (/^[aeiou]/i.test(word) ? 'an' : 'a');
const round1 = (value) => Math.round(value * 10) / 10;

/** How far a measurement sits outside a [min, max] range. 0 means it fits. */
const distanceOutside = (value, [min, max]) => (value < min ? min - value : value > max ? value - max : 0);

/** 0 at the middle of the range, 1 at either edge — used to break ties. */
const offCentre = (value, [min, max]) => {
  const middle = (min + max) / 2;
  const halfWidth = (max - min) / 2 || 1;
  return Math.min(1, Math.abs(value - middle) / halfWidth);
};

/**
 * Estimate the body measurements we were not given, from height and weight.
 * The coefficients are intentionally conservative: a wrong estimate should read
 * one size out, never two.
 */
export const estimateMeasurements = ({ heightCm, weightKg, bodyType = 'regular' }) => {
  const chest = 52 + 0.62 * weightKg - 0.25 * (heightCm - 178) + (BODY_TYPE_CHEST_ADJUSTMENT[bodyType] ?? 0);
  const waist = chest - 12 + (BODY_TYPE_WAIST_ADJUSTMENT[bodyType] ?? 0);
  const neck = 0.24 * chest + 13.5;
  return { chest: round1(chest), waist: round1(waist), neck: round1(neck) };
};

const assertProfile = (profile) => {
  const issues = [];
  const heightCm = Number(profile?.heightCm);
  const weightKg = Number(profile?.weightKg);

  if (!Number.isFinite(heightCm) || heightCm < 120 || heightCm > 220) {
    issues.push({ code: 'invalid_height', field: 'heightCm', message: 'Height must be between 120 and 220 cm.' });
  }
  if (!Number.isFinite(weightKg) || weightKg < 35 || weightKg > 200) {
    issues.push({ code: 'invalid_weight', field: 'weightKg', message: 'Weight must be between 35 and 200 kg.' });
  }
  if (profile?.bodyType && !BODY_TYPES.includes(profile.bodyType)) {
    issues.push({ code: 'invalid_body_type', field: 'bodyType', message: `Body type must be one of: ${BODY_TYPES.join(', ')}.` });
  }
  if (profile?.fitPreference && !FIT_PREFERENCES.includes(profile.fitPreference)) {
    issues.push({ code: 'invalid_fit_preference', field: 'fitPreference', message: `Fit preference must be one of: ${FIT_PREFERENCES.join(', ')}.` });
  }
  if (issues.length > 0) throw new BadRequestError('The body profile is not valid.', issues);

  return { heightCm, weightKg };
};

/** Recommend a stock size for a body profile, and say how sure we are. */
export const recommendSize = (product, profile) => {
  const { heightCm, weightKg } = assertProfile(profile);
  const bodyType = profile.bodyType ?? 'regular';
  const fitPreference = profile.fitPreference ?? 'regular';

  const chart = getSizeChart(product.fittingRoom.sizeChartId);
  const sizeGroup = resolveGroup(product, 'size');
  const offered = new Set(sizeGroup ? sizeGroup.values.map((value) => value.id) : []);
  const rows = chart.sizes.filter((row) => offered.size === 0 || offered.has(row.size));
  if (rows.length === 0) throw new BadRequestError('This product has no stock sizes to recommend.');

  const estimated = estimateMeasurements({ heightCm, weightKg, bodyType });
  const measuredChest = Number.isFinite(Number(profile.chestCm)) ? Number(profile.chestCm) : null;
  const measuredWaist = Number.isFinite(Number(profile.waistCm)) ? Number(profile.waistCm) : null;
  const measuredNeck = Number.isFinite(Number(profile.neckCm)) ? Number(profile.neckCm) : null;

  const body = {
    chest: measuredChest ?? estimated.chest,
    waist: measuredWaist ?? estimated.waist,
    neck: measuredNeck ?? estimated.neck,
  };

  const ease = (FIT_PREFERENCE_EASE[fitPreference] ?? 0) + (FIT_BLOCK_EASE[profile.fit] ?? 0);
  const effectiveChest = body.chest + ease;

  const scored = rows
    .map((row) => {
      const chestMiss = distanceOutside(effectiveChest, row.chest);
      const waistMiss = row.waist ? distanceOutside(body.waist, row.waist) : 0;
      const neckMiss = row.neck ? distanceOutside(body.neck, row.neck) : 0;
      const heightMiss = row.height ? distanceOutside(heightCm, row.height) : 0;
      const score = chestMiss * 3 + neckMiss * 2 + waistMiss * 1 + heightMiss * 0.15 + offCentre(effectiveChest, row.chest) * 0.5;
      return { size: row.size, row, score, chestMiss, neckMiss, waistMiss };
    })
    .sort((a, b) => a.score - b.score);

  const [best, runnerUp] = scored;
  const gap = runnerUp ? runnerUp.score - best.score : 5;

  const chartIndexOf = (size) => rows.findIndex((row) => row.size === size);
  const bestChartIndex = chartIndexOf(best.size);
  const neckBest = [...scored].sort((a, b) => a.neckMiss - b.neckMiss || a.score - b.score)[0];
  const neckOffset = Math.abs(chartIndexOf(neckBest.size) - bestChartIndex);

  let confidence = measuredChest ? 0.9 : 0.72;
  if (gap < 1.5) confidence -= 0.2;
  if (best.chestMiss > 0) confidence -= 0.25;
  if (neckOffset >= 2) confidence -= 0.15;
  confidence = round1(clamp(confidence, 0.25, 0.97) * 100) / 100;

  const rationale = [
    measuredChest
      ? `Matched on your chest measurement of ${body.chest} cm.`
      : `Estimated a chest of ${body.chest} cm from ${heightCm} cm / ${weightKg} kg and ${article(bodyType)} ${bodyType} build.`,
    ease !== 0
      ? `Added ${ease > 0 ? '+' : ''}${ease} cm of ease for a ${fitPreference} fit${profile.fit ? ` on the ${profile.fit} block` : ''}.`
      : 'Used the standard ease for this cut.',
    `Size ${best.size.toUpperCase()} covers ${best.row.chest[0]}–${best.row.chest[1]} cm chest.`,
  ];
  if (best.chestMiss > 0) {
    rationale.push(`Your chest sits ${round1(best.chestMiss)} cm outside every stock size — made to measure will fit better.`);
  }
  if (neckOffset >= 2) {
    rationale.push('Your neck and chest point at different sizes, which usually means a made-to-measure collar.');
  }

  const alternates = scored.slice(1, 3).map((entry) => ({
    size: entry.size,
    reason:
      entry.score < best.score + 1.5
        ? 'Nearly as good a match — take it if you prefer a different amount of room.'
        : chartIndexOf(entry.size) > bestChartIndex
          ? 'Size up for more room through the chest.'
          : 'Size down for a closer fit.',
  }));

  return {
    recommendedSize: best.size,
    confidence,
    alternates,
    body: { ...body, estimated: { chest: measuredChest === null, waist: measuredWaist === null, neck: measuredNeck === null } },
    ease,
    sizeChartRow: best.row,
    rationale,
    madeToMeasureSuggested:
      Boolean(product.fittingRoom.madeToMeasure?.enabled) && (confidence < 0.6 || best.chestMiss > 0 || neckOffset >= 2),
  };
};

/* ────────────────────────────────────────────────────────────────────────────
 * 9. Draft sessions — so a shopper can leave the page and come back.
 *
 * In memory here, behind a tiny interface: swap the store for Redis or a table
 * and nothing above this line changes.
 * ────────────────────────────────────────────────────────────────────────── */

export class InMemorySessionStore {
  #sessions = new Map();

  create(session) { this.#sessions.set(session.id, session); return session; }

  read(id) {
    const session = this.#sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) { this.#sessions.delete(id); return null; }
    return session;
  }

  write(session) { this.#sessions.set(session.id, session); return session; }

  delete(id) { return this.#sessions.delete(id); }

  /** Drop everything that has timed out. Safe to call on a timer. */
  sweep(now = Date.now()) {
    let removed = 0;
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) { this.#sessions.delete(id); removed += 1; }
    }
    return removed;
  }

  get size() { return this.#sessions.size; }
}

let store = new InMemorySessionStore();
export const setSessionStore = (nextStore) => { store = nextStore; };
export const getSessionStore = () => store;

export const createSession = ({ productSlug, selection, ttlMs = config.sessionTtlMs }) => {
  const now = Date.now();
  return store.create({
    id: `frs_${randomUUID().replace(/-/g, '')}`,
    productSlug, selection,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: now + ttlMs,
  });
};

export const readSession = (id) => {
  const session = store.read(id);
  if (!session) throw new NotFoundError(`Fitting room session "${id}" has expired or does not exist.`);
  return session;
};

export const saveSession = (session, { selection } = {}) =>
  store.write({ ...session, selection: selection ?? session.selection, updatedAt: new Date().toISOString() });

export const deleteSession = (id) => store.delete(id);
export const sweepSessions = (now) => store.sweep(now);

/* ────────────────────────────────────────────────────────────────────────────
 * 10. Service — the domain, usable with or without HTTP.
 * ────────────────────────────────────────────────────────────────────────── */

/** Everything the storefront needs to render the fitting room, in one payload. */
export const getFittingRoom = (slug) => {
  const product = getProductBySlug(slug);
  const currency = product.currency ?? config.currency;
  const selection = normalizeSelection(defaultSelection(product));

  const groups = resolveGroups(product).map((group) => ({
    id: group.id, label: group.label, step: group.step, type: group.type,
    required: group.required, description: group.description, default: group.default,
    values: group.values.map((value) => ({
      ...value,
      formattedPriceDelta:
        value.priceDelta === 0 ? null : `${value.priceDelta > 0 ? '+' : '−'}${formatMoney(Math.abs(value.priceDelta), currency)}`,
    })),
  }));

  return {
    product: {
      id: product.id, slug: product.slug, title: product.title, subtitle: product.subtitle,
      currency, basePrice: product.basePrice,
      formattedBasePrice: formatMoney(product.basePrice, currency),
      images: product.images,
    },
    steps: resolveSteps(product),
    groups,
    rules: OPTION_RULES,
    monogram: product.fittingRoom.monogram?.enabled
      ? {
          enabled: true, fee: MONOGRAM_FEE, formattedFee: formatMoney(MONOGRAM_FEE, currency), maxLength: 4,
          positions: MONOGRAM_POSITIONS, fonts: MONOGRAM_FONTS, threads: MONOGRAM_THREADS,
        }
      : { enabled: false },
    madeToMeasure: { enabled: Boolean(product.fittingRoom.madeToMeasure?.enabled), fields: MEASUREMENT_FIELDS },
    sizeChart: getSizeChart(product.fittingRoom.sizeChartId),
    bodyProfile: { bodyTypes: BODY_TYPES, fitPreferences: FIT_PREFERENCES },
    defaultSelection: selection,
    price: priceSelection(product, selection),
  };
};

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
export const variantKey = (product, selection) =>
  createHash('sha256')
    .update(JSON.stringify({
      slug: product.slug,
      options: Object.fromEntries(Object.entries(selection.options).sort(([a], [b]) => a.localeCompare(b))),
      measurements: selection.measurements ?? null,
      monogram: selection.monogram ?? null,
    }))
    .digest('hex')
    .slice(0, 16);

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
  customisation: { options: selection.options, measurements: selection.measurements, monogram: selection.monogram },
  priceBreakdown: price.lines,
});

/**
 * Merge a PATCH body into the stored selection. Absent keys are left alone; an
 * explicit `null` clears the monogram or the measurements.
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
  if ('monogram' in source) next.monogram = source.monogram === null ? null : source.monogram;
  if ('quantity' in source) next.quantity = source.quantity;

  return normalizeSelection(next);
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
    const position = getMonogramPosition(selection.monogram.position);
    lines.push({
      label: 'Monogram',
      value: `${selection.monogram.text} — ${position ? position.label : selection.monogram.position}, ${selection.monogram.font}, ${selection.monogram.thread}`,
    });
  }

  return lines;
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
    selection, validation, price,
    readyToAdd: validation.valid,
    summary: summarize(product, selection),
  };
};

export const startSession = (slug, rawSelection) => {
  const product = getProductBySlug(slug);
  const base = normalizeSelection(defaultSelection(product));
  const selection = rawSelection ? mergeSelection(base, rawSelection) : base;
  return sessionView(createSession({ productSlug: product.slug, selection }));
};

export const getSession = (sessionId) => sessionView(readSession(sessionId));

export const updateSession = (sessionId, patch) => {
  const session = readSession(sessionId);
  return sessionView(saveSession(session, { selection: mergeSelection(session.selection, patch) }));
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

/* ────────────────────────────────────────────────────────────────────────────
 * 11. A very small router — enough to expose the module over HTTP with no
 *     dependencies at all.
 * ────────────────────────────────────────────────────────────────────────── */

const MAX_BODY_BYTES = 100 * 1024;
const HTTP_RESPONSE = Symbol('http.response');

/** Wrap a payload when the handler needs a status other than 200. */
export const respond = (status, body) => ({ [HTTP_RESPONSE]: true, status, body });
const isResponseEnvelope = (value) => typeof value === 'object' && value !== null && value[HTTP_RESPONSE] === true;

const patternToRegex = (pattern) => {
  const names = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { regex: new RegExp(`^${source}/?$`), names };
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') { resolve(null); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new FittingRoomError('Request body is too large.', { status: 413, code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') { resolve(null); return; }
      try { resolve(JSON.parse(raw)); }
      catch { reject(new FittingRoomError('Request body must be valid JSON.', { status: 400, code: 'invalid_json' })); }
    });
    req.on('error', reject);
  });

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

export class Router {
  #routes = [];

  add(method, pattern, handler) {
    const { regex, names } = patternToRegex(pattern);
    this.#routes.push({ method, pattern, regex, names, handler });
    return this;
  }

  get(pattern, handler) { return this.add('GET', pattern, handler); }
  post(pattern, handler) { return this.add('POST', pattern, handler); }
  patch(pattern, handler) { return this.add('PATCH', pattern, handler); }
  delete(pattern, handler) { return this.add('DELETE', pattern, handler); }

  get routes() { return this.#routes.map(({ method, pattern }) => ({ method, pattern })); }

  handler() {
    return async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

      res.setHeader('access-control-allow-origin', process.env.CORS_ORIGIN ?? '*');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

      const matches = this.#routes
        .map((route) => ({ route, match: url.pathname.match(route.regex) }))
        .filter((entry) => entry.match !== null);

      if (matches.length === 0) {
        sendJson(res, 404, { error: { code: 'not_found', message: `No route for ${url.pathname}.` } });
        return;
      }

      const matched = matches.find((entry) => entry.route.method === req.method);
      if (!matched) {
        sendJson(res, 405, {
          error: {
            code: 'method_not_allowed',
            message: `${req.method} is not allowed on ${url.pathname}.`,
            details: [{ allow: matches.map((entry) => entry.route.method) }],
          },
        });
        return;
      }

      const params = Object.fromEntries(
        matched.route.names.map((name, index) => [name, decodeURIComponent(matched.match[index + 1])]),
      );

      try {
        const body = await readBody(req);
        const result = await matched.route.handler({ params, query: url.searchParams, body, req, res });
        if (res.writableEnded) return;
        if (result === undefined) { res.writeHead(204).end(); return; }
        if (isResponseEnvelope(result)) sendJson(res, result.status, result.body);
        else sendJson(res, 200, result);
      } catch (error) {
        if (error instanceof FittingRoomError) { sendJson(res, error.status, error.toJSON()); return; }
        process.emitWarning(error);
        sendJson(res, 500, { error: { code: 'internal_error', message: 'Something went wrong in the fitting room.' } });
      }
    };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 12. Routes. Handlers are thin: they translate a request into a service call
 *     and nothing else.
 * ────────────────────────────────────────────────────────────────────────── */

export const registerRoutes = (router = new Router(), { basePath = '/api' } = {}) => {
  const product = `${basePath}/products/:slug/fitting-room`;
  const sessions = `${basePath}/fitting-room/sessions`;

  router
    .get(`${basePath}/fitting-room/health`, () => ({ status: 'ok', module: 'fitting-room', time: new Date().toISOString() }))
    .get(`${basePath}/products`, () => ({ products: listProducts() }))
    .get(product, ({ params }) => getFittingRoom(params.slug))
    .post(`${product}/size-recommendation`, ({ params, body }) => recommendSizeFor(params.slug, body ?? {}))
    .post(`${product}/validate`, ({ params, body }) => {
      const { selection, validation } = previewSelection(params.slug, body ?? {});
      return { selection, ...validation };
    })
    .post(`${product}/quote`, ({ params, body, query }) => {
      // `?strict=true` refuses to price a make-up that cannot be manufactured.
      const evaluate = query.get('strict') === 'true' ? quoteSelection : previewSelection;
      const { selection, validation, price } = evaluate(params.slug, body ?? {});
      return { selection, validation, price };
    })
    .post(`${product}/add-to-cart`, ({ params, body }) => respond(201, addToCart(params.slug, body ?? {})))
    .post(`${product}/sessions`, ({ params, body }) => respond(201, startSession(params.slug, body ?? null)))
    .get(`${sessions}/:sessionId`, ({ params }) => getSession(params.sessionId))
    .patch(`${sessions}/:sessionId`, ({ params, body }) => updateSession(params.sessionId, body ?? {}))
    .post(`${sessions}/:sessionId/complete`, ({ params }) => respond(201, completeSession(params.sessionId)))
    .delete(`${sessions}/:sessionId`, ({ params }) => abandonSession(params.sessionId));

  return router;
};

/* ────────────────────────────────────────────────────────────────────────────
 * 13. The storefront page. One HTML document, served from memory, talking to
 *     the API above. The browser never computes a price: it PATCHes the draft
 *     session and renders whatever the server says the garment now costs.
 * ────────────────────────────────────────────────────────────────────────── */

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fitting Room</title>
<style>
  :root {
    --ink: #221e1a; --muted: #6f665c; --line: #e2dbd0; --bg: #faf7f2;
    --panel: #fff; --accent: #6b4f2f; --bad: #a33a2a; --warn: #8a6a1f;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
         font: 15px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  header { padding: 32px 24px 8px; max-width: 1120px; margin: 0 auto; }
  header h1 { margin: 0; font-size: 30px; font-weight: 600; letter-spacing: -0.01em; }
  header p { margin: 4px 0 0; color: var(--muted); }
  select#product { margin-top: 14px; padding: 7px 10px; border: 1px solid var(--line);
                   border-radius: 8px; background: var(--panel); font: inherit; }
  main { max-width: 1120px; margin: 0 auto; padding: 16px 24px 64px;
         display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 28px; align-items: start; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } aside { position: static !important; } }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
            padding: 18px 20px; margin-bottom: 18px; }
  section h2 { margin: 0 0 2px; font-size: 15px; text-transform: uppercase; letter-spacing: 0.08em; }
  section p.hint { margin: 0 0 14px; color: var(--muted); font-size: 13px; }
  .options { display: flex; flex-wrap: wrap; gap: 8px; }
  .opt { border: 1px solid var(--line); background: #fff; border-radius: 10px; padding: 9px 12px;
         cursor: pointer; font: inherit; text-align: left; min-width: 118px; }
  .opt:hover { border-color: #c6bcab; }
  .opt[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .opt .name { display: block; font-weight: 500; }
  .opt .delta { display: block; font-size: 12px; color: var(--muted); }
  .opt .swatch { display: inline-block; width: 12px; height: 12px; border-radius: 50%;
                 border: 1px solid rgba(0,0,0,.18); margin-right: 6px; vertical-align: -1px; }
  .group { margin-bottom: 16px; }
  .group > label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  input, select { padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px;
                  background: #fff; font: inherit; width: 100%; }
  label small { display: block; color: var(--muted); font-weight: 400; }
  button.action { padding: 10px 16px; border-radius: 10px; border: 1px solid var(--accent);
                  background: var(--accent); color: #fff; font: inherit; cursor: pointer; }
  button.action:disabled { opacity: .45; cursor: not-allowed; }
  button.ghost { background: #fff; color: var(--accent); }
  aside { position: sticky; top: 20px; }
  .price { font-size: 30px; font-weight: 600; letter-spacing: -0.02em; }
  .rows { list-style: none; margin: 14px 0; padding: 0; font-size: 13px; }
  .rows li { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; color: var(--muted); }
  .rows li b { font-weight: 500; color: var(--ink); }
  .totals { border-top: 1px solid var(--line); padding-top: 10px; font-size: 13px; }
  .totals div { display: flex; justify-content: space-between; padding: 2px 0; }
  .notice { border-radius: 10px; padding: 9px 11px; font-size: 13px; margin-top: 8px; }
  .notice.bad { background: #fbeeeb; color: var(--bad); }
  .notice.warn { background: #fbf5e4; color: var(--warn); }
  .notice.ok { background: #eef4ec; color: #3d6b3a; }
  .field-error { color: var(--bad); font-size: 12px; margin-top: 4px; }
  pre { background: #17130f; color: #f3ece1; padding: 14px; border-radius: 12px;
        overflow: auto; font-size: 12px; max-height: 320px; }
  .muted { color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<header>
  <h1 id="title">Fitting Room</h1>
  <p id="subtitle"></p>
  <select id="product"></select>
</header>

<main>
  <div id="steps"></div>

  <aside>
    <section>
      <h2>Your garment</h2>
      <p class="hint" id="leadtime"></p>
      <div class="price" id="total">—</div>
      <ul class="rows" id="breakdown"></ul>
      <div class="totals" id="totals"></div>
      <div id="messages"></div>
      <p style="margin:14px 0 0">
        <button class="action" id="add" disabled>Add to basket</button>
      </p>
      <p class="muted" id="sessionid"></p>
    </section>
    <section id="cart" hidden>
      <h2>Basket line</h2>
      <pre id="cartjson"></pre>
    </section>
  </aside>
</main>

<script>
(function () {
  var api = function (method, path, body) {
    return fetch(path, {
      method: method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) throw Object.assign(new Error('request failed'), { payload: json });
        return json;
      });
    });
  };

  var el = function (tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'text') node.textContent = attrs[key];
      else if (key === 'html') node.innerHTML = attrs[key];
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), attrs[key]);
      else if (attrs[key] !== null && attrs[key] !== undefined) node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  };

  var state = { slug: null, room: null, sessionId: null, selection: null, issues: [] };

  var issuesFor = function (field) {
    return state.issues.filter(function (item) { return item.field === field; });
  };

  /* Every change goes through the server: PATCH the draft, re-render the answer. */
  var patch = function (body) {
    return api('PATCH', '/api/fitting-room/sessions/' + state.sessionId, body).then(render);
  };

  var renderGroup = function (group) {
    var buttons = group.values.map(function (value) {
      var selected = state.selection.options[group.id] === value.id;
      return el('button', {
        class: 'opt', type: 'button', 'aria-pressed': selected ? 'true' : 'false',
        title: value.description || '',
        onclick: function () {
          var options = {};
          options[group.id] = value.id;
          patch({ options: options });
        }
      }, [
        el('span', { class: 'name', html: (value.swatch ? '<span class="swatch" style="background:' + value.swatch + '"></span>' : '') + value.label }),
        el('span', { class: 'delta', text: value.formattedPriceDelta || (value.leadTimeDays ? '+' + value.leadTimeDays + ' days' : 'included') })
      ]);
    });

    var errors = issuesFor('options.' + group.id).map(function (item) {
      return el('div', { class: 'field-error', text: item.message });
    });

    return el('div', { class: 'group' }, [el('label', { text: group.label })]
      .concat([el('div', { class: 'options' }, buttons)])
      .concat(errors));
  };

  var renderMeasurements = function () {
    if (!state.room.madeToMeasure.enabled) return null;
    if (state.selection.options.size !== 'made-to-measure') return null;
    var current = state.selection.measurements || {};

    var fields = state.room.madeToMeasure.fields.map(function (field) {
      var input = el('input', {
        type: 'number', step: '0.5', min: field.min, max: field.max,
        value: current[field.id] === undefined ? '' : current[field.id],
        onchange: function (event) {
          var patchBody = { measurements: {} };
          patchBody.measurements[field.id] = event.target.value === '' ? null : Number(event.target.value);
          patch(patchBody);
        }
      });
      var errors = issuesFor('measurements.' + field.id).map(function (item) {
        return el('div', { class: 'field-error', text: item.message });
      });
      return el('label', {}, [
        el('span', { text: field.label }),
        el('small', { text: field.min + '–' + field.max + ' ' + field.unit }),
        input
      ].concat(errors));
    });

    return el('section', {}, [
      el('h2', { text: 'Your measurements' }),
      el('p', { class: 'hint', text: 'Seven measurements, taken on the body. Our tailor checks them before cutting.' }),
      el('div', { class: 'grid' }, fields)
    ]);
  };

  var renderMonogram = function () {
    if (!state.room.monogram.enabled) return null;
    var mono = state.selection.monogram;
    var on = Boolean(mono && mono.enabled);

    var toggle = el('button', {
      class: 'action ghost', type: 'button',
      text: on ? 'Remove monogram' : 'Add a monogram (' + state.room.monogram.formattedFee + ')',
      onclick: function () {
        patch({ monogram: on ? null : { enabled: true, text: 'AB', position: state.room.monogram.positions[0].id,
          font: state.room.monogram.fonts[0].id, thread: state.room.monogram.threads[0].id } });
      }
    });

    var body = [];
    if (on) {
      var update = function (key) {
        return function (event) {
          var next = { enabled: true, text: mono.text, position: mono.position, font: mono.font, thread: mono.thread };
          next[key] = event.target.value;
          patch({ monogram: next });
        };
      };
      var select = function (key, items) {
        return el('select', { onchange: update(key) }, items.map(function (item) {
          return el('option', { value: item.id, selected: mono[key] === item.id ? 'selected' : null, text: item.label });
        }));
      };
      body = [el('div', { class: 'grid' }, [
        el('label', {}, [el('span', { text: 'Initials' }), el('small', { text: 'One to four letters' }),
          el('input', { value: mono.text, maxlength: state.room.monogram.maxLength, onchange: update('text') })]),
        el('label', {}, [el('span', { text: 'Position' }), el('small', { text: 'Where it is embroidered' }),
          select('position', state.room.monogram.positions)]),
        el('label', {}, [el('span', { text: 'Font' }), el('small', { text: 'Letterform' }), select('font', state.room.monogram.fonts)]),
        el('label', {}, [el('span', { text: 'Thread' }), el('small', { text: 'Colour' }), select('thread', state.room.monogram.threads)])
      ])];
      ['monogram', 'monogram.text', 'monogram.position', 'monogram.font', 'monogram.thread'].forEach(function (field) {
        issuesFor(field).forEach(function (item) { body.push(el('div', { class: 'field-error', text: item.message })); });
      });
    }

    return el('section', {}, [
      el('h2', { text: 'Monogram' }),
      el('p', { class: 'hint', text: 'Optional embroidered initials, ' + state.room.monogram.formattedFee + '.' }),
      toggle
    ].concat(body));
  };

  var renderSizeHelper = function () {
    var out = el('div', { class: 'muted', id: 'sizeout' });
    var read = function (id) { return document.getElementById(id).value; };

    var run = function () {
      api('POST', '/api/products/' + state.slug + '/fitting-room/size-recommendation', {
        heightCm: Number(read('h')), weightKg: Number(read('w')),
        bodyType: read('bt'), fitPreference: read('fp'), fit: state.selection.options.fit
      }).then(function (result) {
        out.textContent = '';
        out.appendChild(el('div', { class: 'notice ok',
          text: 'Size ' + result.recommendedSize.toUpperCase() + ' — ' + Math.round(result.confidence * 100) + '% confident' }));
        result.rationale.forEach(function (line) { out.appendChild(el('div', { text: '· ' + line })); });
        if (result.madeToMeasureSuggested) {
          out.appendChild(el('div', { class: 'notice warn', text: 'Made to measure would fit you better than any stock size.' }));
        }
        out.appendChild(el('p', {}, [el('button', {
          class: 'action', type: 'button', text: 'Use size ' + result.recommendedSize.toUpperCase(),
          onclick: function () { patch({ options: { size: result.recommendedSize } }); }
        })]));
      }).catch(function (error) {
        out.textContent = (error.payload && error.payload.error && error.payload.error.message) || 'Could not recommend a size.';
      });
    };

    return el('section', {}, [
      el('h2', { text: 'Find my size' }),
      el('p', { class: 'hint', text: 'Height and weight are enough; a chest measurement makes it surer.' }),
      el('div', { class: 'grid' }, [
        el('label', {}, [el('span', { text: 'Height' }), el('small', { text: 'cm' }), el('input', { id: 'h', type: 'number', value: '178' })]),
        el('label', {}, [el('span', { text: 'Weight' }), el('small', { text: 'kg' }), el('input', { id: 'w', type: 'number', value: '78' })]),
        el('label', {}, [el('span', { text: 'Build' }), el('small', { text: 'Body type' }),
          el('select', { id: 'bt' }, state.room.bodyProfile.bodyTypes.map(function (item) {
            return el('option', { value: item, selected: item === 'regular' ? 'selected' : null, text: item });
          }))]),
        el('label', {}, [el('span', { text: 'Preference' }), el('small', { text: 'How it should sit' }),
          el('select', { id: 'fp' }, state.room.bodyProfile.fitPreferences.map(function (item) {
            return el('option', { value: item, selected: item === 'regular' ? 'selected' : null, text: item });
          }))])
      ]),
      el('p', {}, [el('button', { class: 'action ghost', type: 'button', text: 'Recommend a size', onclick: run })]),
      out
    ]);
  };

  var render = function (view) {
    state.selection = view.selection;
    state.issues = view.validation.issues;
    if (view.session) {
      state.sessionId = view.session.id;
      document.getElementById('sessionid').textContent = 'Draft ' + view.session.id;
    }

    /* Left column: one section per wizard step that this product uses. */
    var steps = document.getElementById('steps');
    steps.textContent = '';
    state.room.steps.forEach(function (step) {
      if (step.id === 'review') return;
      if (step.id === 'monogram') { var mono = renderMonogram(); if (mono) steps.appendChild(mono); return; }

      var groups = state.room.groups.filter(function (group) { return group.step === step.id; });
      if (groups.length === 0) return;
      steps.appendChild(el('section', {}, [
        el('h2', { text: step.label }),
        el('p', { class: 'hint', text: step.description })
      ].concat(groups.map(renderGroup))));

      if (step.id === 'size') {
        steps.appendChild(renderSizeHelper());
        var measurements = renderMeasurements();
        if (measurements) steps.appendChild(measurements);
      }
    });

    /* Right column: the price, straight from the server. */
    var price = view.price;
    document.getElementById('total').textContent = price.formatted.total;
    document.getElementById('leadtime').textContent =
      'Ready in ' + price.leadTimeDays + ' days · ships about ' + price.estimatedShipDate;

    var breakdown = document.getElementById('breakdown');
    breakdown.textContent = '';
    price.lines.forEach(function (line) {
      breakdown.appendChild(el('li', {}, [el('span', { text: line.label }), el('b', { text: line.formattedAmount })]));
    });

    document.getElementById('totals').innerHTML =
      '<div><span>Unit price</span><b>' + price.formatted.unitPrice + '</b></div>' +
      '<div><span>Subtotal (x' + price.quantity + ')</span><b>' + price.formatted.subtotal + '</b></div>' +
      '<div><span>VAT ' + Math.round(price.taxRate * 100) + '%</span><b>' + price.formatted.tax + '</b></div>';

    var messages = document.getElementById('messages');
    messages.textContent = '';
    view.validation.issues.forEach(function (item) {
      messages.appendChild(el('div', { class: 'notice bad', text: item.message }));
    });
    view.validation.warnings.forEach(function (item) {
      messages.appendChild(el('div', { class: 'notice warn', text: item.message }));
    });
    if (view.validation.valid) {
      messages.appendChild(el('div', { class: 'notice ok', text: 'This shirt can be made exactly as specified.' }));
    }

    document.getElementById('add').disabled = !view.readyToAdd;
  };

  document.getElementById('add').addEventListener('click', function () {
    api('POST', '/api/fitting-room/sessions/' + state.sessionId + '/complete').then(function (result) {
      document.getElementById('cart').hidden = false;
      document.getElementById('cartjson').textContent = JSON.stringify(result.cartLine, null, 2);
      return open(state.slug);
    });
  });

  var open = function (slug) {
    state.slug = slug;
    return api('GET', '/api/products/' + slug + '/fitting-room').then(function (room) {
      state.room = room;
      document.getElementById('title').textContent = room.product.title;
      document.getElementById('subtitle').textContent =
        room.product.subtitle + ' · from ' + room.product.formattedBasePrice;
      return api('POST', '/api/products/' + slug + '/fitting-room/sessions', {});
    }).then(render);
  };

  api('GET', '/api/products').then(function (result) {
    var select = document.getElementById('product');
    result.products.forEach(function (product) {
      select.appendChild(el('option', { value: product.slug, text: product.title }));
    });
    select.addEventListener('change', function (event) { open(event.target.value); });
    return open(result.products[0].slug);
  });
})();
</script>
</body>
</html>`;

/* ────────────────────────────────────────────────────────────────────────────
 * 14. The application: routes + the page + a sweeper for expired drafts.
 * ────────────────────────────────────────────────────────────────────────── */

export const createApp = ({ basePath = '/api', sweepIntervalMs = 1000 * 60 * 15 } = {}) => {
  const router = registerRoutes(new Router(), { basePath });

  // The storefront itself. Registered last so the API always wins a tie.
  router.get('/', ({ res }) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(PAGE) });
    res.end(PAGE);
  });

  const server = createServer(router.handler());

  if (sweepIntervalMs > 0) {
    const timer = setInterval(() => sweepSessions(), sweepIntervalMs);
    timer.unref();
    server.on('close', () => clearInterval(timer));
  }

  return { server, router };
};

/** Only listen when this file is the entry point — importing it stays side-effect free. */
const isEntryPoint = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntryPoint) {
  const { server, router } = createApp();

  server.listen(config.port, config.host, () => {
    console.log(`Fitting room  →  http://localhost:${config.port}`);
    for (const route of router.routes) console.log(`  ${route.method.padEnd(6)} ${route.pattern}`);
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} received, closing the fitting room.`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

export default createApp;
