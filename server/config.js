import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = process.env.API_ENV_FILE || path.join(root, '.env');
// Variables already present in the process environment take precedence over the file.
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function required(name) {
  const value = (process.env[name] || '').trim();
  if (!value || /^YOUR_/i.test(value)) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function integer(name, fallback, min, max) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function load() {
  const odooUrl = new URL(required('ODOO_URL'));
  if (odooUrl.protocol !== 'https:' && !LOOPBACK.has(odooUrl.hostname)) throw new Error('ODOO_URL must use https');

  const host = (process.env.API_HOST || '127.0.0.1').trim();
  if (!LOOPBACK.has(host)) throw new Error('API_HOST must be a loopback address (127.0.0.1, ::1 or localhost)');
  const port = integer('API_PORT', 8787, 1024, 65535);

  const storefrontTag = (process.env.ODOO_STOREFRONT_TAG || 'Storefront').trim();
  if (!storefrontTag || storefrontTag.length > 64) throw new Error('ODOO_STOREFRONT_TAG must be 1-64 characters');

  const extraHosts = (process.env.API_ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);

  return Object.freeze({
    odooUrl: odooUrl.origin,
    db: required('ODOO_DB'),
    username: required('ODOO_USERNAME'),
    password: required('ODOO_PASSWORD'),
    storefrontTag,
    host,
    port,
    timeoutMs: integer('ODOO_TIMEOUT_MS', 15000, 1000, 60000),
    allowedHosts: new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...extraHosts]),
    trustProxy: process.env.TRUST_PROXY === '1',
    rateLimitPerMinute: integer('API_RATE_LIMIT_PER_MINUTE', 300, 10, 10000),
    production: process.env.NODE_ENV === 'production',
  });
}

let config;
try {
  config = load();
} catch (err) {
  console.error(`[config] ${err.message}. Copy .env.example to .env and fill in the values.`);
  process.exit(1);
}

export {config};
