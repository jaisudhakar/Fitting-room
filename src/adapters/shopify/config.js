/**
 * Everything the Shopify adapter needs, read from the environment.
 *
 * `SHOPIFY_APP_SECRET` is the app's client secret: it verifies app proxy
 * requests and webhooks, and signs the make-up so a tampered cart can be
 * spotted. Nothing here is ever sent to the storefront.
 */
export const shopifyConfig = {
  shop: process.env.SHOPIFY_SHOP ?? '',
  adminToken: process.env.SHOPIFY_ADMIN_TOKEN ?? '',
  appSecret: process.env.SHOPIFY_APP_SECRET ?? '',
  apiVersion: process.env.SHOPIFY_API_VERSION ?? '2026-01',
  /** The subpath the online store proxies to this service. */
  proxyPrefix: process.env.SHOPIFY_PROXY_PREFIX ?? '/apps/fitting-room',
  /** How long a product's fitting room config is trusted before it is refetched. */
  productCacheTtlMs: Number.parseInt(process.env.SHOPIFY_PRODUCT_CACHE_TTL_MS ?? '', 10) || 5 * 60 * 1000,
  metafield: { namespace: 'fitting_room', key: 'config' },
};

export const adminEndpoint = ({ shop = shopifyConfig.shop, apiVersion = shopifyConfig.apiVersion } = {}) =>
  `https://${shop}/admin/api/${apiVersion}/graphql.json`;

export default shopifyConfig;
