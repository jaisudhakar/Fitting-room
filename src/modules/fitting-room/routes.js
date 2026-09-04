import Router from '../../http/router.js';
import * as controller from './controller.js';

/**
 * Mount the fitting room on a router.
 *
 * @param {Router} [router]
 * @param {{basePath?: string}} [options]
 */
export const registerFittingRoomRoutes = (router = new Router(), { basePath = '/api' } = {}) => {
  const product = `${basePath}/products/:slug/fitting-room`;
  const sessions = `${basePath}/fitting-room/sessions`;

  router
    .get(`${basePath}/fitting-room/health`, controller.health)
    .get(`${basePath}/products`, controller.listProducts)
    .get(product, controller.getFittingRoom)
    .post(`${product}/size-recommendation`, controller.recommendSize)
    .post(`${product}/validate`, controller.validate)
    .post(`${product}/quote`, controller.quote)
    .post(`${product}/add-to-cart`, controller.addToCart)
    .post(`${product}/sessions`, controller.startSession)
    .get(`${sessions}/:sessionId`, controller.getSession)
    .patch(`${sessions}/:sessionId`, controller.updateSession)
    .post(`${sessions}/:sessionId/complete`, controller.completeSession)
    .delete(`${sessions}/:sessionId`, controller.abandonSession);

  return router;
};

export default registerFittingRoomRoutes;
