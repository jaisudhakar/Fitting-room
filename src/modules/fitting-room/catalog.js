/**
 * Catalogue of everything a shopper can change inside the fitting room.
 *
 * Prices are integers in the minor unit of the shop currency (e.g. cents), so
 * no floating point money ever reaches the basket. `leadTimeDays` is added on
 * top of the product lead time when the value is selected.
 */

/** @typedef {{id: string, label: string, priceDelta: number, leadTimeDays?: number, swatch?: string, description?: string, meta?: Record<string, unknown>}} OptionValue */
/** @typedef {{id: string, label: string, step: string, type: 'single', required: boolean, description?: string, values: OptionValue[]}} OptionGroup */

/** The ordered wizard the storefront renders, one screen per step. */
export const STEPS = [
  { id: 'size', label: 'Your size', description: 'Pick a stock size or have the shirt cut to your measurements.' },
  { id: 'fit', label: 'Fit', description: 'How close to the body the shirt should sit.' },
  { id: 'fabric', label: 'Fabric', description: 'Weight, weave and hand-feel of the linen.' },
  { id: 'details', label: 'Details', description: 'Collar, cuffs, placket, pocket and buttons.' },
  { id: 'monogram', label: 'Monogram', description: 'Optional embroidered initials.' },
  { id: 'review', label: 'Review', description: 'Confirm the make-up and the price.' },
];

/** @type {Record<string, OptionGroup>} */
export const OPTION_GROUPS = {
  size: {
    id: 'size',
    label: 'Size',
    step: 'size',
    type: 'single',
    required: true,
    description: 'Stock sizes ship from the warehouse; made-to-measure is cut for you.',
    values: [
      { id: 'xs', label: 'XS', priceDelta: 0 },
      { id: 's', label: 'S', priceDelta: 0 },
      { id: 'm', label: 'M', priceDelta: 0 },
      { id: 'l', label: 'L', priceDelta: 0 },
      { id: 'xl', label: 'XL', priceDelta: 0 },
      { id: 'xxl', label: 'XXL', priceDelta: 0 },
      {
        id: 'made-to-measure',
        label: 'Made to measure',
        priceDelta: 4500,
        leadTimeDays: 10,
        description: 'Cut to the seven measurements you provide.',
      },
    ],
  },

  fit: {
    id: 'fit',
    label: 'Fit',
    step: 'fit',
    type: 'single',
    required: true,
    values: [
      { id: 'slim', label: 'Slim', priceDelta: 0, description: 'Close through the chest and waist.' },
      { id: 'tailored', label: 'Tailored', priceDelta: 0, description: 'Light shaping, room to move.' },
      { id: 'relaxed', label: 'Relaxed', priceDelta: 0, description: 'Straight body, dropped shoulder.' },
      { id: 'oversized', label: 'Oversized', priceDelta: 0, description: 'Two sizes of extra volume.' },
    ],
  },

  fabric: {
    id: 'fabric',
    label: 'Fabric',
    step: 'fabric',
    type: 'single',
    required: true,
    values: [
      {
        id: 'beige-linen-160',
        label: 'Beige linen 160g',
        priceDelta: 0,
        swatch: '#D8CBB4',
        meta: { weightGsm: 160, composition: '100% European linen' },
      },
      {
        id: 'linen-cotton-blend',
        label: 'Linen / cotton blend 140g',
        priceDelta: -1000,
        swatch: '#E2D8C6',
        description: 'Softer and less prone to creasing.',
        meta: { weightGsm: 140, composition: '55% linen, 45% cotton' },
      },
      {
        id: 'stone-washed-linen',
        label: 'Stone-washed linen 170g',
        priceDelta: 1500,
        leadTimeDays: 2,
        swatch: '#CDBEA4',
        meta: { weightGsm: 170, composition: '100% washed linen' },
      },
      {
        id: 'garment-dyed-linen',
        label: 'Garment-dyed heavy linen 190g',
        priceDelta: 2500,
        leadTimeDays: 3,
        swatch: '#BFAE90',
        meta: { weightGsm: 190, composition: '100% linen, piece dyed' },
      },
      {
        id: 'belgian-linen-180',
        label: 'Premium Belgian linen 180g',
        priceDelta: 3500,
        leadTimeDays: 4,
        swatch: '#DCD2BE',
        meta: { weightGsm: 180, composition: '100% Belgian flax linen' },
      },
    ],
  },

  collar: {
    id: 'collar',
    label: 'Collar',
    step: 'details',
    type: 'single',
    required: true,
    values: [
      { id: 'classic', label: 'Classic point', priceDelta: 0 },
      { id: 'cutaway', label: 'Cutaway', priceDelta: 500 },
      { id: 'button-down', label: 'Button-down', priceDelta: 500 },
      { id: 'band', label: 'Band (collarless)', priceDelta: 500 },
    ],
  },

  sleeve: {
    id: 'sleeve',
    label: 'Sleeve length',
    step: 'details',
    type: 'single',
    required: true,
    values: [
      { id: 'long', label: 'Long sleeve', priceDelta: 0 },
      { id: 'short', label: 'Short sleeve', priceDelta: -800 },
    ],
  },

  cuff: {
    id: 'cuff',
    label: 'Cuff',
    step: 'details',
    type: 'single',
    required: true,
    values: [
      { id: 'none', label: 'No cuff (short sleeve)', priceDelta: 0 },
      { id: 'barrel-single', label: 'Single-button barrel', priceDelta: 0 },
      { id: 'barrel-double', label: 'Two-button barrel', priceDelta: 400 },
      { id: 'french', label: 'French cuff', priceDelta: 1200, leadTimeDays: 1 },
    ],
  },

  placket: {
    id: 'placket',
    label: 'Placket',
    step: 'details',
    type: 'single',
    required: true,
    values: [
      { id: 'standard', label: 'Standard placket', priceDelta: 0 },
      { id: 'hidden', label: 'Hidden placket', priceDelta: 900, leadTimeDays: 1 },
      { id: 'no-placket', label: 'No placket (French front)', priceDelta: 600 },
    ],
  },

  pocket: {
    id: 'pocket',
    label: 'Pocket',
    step: 'details',
    type: 'single',
    required: true,
    values: [
      { id: 'none', label: 'No pocket', priceDelta: 0 },
      { id: 'single-patch', label: 'Single patch pocket', priceDelta: 300 },
      { id: 'double-patch', label: 'Double patch pocket', priceDelta: 600 },
    ],
  },

  buttons: {
    id: 'buttons',
    label: 'Buttons',
    step: 'details',
    type: 'single',
    required: true,
    values: [
      { id: 'corozo-natural', label: 'Natural corozo', priceDelta: 0, swatch: '#E8E0CF' },
      { id: 'horn-dark', label: 'Dark horn', priceDelta: 900, swatch: '#4A3A2A' },
      { id: 'mother-of-pearl', label: 'Mother of pearl', priceDelta: 1400, leadTimeDays: 1, swatch: '#F2EFE6' },
    ],
  },

  hem: {
    id: 'hem',
    label: 'Hem',
    step: 'details',
    type: 'single',
    required: true,
    values: [
      { id: 'curved', label: 'Curved hem', priceDelta: 0, description: 'Made to be tucked in.' },
      { id: 'straight', label: 'Straight hem', priceDelta: 0, description: 'Made to be worn out.' },
    ],
  },
};

