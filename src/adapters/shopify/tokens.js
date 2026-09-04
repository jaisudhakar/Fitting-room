import { AdminApiError } from './adminClient.js';
import { shopifyConfig } from './config.js';

/**
 * Where the Admin API token comes from.
 *
 * Two strategies, both returning `() => Promise<string>`:
 *
 * - **static** — a token you already hold, in `SHOPIFY_ADMIN_TOKEN`.
 * - **client credentials** — the app exchanges its own client ID and secret for
 *   a token, with no merchant interaction. This is the one to use for stores in
 *   your own organisation: nothing to install, nothing to keep in sync. The
 *   token lasts a day, so it is cached and re-minted before it expires.
 *
 * Selling to other merchants later means the authorization code grant instead:
 * the merchant approves the app and you store the offline token per shop. The
 * provider shape below is what that would slot into.
 */

const TOKEN_ENDPOINT = (shop) => `https://${shop}/admin/oauth/access_token`;

export const createStaticTokenProvider = (token) => {
  const provider = async () => token;
  provider.invalidate = () => {};
  provider.strategy = 'static';
  return provider;
};

/**
 * @param {{shop?: string, clientId?: string, clientSecret?: string, fetchImpl?: typeof fetch, now?: () => number, skewMs?: number}} [options]
 */
export const createClientCredentialsProvider = ({
  shop = shopifyConfig.shop,
  clientId = shopifyConfig.clientId,
  clientSecret = shopifyConfig.clientSecret,
  fetchImpl = fetch,
  now = () => Date.now(),
  /** Re-mint this long before the token actually expires. */
  skewMs = 60_000,
} = {}) => {
  if (!shop || !clientId || !clientSecret) {
    throw new AdminApiError('Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET to mint tokens.', {
      status: 500,
      code: 'shopify_not_configured',
    });
  }

  let cached = null;
  let inFlight = null;

  const mint = async () => {
    const response = await fetchImpl(TOKEN_ENDPOINT(shop), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }),
    });

    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.access_token) {
      throw new AdminApiError(
        body?.error_description ?? body?.error ?? `Shopify refused to mint a token (${response.status}).`,
        { status: 401, code: 'shopify_token_refused' },
      );
    }

    cached = { token: body.access_token, expiresAt: now() + (body.expires_in ?? 86_399) * 1000 };
    return cached.token;
  };

  const provider = async () => {
    if (cached && cached.expiresAt - skewMs > now()) return cached.token;
    // One mint at a time, however many requests are waiting on it.
    inFlight = inFlight ?? mint().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  provider.invalidate = () => {
    cached = null;
  };
  provider.strategy = 'client_credentials';
  return provider;
};

/** Pick a strategy from whatever the environment provides. */
export const resolveTokenProvider = (options = {}) => {
  if (options.tokenProvider) return options.tokenProvider;
  const token = options.adminToken ?? shopifyConfig.adminToken;
  if (token) return createStaticTokenProvider(token);
  return createClientCredentialsProvider(options);
};
