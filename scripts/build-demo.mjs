/**
 * Build the demo storefront page.
 *
 * The page is static — it has to run with no server — so this script bakes the
 * live catalogue, rules, size chart and sizing constants into it. The demo can
 * never drift from the module: change an option in `catalog.js`, re-run this.
 *
 *   node scripts/build-demo.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import config from '../src/config/index.js';
import {
  MEASUREMENT_FIELDS,
  MONOGRAM_FEE,
  MONOGRAM_FONTS,
  MONOGRAM_LEAD_TIME_DAYS,
  MONOGRAM_POSITIONS,
  MONOGRAM_THREADS,
  OPTION_RULES,
  BODY_TYPES,
  FIT_PREFERENCES,
} from '../src/modules/fitting-room/catalog.js';
import { defaultSelection, getProductBySlug, getSizeChart, resolveGroups, resolveSteps } from '../src/modules/fitting-room/repository.js';
import { SIZING_CONSTANTS } from '../src/modules/fitting-room/sizing.js';

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));

const product = getProductBySlug('beige-linen-shirt');

const data = {
  product: {
    slug: product.slug,
    title: product.title,
    subtitle: product.subtitle,
    currency: product.currency,
    basePrice: product.basePrice,
    leadTimeDays: product.leadTimeDays,
  },
  steps: resolveSteps(product),
  groups: resolveGroups(product),
  rules: OPTION_RULES,
  monogram: {
    fee: MONOGRAM_FEE,
    leadTimeDays: MONOGRAM_LEAD_TIME_DAYS,
    maxLength: 4,
    positions: MONOGRAM_POSITIONS,
    fonts: MONOGRAM_FONTS,
    threads: MONOGRAM_THREADS,
  },
  measurementFields: MEASUREMENT_FIELDS,
  sizeChart: getSizeChart(product.fittingRoom.sizeChartId),
  bodyTypes: BODY_TYPES,
  fitPreferences: FIT_PREFERENCES,
  sizing: SIZING_CONSTANTS,
  defaultSelection: defaultSelection(product),
  taxRate: config.taxRate,
};

const template = readFileSync(path('../demo/template.html'), 'utf8');
const html = template.replace('"__FITTING_ROOM_DATA__"', JSON.stringify(data, null, 2));

if (html === template) throw new Error('The data placeholder is missing from demo/template.html.');

writeFileSync(path('../demo/index.html'), html);
console.log(`demo/index.html written — ${data.groups.length} option groups, ${data.rules.length} rules.`);
