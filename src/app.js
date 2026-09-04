import { createServer } from 'node:http';

import Router from './http/router.js';
import { registerFittingRoomRoutes } from './modules/fitting-room/routes.js';
import { sweepSessions } from './modules/fitting-room/session.js';
import { registerTryOnRoutes } from './modules/try-on/routes.js';
import { sweepTryOn } from './modules/try-on/session.js';

/** True when the environment carries Shopify credentials. */
export const shopifyConfigured = () => Boolean(process.env.SHOPIFY_SHOP && process.env.SHOPIFY_ADMIN_TOKEN);

/**
 * Build the HTTP application. Returns the node server plus the router, so a
 * host app can either listen on it or reuse `router.handler()` behind its own
 * framework (Express, Fastify, a serverless handler).
 */
export const createApp = ({ basePath = '/api', sweepIntervalMs = 1000 * 60 * 15 } = {}) => {
  const router = registerFittingRoomRoutes(new Router(), { basePath });
  registerTryOnRoutes(router, { basePath });
  const server = createServer(router.handler());

  if (sweepIntervalMs > 0) {
    const timer = setInterval(() => {
      sweepSessions();
      sweepTryOn();
    }, sweepIntervalMs);
    timer.unref();
    server.on('close', () => clearInterval(timer));
  }

  return { server, router };
};

export default createApp;
