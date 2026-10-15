// Read-only checks against a running intermediary: npm run api, then npm run test:api
import fs from 'node:fs';
import path from 'node:path';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const base = process.env.SMOKE_BASE_URL || `http://127.0.0.1:${process.env.API_PORT || 8787}`;
const secrets = [process.env.ODOO_PASSWORD, process.env.ODOO_USERNAME].filter(s => s && s.length >= 4);

let failures = 0;
const check = (label, condition, extra = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
  if (!condition) failures++;
};

async function get(pathname, init) {
  const res = await fetch(base + pathname, init);
  const text = await res.text();
  check(`no credentials in ${init?.method || 'GET'} ${pathname}`, !secrets.some(s => text.includes(s)));
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return {status: res.status, body};
}

const health = await get('/api/health');
check('health', health.status === 200 && health.body.ok);

const list = await get('/api/products?limit=48');
check('GET /api/products', list.status === 200 && Array.isArray(list.body?.data), `status ${list.status} ${list.body?.error?.code || ''}`);
const products = list.body?.data || [];
console.log(`      ${products.length} published products (total ${list.body?.meta?.total})`);

const cats = await get('/api/categories');
check('GET /api/categories', cats.status === 200 && Array.isArray(cats.body?.data), `${cats.body?.data?.length ?? 0} categories`);

for (const summary of products) {
  const {status, body} = await get(`/api/products/${summary.id}`);
  check(`GET /api/products/${summary.id}`, status === 200 && body.data.id === summary.id);
  const product = body.data;
  const variants = (await get(`/api/products/${summary.id}/variants`)).body.data;
  check(`variants endpoint matches detail for ${product.name}`, variants.length === product.variants.length);

  const names = product.attributes.map(a => a.name);
  const combos = new Set();
  let resolved = true;
  for (const v of product.variants) {
    if (names.some(n => !v.options[n]) || v.value_ids.length !== names.length) resolved = false;
    combos.add(names.map(n => v.options[n]).join('|'));
  }
  check(`${product.name}: every variant resolves all attributes (${names.join(', ') || 'none'})`, resolved);
  check(`${product.name}: attribute combinations are unique`, combos.size === product.variants.length);
  console.log(`      ${product.name}: ${product.variant_count} variants, ${product.price} ${product.currency}, image ${product.image ? 'yes' : 'no'}`);
  console.table(product.variants.map(v => ({id: v.id, ...v.options, price: v.price, on_hand: v.stock.on_hand, available: v.stock.available, in_stock: v.stock.in_stock})));

  if (product.image) {
    const res = await fetch(base + product.image);
    check(`image ${product.image}`, res.ok && /^image\/(png|jpeg|webp|gif)$/.test(res.headers.get('content-type')));
  }
}

const expectStatus = async (label, pathname, status, init) => {
  const res = await get(pathname, init);
  check(label, res.status === status && res.body?.ok === false, `got ${res.status}`);
};
await expectStatus('rejects non-numeric id', '/api/products/abc', 400);
await expectStatus('rejects oversized limit', '/api/products?limit=1000', 400);
await expectStatus('rejects unknown query parameter', '/api/products?domain=x', 400);
await expectStatus('rejects negative offset', '/api/products?offset=-1', 400);
await expectStatus('unknown product is 404', '/api/products/2147483647', 404);
await expectStatus('rejects POST', '/api/products', 405, {method: 'POST', body: '{}'});
await expectStatus('no generic RPC route', '/api/jsonrpc', 404);
await expectStatus('rejects unsupported image size', '/api/images/product/1/9999', 400);

if (fs.existsSync('dist')) {
  const files = fs.readdirSync('dist', {recursive: true}).map(f => path.join('dist', f)).filter(f => fs.statSync(f).isFile());
  const leaked = files.filter(f => {
    const text = fs.readFileSync(f, 'utf8');
    return secrets.some(s => text.includes(s)) || text.includes('ODOO_PASSWORD');
  });
  check('production bundle contains no Odoo credentials', leaked.length === 0, leaked.join(', '));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
