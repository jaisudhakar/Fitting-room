import { FittingRoomError } from '../modules/fitting-room/errors.js';

const MAX_BODY_BYTES = 100 * 1024;

/** Marks a handler result that carries its own status code and body. */
const HTTP_RESPONSE = Symbol('http.response');

/** Wrap a payload when the handler needs a status other than 200. */
export const respond = (status, body) => ({ [HTTP_RESPONSE]: true, status, body });

const isResponseEnvelope = (value) => typeof value === 'object' && value !== null && value[HTTP_RESPONSE] === true;

const patternToRegex = (pattern) => {
  const names = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { regex: new RegExp(`^${source}/?$`), names };
};

/** The unparsed body — webhooks are signed over the exact bytes Shopify sent. */
export const readRawBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new FittingRoomError('Request body is too large.', { status: 413, code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const readBody = (req) =>
  new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      resolve(null);
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new FittingRoomError('Request body is too large.', { status: 413, code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new FittingRoomError('Request body must be valid JSON.', { status: 400, code: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
};

/** A very small router: enough to expose the module over HTTP with no dependencies. */
export class Router {
  #routes = [];

  /**
   * @param {object} [options]
   * @param {boolean} [options.raw] hand the handler the unparsed bytes instead
   *   of a parsed JSON body — needed wherever a signature covers the raw body.
   */
  add(method, pattern, handler, options = {}) {
    const { regex, names } = patternToRegex(pattern);
    this.#routes.push({ method, pattern, regex, names, handler, raw: Boolean(options.raw) });
    return this;
  }

  get(pattern, handler, options) { return this.add('GET', pattern, handler, options); }
  post(pattern, handler, options) { return this.add('POST', pattern, handler, options); }
  patch(pattern, handler, options) { return this.add('PATCH', pattern, handler, options); }
  delete(pattern, handler, options) { return this.add('DELETE', pattern, handler, options); }

  get routes() {
    return this.#routes.map(({ method, pattern }) => ({ method, pattern }));
  }

  /** @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} */
  handler() {
    return async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

      res.setHeader('access-control-allow-origin', process.env.CORS_ORIGIN ?? '*');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }

      const matches = this.#routes
        .map((route) => ({ route, match: url.pathname.match(route.regex) }))
        .filter((entry) => entry.match !== null);

      if (matches.length === 0) {
        sendJson(res, 404, { error: { code: 'not_found', message: `No route for ${url.pathname}.` } });
        return;
      }

      const matched = matches.find((entry) => entry.route.method === req.method);
      if (!matched) {
        sendJson(res, 405, {
          error: {
            code: 'method_not_allowed',
            message: `${req.method} is not allowed on ${url.pathname}.`,
            details: [{ allow: matches.map((entry) => entry.route.method) }],
          },
        });
        return;
      }

      const params = Object.fromEntries(matched.route.names.map((name, index) => [name, decodeURIComponent(matched.match[index + 1])]));

      try {
        const rawBody = matched.route.raw ? await readRawBody(req) : null;
        const body = matched.route.raw ? null : await readBody(req);
        const result = await matched.route.handler({ params, query: url.searchParams, body, rawBody, req, res });
        if (res.writableEnded) return;
        if (result === undefined) {
          res.writeHead(204).end();
          return;
        }
        if (isResponseEnvelope(result)) sendJson(res, result.status, result.body);
        else sendJson(res, 200, result);
      } catch (error) {
        if (error instanceof FittingRoomError) {
          sendJson(res, error.status, error.toJSON());
          return;
        }
        process.emitWarning(error);
        sendJson(res, 500, { error: { code: 'internal_error', message: 'Something went wrong in the fitting room.' } });
      }
    };
  }
}

export default Router;
