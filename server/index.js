import http from 'node:http';
import {config} from './config.js';
import {authenticate, OdooError} from './odoo.js';
import * as catalog from './catalog.js';

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_ID = 2147483647;
const PAGE = {defaultLimit: 24, maxLimit: 48, maxOffset: 10000};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function send(res, status, body, extraHeaders = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(json);
}

const ok = (res, data, meta) => send(res, 200, meta ? {ok: true, data, meta} : {ok: true, data});
const badRequest = message => new HttpError(400, 'BAD_REQUEST', message);
const notFound = (message = 'Not found') => new HttpError(404, 'NOT_FOUND', message);

function parseId(raw, label = 'id') {
  if (!/^[1-9]\d{0,9}$/.test(raw) || Number(raw) > MAX_ID) throw badRequest(`Invalid ${label}`);
  return Number(raw);
}

function parseIntParam(raw, name, min, max) {
  if (!/^\d{1,6}$/.test(raw)) throw badRequest(`${name} must be an integer`);
  const value = Number(raw);
  if (value < min || value > max) throw badRequest(`${name} must be between ${min} and ${max}`);
  return value;
}

function readQuery(url, allowed) {
  const query = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key)) throw badRequest(`Unknown query parameter: ${key.slice(0, 40)}`);
    if (key in query) throw badRequest(`Duplicate query parameter: ${key}`);
    query[key] = value;
  }
  return query;
}

const handlers = {
  health(req, res, url) {
    readQuery(url, []);
    ok(res, {status: 'ok'});
  },

  async products(req, res, url) {
    const query = readQuery(url, ['limit', 'offset', 'category', 'q']);
    const limit = query.limit === undefined ? PAGE.defaultLimit : parseIntParam(query.limit, 'limit', 1, PAGE.maxLimit);
    const offset = query.offset === undefined ? 0 : parseIntParam(query.offset, 'offset', 0, PAGE.maxOffset);
    const categoryId = query.category === undefined ? null : parseId(query.category, 'category');
    const q = (query.q || '').trim();
    if (q.length > 64) throw badRequest('q must be at most 64 characters');
    const {items, total} = await catalog.listProducts({limit, offset, categoryId, q});
    ok(res, items, {total, limit, offset});
  },

  async product(req, res, url, [rawId]) {
    readQuery(url, []);
    const product = await catalog.getProduct(parseId(rawId));
    if (!product) throw notFound('Product not found');
    ok(res, product);
  },

  async variants(req, res, url, [rawId]) {
    readQuery(url, []);
    const variants = await catalog.getVariants(parseId(rawId));
    if (!variants) throw notFound('Product not found');
    ok(res, variants, {total: variants.length});
  },

  async categories(req, res, url) {
    readQuery(url, []);
    const categories = await catalog.listCategories();
    ok(res, categories, {total: categories.length});
  },

  async image(req, res, url, [kind, rawId, rawSize]) {
    readQuery(url, ['v']);
    const size = Number(rawSize);
    if (!catalog.IMAGE_SIZES.has(size)) throw badRequest('Unsupported image size');
    const image = await catalog.getImage(kind, parseId(rawId), size);
    if (!image) throw notFound('Image not found');
    res.writeHead(200, {
      'Content-Type': image.type,
      'Content-Length': image.body.length,
      'Cache-Control': 'public, max-age=300',
      ...SECURITY_HEADERS,
    });
    res.end(image.body);
  },
};

const routes = [
  [/^\/api\/health$/, handlers.health],
  [/^\/api\/products$/, handlers.products],
  [/^\/api\/products\/([^/]+)$/, handlers.product],
  [/^\/api\/products\/([^/]+)\/variants$/, handlers.variants],
  [/^\/api\/categories$/, handlers.categories],
  [/^\/api\/images\/(product|variant)\/([^/]+)\/([^/]+)$/, handlers.image],
];

const hits = new Map();
function rateLimited(req) {
  const key = (config.trustProxy && req.headers['x-real-ip']) || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now - entry.start > 60000) {
    if (hits.size > 10000) hits.clear();
    hits.set(key, {start: now, count: 1});
    return false;
  }
  return ++entry.count > config.rateLimitPerMinute;
}

function logError(err) {
  if (err instanceof OdooError) console.error(`[odoo] ${err.kind}: ${err.message}${err.detail ? ` (${err.detail})` : ''}`);
  else if (err instanceof catalog.CatalogError) console.error(`[catalog] ${err.code}: ${err.message}`);
  else console.error('[api]', err);
}

function sendError(res, err) {
  if (err instanceof HttpError) return send(res, err.status, {ok: false, error: {code: err.code, message: err.message}});
  logError(err);
  if (err instanceof catalog.CatalogError) {
    return send(res, 503, {ok: false, error: {code: 'CATALOG_NOT_CONFIGURED', message: 'The catalog is not available.'}});
  }
  if (err instanceof OdooError) {
    return send(res, 502, {ok: false, error: {code: 'UPSTREAM_UNAVAILABLE', message: 'The catalog is temporarily unavailable.'}});
  }
  return send(res, 500, {ok: false, error: {code: 'INTERNAL', message: 'Unexpected server error.'}});
}

const server = http.createServer(async (req, res) => {
  try {
    const host = String(req.headers.host || '').toLowerCase();
    if (!config.allowedHosts.has(host)) throw new HttpError(403, 'FORBIDDEN', 'Host not allowed');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Only GET is supported');
    }
    if (rateLimited(req)) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests');
    if (req.url.length > 512) throw new HttpError(414, 'URI_TOO_LONG', 'URL too long');

    const url = new URL(req.url, 'http://localhost');
    for (const [pattern, handler] of routes) {
      const match = url.pathname.match(pattern);
      if (match) return await handler(req, res, url, match.slice(1));
    }
    throw notFound();
  } catch (err) {
    if (res.headersSent) return res.destroy();
    sendError(res, err);
  }
});

server.requestTimeout = 30000;
server.headersTimeout = 10000;

server.listen(config.port, config.host, () => {
  console.log(`[api] Catalog intermediary listening on http://${config.host}:${config.port} (${config.production ? 'production' : 'development'})`);
  authenticate()
    .then(uid => console.log(`[odoo] Authenticated to ${config.odooUrl} (db ${config.db}) as uid ${uid}`))
    .catch(logError);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
