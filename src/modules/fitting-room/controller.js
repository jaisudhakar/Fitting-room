import { respond } from '../../http/router.js';
import * as service from './service.js';

/**
 * Thin HTTP adapters: they translate a request into a service call and nothing
 * else, so the domain stays usable without an HTTP server.
 */
export const health = () => ({ status: 'ok', module: 'fitting-room', time: new Date().toISOString() });

export const listProducts = () => ({ products: service.listFittingRoomProducts() });

export const getFittingRoom = ({ params }) => service.getFittingRoom(params.slug);

export const recommendSize = ({ params, body }) => service.recommendSizeFor(params.slug, body ?? {});

export const validate = ({ params, body }) => {
  const { selection, validation } = service.previewSelection(params.slug, body ?? {});
  return { selection, ...validation };
};

export const quote = ({ params, body, query }) => {
  // `?strict=true` refuses to price a make-up that cannot be manufactured.
  if (query.get('strict') === 'true') {
    const { selection, price, validation } = service.quoteSelection(params.slug, body ?? {});
    return { selection, validation, price };
  }
  const { selection, price, validation } = service.previewSelection(params.slug, body ?? {});
  return { selection, validation, price };
};

export const addToCart = ({ params, body }) => respond(201, service.addToCart(params.slug, body ?? {}));

export const startSession = ({ params, body }) => respond(201, service.startSession(params.slug, body ?? null));

export const getSession = ({ params }) => service.getSession(params.sessionId);

export const updateSession = ({ params, body }) => service.updateSession(params.sessionId, body ?? {});

export const completeSession = ({ params }) => respond(201, service.completeSession(params.sessionId));

export const abandonSession = ({ params }) => service.abandonSession(params.sessionId);
