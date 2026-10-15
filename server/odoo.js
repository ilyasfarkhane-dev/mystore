import {config} from './config.js';

// The only Odoo operations this intermediary may perform. Everything is read-only.
const ALLOWED = {
  'product.template': new Set(['search_read', 'search_count', 'fields_get']),
  'product.product': new Set(['search_read', 'fields_get']),
  'product.template.attribute.value': new Set(['search_read']),
  'product.attribute': new Set(['read']),
  'product.public.category': new Set(['read']),
};

export class OdooError extends Error {
  constructor(message, kind = 'odoo', detail = '') {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

let requestId = 0;
let uidPromise = null;

async function rpc(service, method, args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    let res;
    try {
      res = await fetch(`${config.odooUrl}/jsonrpc`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', method: 'call', params: {service, method, args}, id: ++requestId}),
        signal: controller.signal,
      });
    } catch (err) {
      throw new OdooError('Odoo is unreachable', 'network', err.name === 'AbortError' ? 'timeout' : err.message);
    }
    if (!res.ok) throw new OdooError(`Odoo responded with HTTP ${res.status}`, 'http');
    let body;
    try {
      body = await res.json();
    } catch {
      throw new OdooError('Odoo returned invalid JSON', 'protocol');
    }
    if (body.error) {
      const name = body.error.data?.name || '';
      const message = String(body.error.data?.message || body.error.message || '').slice(0, 300);
      throw new OdooError('Odoo returned an error', /AccessDenied|AccessError/.test(name) ? 'access' : 'odoo', `${name}: ${message}`);
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

export function authenticate() {
  if (!uidPromise) {
    uidPromise = rpc('common', 'authenticate', [config.db, config.username, config.password, {}])
      .then(uid => {
        if (!Number.isInteger(uid) || uid <= 0) throw new OdooError('Odoo authentication failed', 'auth');
        return uid;
      })
      .catch(err => {
        uidPromise = null;
        throw err;
      });
  }
  return uidPromise;
}

export async function executeKw(model, method, args = [], kwargs = {}) {
  if (!ALLOWED[model]?.has(method)) throw new OdooError(`Operation ${model}.${method} is not allowed`, 'forbidden');
  const uid = await authenticate();
  try {
    return await rpc('object', 'execute_kw', [config.db, uid, config.password, model, method, args, kwargs]);
  } catch (err) {
    if (err.kind === 'access') uidPromise = null;
    throw err;
  }
}
