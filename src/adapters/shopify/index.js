/**
 * Shopify adapter: the same fitting room modules, wired to a Shopify store.
 *
 * - products come from a product metafield instead of the bundled JSON
 * - the price and the signed cart line properties are produced server-side
 * - the storefront reaches this service through Shopify's app proxy
 * - a cart transform function applies the customised price at checkout
 * - an orders/create webhook re-prices every customised line and flags tampering
 */
export { shopifyConfig, adminEndpoint } from './config.js';
export { AdminApiError, createAdminClient } from './adminClient.js';
export {
  createClientCredentialsProvider,
  createStaticTokenProvider,
  resolveTokenProvider,
} from './tokens.js';
export {
  UnauthorizedError,
  signMakeUp,
  verifyAppProxySignature,
  verifyMakeUpSignature,
  verifyWebhookHmac,
} from './auth.js';
export {
  CONFIG_METAFIELD,
  METAFIELD_DEFINITION,
  ensureDefinition,
  writeProductConfig,
} from './metafields.js';
export { toMetafieldConfig, toMinorUnits, toModuleProduct, toShopifyAmount } from './productMapper.js';
export { createShopifyProductSource, useShopifyProducts } from './productSource.js';
export { PROPERTY, auditLineItem, buildLineItemProperties } from './lineItems.js';
export { auditOrder, handleOrdersCreate } from './webhooks.js';
export { registerShopifyProxyRoutes } from './proxyRoutes.js';
