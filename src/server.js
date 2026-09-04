import config from './config/index.js';
import { createApp } from './app.js';

const { server, router } = createApp();

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
