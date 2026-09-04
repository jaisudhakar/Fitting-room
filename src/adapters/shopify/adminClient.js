import { FittingRoomError } from '../../modules/fitting-room/errors.js';
import { adminEndpoint, shopifyConfig } from './config.js';

export class AdminApiError extends FittingRoomError {
  constructor(message, { status = 502, code = 'shopify_admin_error', details = [] } = {}) {
    super(message, { status, code, details });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A small Admin GraphQL client: no dependencies, honours Shopify's throttling,
 * and turns `userErrors` into thrown errors so callers cannot ignore them.
 *
 * @param {{shop?: string, adminToken?: string, apiVersion?: string, fetchImpl?: typeof fetch, maxRetries?: number}} [options]
 */
export const createAdminClient = ({
  shop = shopifyConfig.shop,
  adminToken = shopifyConfig.adminToken,
  apiVersion = shopifyConfig.apiVersion,
  fetchImpl = fetch,
  maxRetries = 3,
  sleepImpl = sleep,
} = {}) => {
  if (!shop || !adminToken) {
    throw new AdminApiError('Set SHOPIFY_SHOP and SHOPIFY_ADMIN_TOKEN before talking to the Admin API.', {
      status: 500,
      code: 'shopify_not_configured',
    });
  }

  const endpoint = adminEndpoint({ shop, apiVersion });

  /**
   * @param {string} query
   * @param {object} [variables]
   * @returns {Promise<object>} the `data` object
   */
  const request = async (query, variables = {}) => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shopify-access-token': adminToken },
        body: JSON.stringify({ query, variables }),
      });

      if (response.status === 429 || response.status >= 500) {
        if (attempt >= maxRetries) {
          throw new AdminApiError(`Shopify answered ${response.status} after ${attempt + 1} attempts.`, {
            code: response.status === 429 ? 'shopify_throttled' : 'shopify_unavailable',
          });
        }
        const retryAfter = Number.parseFloat(response.headers?.get?.('retry-after') ?? '') || 2 ** attempt;
        await sleepImpl(retryAfter * 1000);
        continue;
      }

      const body = await response.json().catch(() => null);

      if (!response.ok) {
        throw new AdminApiError(body?.errors?.[0]?.message ?? `Shopify answered ${response.status}.`, {
          code: response.status === 401 || response.status === 403 ? 'shopify_unauthorized' : 'shopify_admin_error',
          status: response.status === 401 || response.status === 403 ? 401 : 502,
        });
      }

      if (body?.errors?.length) {
        const throttled = body.errors.some((error) => error.extensions?.code === 'THROTTLED');
        if (throttled && attempt < maxRetries) {
          await sleepImpl(2 ** attempt * 1000);
          continue;
        }
        throw new AdminApiError(body.errors[0].message, { code: 'shopify_graphql_error', details: body.errors });
      }

      const userErrors = Object.values(body?.data ?? {}).flatMap((result) => result?.userErrors ?? []);
      if (userErrors.length > 0) {
        throw new AdminApiError(userErrors[0].message, { code: 'shopify_user_error', details: userErrors, status: 422 });
      }

      return body?.data ?? {};
    }
  };

  return { shop, apiVersion, endpoint, request };
};

export default createAdminClient;
