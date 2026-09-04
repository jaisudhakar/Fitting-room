import { respond } from '../../http/router.js';
import { BadRequestError } from '../fitting-room/errors.js';
import { MANNEQUINS } from './catalog.js';
import * as service from './service.js';

/**
 * The shopper's own API key travels in a header, never in the URL or the body,
 * so it stays out of access logs and browser history.
 */
const apiKeyFrom = (req) => {
  const header = req.headers['x-goog-api-key'] ?? req.headers['x-api-key'];
  return typeof header === 'string' && header.trim() !== '' ? header.trim() : undefined;
};

export const listMannequins = () => ({ mannequins: MANNEQUINS });

export const start = () => respond(201, service.startTryOn());

export const read = ({ params }) => service.getTryOn(params.sessionId);

export const addPick = ({ params, body }) => {
  if (!body?.slug) throw new BadRequestError('Say which product is being hung on the rail (`slug`).');
  return respond(201, service.addPick(params.sessionId, { slug: body.slug, selection: body.selection }));
};

export const removePick = ({ params }) => service.removePick(params.sessionId, params.pickId);

export const reset = ({ params }) => service.resetTryOn(params.sessionId);

export const draw = async ({ params, body, req }) => {
  const job = await service.drawLook(params.sessionId, {
    apiKey: apiKeyFrom(req),
    mannequinId: body?.mannequinId,
    notes: body?.notes,
    provider: body?.provider,
    model: body?.model,
  });
  return respond(201, service.publicJob(job));
};

export const readLook = ({ params }) => service.getLook(params.lookId);

export const readLookImage = ({ params, res }) => {
  const image = service.getLookImage(params.lookId);
  res.writeHead(200, {
    'content-type': image.mimeType,
    'content-length': image.byteLength,
    'cache-control': 'private, max-age=3600',
  });
  res.end(image.bytes);
};
