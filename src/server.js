import config from './config/index.js';
import { createApp, shopifyConfigured } from './app.js';

const { server, router } = createApp();

// With Shopify credentials in the environment the same service becomes the
// app's backend: products from the store, routes behind the app proxy.
if (shopifyConfigured()) {
  const { installShopify } = await import('./adapters/shopify/install.js');
  await installShopify(router, { verifyProxy: process.env.SHOPIFY_VERIFY_PROXY !== 'false' });
}

server.listen(config.port, config.host, () => {
  console.log(`Fitting room listening on http://${config.host}:${config.port}`);
  for (const route of router.routes) console.log(`  ${route.method.padEnd(6)} ${route.pattern}`);
});

const shutdown = (signal) => {
  console.log(`\n${signal} received, closing the fitting room.`);
  server.close(() => process.exit(0));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