/**
 * Make-up rules the tailor cannot break. Each rule reads as:
 * "when <when.group> is one of <when.valueIn>, then <require.group> must be one
 * of <require.valueIn>".
 */
export const OPTION_RULES = [
  {
    id: 'short-sleeve-has-no-cuff',
    when: { group: 'sleeve', valueIn: ['short'] },
    require: { group: 'cuff', valueIn: ['none'] },
    message: 'A short sleeve is finished with a turn-up, so it cannot take a cuff.',
  },
  {
    id: 'long-sleeve-needs-cuff',
    when: { group: 'sleeve', valueIn: ['long'] },
    require: { group: 'cuff', valueIn: ['barrel-single', 'barrel-double', 'french'] },
    message: 'Choose a cuff for the long sleeve.',
  },
  {
    id: 'hidden-placket-needs-plain-collar',
    when: { group: 'placket', valueIn: ['hidden'] },
    require: { group: 'collar', valueIn: ['classic', 'cutaway', 'band'] },
    message: 'A hidden placket is not made with a button-down collar.',
  },
  {
    id: 'double-pocket-needs-room',
    when: { group: 'pocket', valueIn: ['double-patch'] },
    require: { group: 'fit', valueIn: ['relaxed', 'oversized'] },
    message: 'Double patch pockets are only cut on the relaxed and oversized blocks.',
  },
  {
    id: 'oversized-is-worn-out',
    when: { group: 'fit', valueIn: ['oversized'] },
    require: { group: 'hem', valueIn: ['straight'] },
    message: 'The oversized block is finished with a straight hem.',
  },
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

export const getOptionGroup = (groupId) => OPTION_GROUPS[groupId] ?? null;

export const getOptionValue = (groupId, valueId) =>
  OPTION_GROUPS[groupId]?.values.find((value) => value.id === valueId) ?? null;

export const getMonogramPosition = (id) => MONOGRAM_POSITIONS.find((p) => p.id === id) ?? null;
export const getMeasurementField = (id) => MEASUREMENT_FIELDS.find((f) => f.id === id) ?? null;
