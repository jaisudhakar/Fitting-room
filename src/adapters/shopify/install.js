import { createAdminClient } from './adminClient.js';
import { shopifyConfig } from './config.js';
import { registerShopifyProxyRoutes } from './proxyRoutes.js';
import { useShopifyProducts } from './productSource.js';
import { handleOrdersCreate } from './webhooks.js';

/**
 * Turn the standalone service into the Shopify app's backend.
 *
 * Products then come from the store, the storefront routes are mounted behind
 * the app proxy, and the orders webhook re-prices what was actually bought.
 * Everything else — pricing, rules, sizing, the try-on — is unchanged.
 *
 * @param {import('../../http/router.js').Router} router
 * @param {{verifyProxy?: boolean, warm?: boolean}} [options]
 */
export const installShopify = async (router, { verifyProxy = true, warm = true } = {}) => {
  const client = createAdminClient();
  const source = useShopifyProducts({ client });

  registerShopifyProxyRoutes(router, { prefix: shopifyConfig.proxyPrefix, verify: verifyProxy });

  router.post(
    '/webhooks/orders-create',
    async ({ rawBody, req }) => handleOrdersCreate({ rawBody, headers: req.headers, client }),
    { raw: true },
  );

  if (warm) {
    const loaded = await source.warm();
    console.log(`Fitting room: ${loaded} product(s) loaded from ${shopifyConfig.shop}.`);
  }

  return { client, source };
};

export default installShopify;
