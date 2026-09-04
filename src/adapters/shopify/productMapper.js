/**
 * Map a Shopify product onto the shape the fitting room modules expect.
 *
 * The mapping is deliberately narrow: Shopify owns the title, the handle, the
 * price and the image; the metafield owns everything about customisation.
 */

/** Shopify prices are decimal strings in the shop currency; the module counts minor units. */
export const toMinorUnits = (amount) => Math.round(Number.parseFloat(String(amount ?? '0')) * 100);

export const toShopifyAmount = (minorUnits) => (minorUnits / 100).toFixed(2);

const firstSentence = (text = '') => {
  const trimmed = String(text).trim().split(/\n/)[0] ?? '';
  return trimmed.length > 140 ? `${trimmed.slice(0, 137)}…` : trimmed;
};

/**
 * @param {object} node a product node from the Admin API
 * @returns {object|null} a module product, or null when the product has no fitting room
 */
export const toModuleProduct = (node) => {
  if (!node) return null;

  let config = null;
  if (node.metafield?.value) {
    try {
      config = JSON.parse(node.metafield.value);
    } catch {
      return null; // a malformed metafield means "no fitting room", never a crash on the storefront
    }
  }
  if (!config?.enabled) return null;

  const variant = node.variants?.nodes?.[0];
  const price = variant?.price ?? node.priceRangeV2?.minVariantPrice?.amount;

  return {
    id: node.id,
    variantId: variant?.id ?? null,
    slug: node.handle,
    title: node.title,
    subtitle: config.subtitle ?? firstSentence(node.description),
    currency: node.priceRangeV2?.minVariantPrice?.currencyCode ?? 'USD',
    basePrice: toMinorUnits(price),
    leadTimeDays: config.leadTimeDays ?? 3,
    images: {
      default: node.featuredImage?.url ?? null,
      byFabric: config.imagesByFabric ?? {},
    },
    fittingRoom: {
      enabled: true,
      sizeChartId: config.sizeChartId ?? 'unisex-shirt-eu',
      monogram: config.monogram ?? { enabled: false },
      madeToMeasure: config.madeToMeasure ?? { enabled: false },
      groups: config.groups ?? {},
    },
  };
};

/** The metafield value for a product, from a module product definition. */
export const toMetafieldConfig = (product) => ({
  enabled: Boolean(product.fittingRoom?.enabled),
  subtitle: product.subtitle ?? null,
  leadTimeDays: product.leadTimeDays ?? 3,
  sizeChartId: product.fittingRoom?.sizeChartId ?? 'unisex-shirt-eu',
  monogram: product.fittingRoom?.monogram ?? { enabled: false },
  madeToMeasure: product.fittingRoom?.madeToMeasure ?? { enabled: false },
  groups: product.fittingRoom?.groups ?? {},
  imagesByFabric: product.images?.byFabric ?? {},
});
