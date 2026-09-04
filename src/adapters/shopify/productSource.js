import { setProductSource } from '../../modules/fitting-room/repository.js';
import { shopifyConfig } from './config.js';
import { createAdminClient } from './adminClient.js';
import { CONFIG_METAFIELD, PRODUCTS_WITH_FITTING_ROOM, PRODUCT_BY_HANDLE } from './metafields.js';
import { toModuleProduct } from './productMapper.js';

/**
 * A product source backed by the Admin API.
 *
 * The fitting room modules read products synchronously, so this keeps a small
 * cache and exposes `ensureProduct` / `warm` for the route layer to await
 * before it hands over. A product that is already cached and still fresh costs
 * nothing; a stale one is refetched.
 */
export const createShopifyProductSource = ({
  client = createAdminClient(),
  ttlMs = shopifyConfig.productCacheTtlMs,
  now = () => Date.now(),
} = {}) => {
  /** @type {Map<string, {product: object, fetchedAt: number}>} */
  const cache = new Map();

  const fresh = (entry) => entry && now() - entry.fetchedAt < ttlMs;

  const put = (product) => {
    if (product) cache.set(product.slug, { product, fetchedAt: now() });
    return product;
  };

  const fetchOne = async (slug) => {
    const data = await client.request(PRODUCT_BY_HANDLE, {
      handle: slug,
      namespace: CONFIG_METAFIELD.namespace,
      key: CONFIG_METAFIELD.key,
    });
    const product = toModuleProduct(data.productByHandle);
    if (!product) {
      cache.delete(slug);
      return null;
    }
    return put(product);
  };

  /** Load every product that has a fitting room. Call once at boot. */
  const warm = async () => {
    let cursor = null;
    let loaded = 0;
    do {
      const data = await client.request(PRODUCTS_WITH_FITTING_ROOM, {
        cursor,
        namespace: CONFIG_METAFIELD.namespace,
        key: CONFIG_METAFIELD.key,
      });
      for (const node of data.products.nodes) {
        if (put(toModuleProduct(node))) loaded += 1;
      }
      cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    } while (cursor);
    return loaded;
  };

  /** Make sure one product is in the cache and fresh, then hand back to the sync API. */
  const ensureProduct = async (slug) => {
    const entry = cache.get(slug);
    if (fresh(entry)) return entry.product;
    try {
      return await fetchOne(slug);
    } catch (error) {
      // A stale product beats an outage: keep serving what we have.
      if (entry) return entry.product;
      throw error;
    }
  };

  const source = {
    list: () => [...cache.values()].map((entry) => entry.product),
    find: (slug) => cache.get(slug)?.product ?? null,
    ensureProduct,
    warm,
    invalidate: (slug) => (slug ? cache.delete(slug) : cache.clear()),
    get size() {
      return cache.size;
    },
  };

  return source;
};

/** Install the Shopify source on the fitting room modules. */
export const useShopifyProducts = (options) => {
  const source = createShopifyProductSource(options);
  setProductSource(source);
  return source;
};
