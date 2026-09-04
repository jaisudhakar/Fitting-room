import Router from '../../http/router.js';
import { NotFoundError } from '../../modules/fitting-room/errors.js';
import * as fittingRoom from '../../modules/fitting-room/service.js';
import { getProductSource } from '../../modules/fitting-room/repository.js';
import * as tryOn from '../../modules/try-on/service.js';
import { verifyAppProxySignature } from './auth.js';
import { shopifyConfig } from './config.js';
import { buildLineItemProperties } from './lineItems.js';

/**
 * The storefront talks to this service through Shopify's app proxy, so every
 * request arrives signed with the app secret. `verify: false` is for local
 * development only.
 */
const withProxyAuth = (handler, { verify = true } = {}) =>
  async (context) => {
    if (verify) verifyAppProxySignature(context.query);

    const slug = context.body?.product ?? context.query.get('product');
    if (slug) {
      const source = getProductSource();
      if (typeof source.ensureProduct === 'function') await source.ensureProduct(slug);
    }

    return handler(context);
  };

const requireProduct = (context) => {
  const slug = context.body?.product ?? context.query.get('product');
  if (!slug) throw new NotFoundError('Name the product with `product=<handle>`.');
  return slug;
};

/**
 * Mount the storefront-facing routes.
 *
 * @param {Router} [router]
 * @param {{prefix?: string, verify?: boolean}} [options]
 */
export const registerShopifyProxyRoutes = (router = new Router(), { prefix = shopifyConfig.proxyPrefix, verify = true } = {}) => {
  const proxied = (handler) => withProxyAuth(handler, { verify });

  router
    .get(`${prefix}/config`, proxied((context) => fittingRoom.getFittingRoom(requireProduct(context))))

    .post(`${prefix}/size`, proxied((context) => fittingRoom.recommendSizeFor(requireProduct(context), context.body ?? {})))

    /**
     * The one endpoint that matters for money: the price and the signed line
     * properties are produced here, on the server, from the make-up. The
     * storefront never computes what it charges.
     */
    .post(
      `${prefix}/quote`,
      proxied((context) => {
        const slug = requireProduct(context);
        const { selection, validation, price } = fittingRoom.previewSelection(slug, context.body?.selection ?? {});
        if (!validation.valid) return { valid: false, validation, price, selection, line: null };

        const line = buildLineItemProperties(slug, context.body?.selection ?? {}, { lookUrl: context.body?.lookUrl ?? null });
        return { valid: true, validation, price, selection, line };
      }),
    )

    .post(`${prefix}/try-on/sessions`, proxied(() => tryOn.startTryOn()))
    .get(`${prefix}/try-on/sessions/:sessionId`, proxied(({ params }) => tryOn.getTryOn(params.sessionId)))
    .post(
      `${prefix}/try-on/sessions/:sessionId/picks`,
      proxied((context) =>
        tryOn.addPick(context.params.sessionId, {
          slug: requireProduct(context),
          selection: context.body?.selection,
        }),
      ),
    )
    .delete(`${prefix}/try-on/sessions/:sessionId/picks/:pickId`, proxied(({ params }) => tryOn.removePick(params.sessionId, params.pickId)))
    .post(`${prefix}/try-on/sessions/:sessionId/reset`, proxied(({ params }) => tryOn.resetTryOn(params.sessionId)))
    .post(
      `${prefix}/try-on/sessions/:sessionId/looks`,
      proxied(async ({ params, body }) => {
        const job = await tryOn.drawLook(params.sessionId, {
          mannequinId: body?.mannequinId,
          notes: body?.notes,
          provider: body?.provider,
        });
        return tryOn.publicJob(job);
      }),
    )
    .get(`${prefix}/try-on/looks/:lookId`, proxied(({ params }) => tryOn.getLook(params.lookId)))
    .get(
      `${prefix}/try-on/looks/:lookId/image`,
      proxied(({ params, res }) => {
        const image = tryOn.getLookImage(params.lookId);
        res.writeHead(200, { 'content-type': image.mimeType, 'content-length': image.byteLength, 'cache-control': 'private, max-age=3600' });
        res.end(image.bytes);
      }),
    );

  return router;
};

export default registerShopifyProxyRoutes;
