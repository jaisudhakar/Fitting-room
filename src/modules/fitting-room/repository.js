import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { OPTION_GROUPS, STEPS } from './catalog.js';
import { NotFoundError } from './errors.js';

const readJson = (relativePath) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'));

const products = readJson('../../data/products.json');
const sizeCharts = readJson('../../data/size-charts.json');

export const listProducts = () =>
  products.map(({ id, slug, title, subtitle, currency, basePrice, fittingRoom }) => ({
    id,
    slug,
    title,
    subtitle,
    currency,
    basePrice,
    fittingRoomEnabled: Boolean(fittingRoom?.enabled),
  }));

export const findProductBySlug = (slug) => products.find((product) => product.slug === slug) ?? null;

export const getProductBySlug = (slug) => {
  const product = findProductBySlug(slug);
  if (!product) throw new NotFoundError(`No product with slug "${slug}".`);
  if (!product.fittingRoom?.enabled) {
    throw new NotFoundError(`The fitting room is not available for "${slug}".`);
  }
  return product;
};

export const getSizeChart = (sizeChartId) => {
  const chart = sizeCharts[sizeChartId];
  if (!chart) throw new NotFoundError(`No size chart with id "${sizeChartId}".`);
  return chart;
};

/**
 * Merge the global catalogue with what this product actually offers: a product
 * may hide a group entirely or allow only a subset of its values.
 *
 * @returns {Array<import('./catalog.js').OptionGroup & {default: string|null}>}
 */
export const resolveGroups = (product) => {
  const configured = product.fittingRoom.groups ?? {};
  return Object.entries(configured)
    .filter(([groupId]) => Boolean(OPTION_GROUPS[groupId]))
    .map(([groupId, groupConfig]) => {
      const group = OPTION_GROUPS[groupId];
      const values = groupConfig.allow
        ? group.values.filter((value) => groupConfig.allow.includes(value.id))
        : group.values;
      return { ...group, values, default: groupConfig.default ?? values[0]?.id ?? null };
    });
};

export const resolveGroup = (product, groupId) =>
  resolveGroups(product).find((group) => group.id === groupId) ?? null;

/** The default make-up shown when the fitting room first opens. */
export const defaultSelection = (product) => {
  const options = {};
  for (const group of resolveGroups(product)) {
    if (group.default) options[group.id] = group.default;
  }
  return { options, measurements: null, monogram: null };
};

/** Only the wizard steps this product has something to show on. */
export const resolveSteps = (product) => {
  const usedSteps = new Set(resolveGroups(product).map((group) => group.step));
  return STEPS.filter(
    (step) =>
      usedSteps.has(step.id) ||
      step.id === 'review' ||
      (step.id === 'monogram' && Boolean(product.fittingRoom.monogram?.enabled)),
  );
};
