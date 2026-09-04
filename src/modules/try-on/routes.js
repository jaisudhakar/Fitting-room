import Router from '../../http/router.js';
import * as controller from './controller.js';

/**
 * Mount the try-on rail.
 *
 * @param {Router} [router]
 * @param {{basePath?: string}} [options]
 */
export const registerTryOnRoutes = (router = new Router(), { basePath = '/api' } = {}) => {
  const root = `${basePath}/try-on`;

  router
    .get(`${root}/mannequins`, controller.listMannequins)
    .post(`${root}/sessions`, controller.start)
    .get(`${root}/sessions/:sessionId`, controller.read)
    .post(`${root}/sessions/:sessionId/picks`, controller.addPick)
    .delete(`${root}/sessions/:sessionId/picks/:pickId`, controller.removePick)
    .post(`${root}/sessions/:sessionId/reset`, controller.reset)
    .post(`${root}/sessions/:sessionId/looks`, controller.draw)
    .get(`${root}/looks/:lookId`, controller.readLook)
    .get(`${root}/looks/:lookId/image`, controller.readLookImage);

  return router;
};

export default registerTryOnRoutes;
