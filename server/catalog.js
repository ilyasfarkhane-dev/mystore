import {config} from './config.js';
import {executeKw} from './odoo.js';

export class CatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const IMAGE_SIZES = new Set([128, 256, 512, 1024]);
const BIN_SIZE = {bin_size: true};

let schemaPromise = null;

async function loadSchema() {
  const [tmpl, prod] = await Promise.all([
    executeKw('product.template', 'fields_get', [], {attributes: ['type']}),
    executeKw('product.product', 'fields_get', [], {attributes: ['type']}),
  ]);
  const schema = {tmpl: new Set(Object.keys(tmpl)), prod: new Set(Object.keys(prod))};
  for (const f of ['qty_available', 'free_qty']) {
    if (!schema.prod.has(f)) console.warn(`[catalog] product.product.${f} is not readable; variants will be reported as unavailable`);
  }
  return schema;
}

function getSchema() {
  if (!schemaPromise) schemaPromise = loadSchema().catch(err => {
    schemaPromise = null;
    throw err;
  });
  return schemaPromise;
}

// A product is public only when it is sellable and explicitly tagged for the storefront in Odoo.
// If eCommerce is installed, it must also be published.
function publicDomain(schema) {
  if (!schema.tmpl.has('product_tag_ids')) {
    throw new CatalogError('CATALOG_NOT_CONFIGURED', 'product.template.product_tag_ids is not available to the integration user');
  }
  const domain = [['sale_ok', '=', true], ['product_tag_ids.name', '=', config.storefrontTag]];
  if (schema.tmpl.has('is_published')) domain.push(['is_published', '=', true]);
  return domain;
}

const pick = (available, fields) => fields.filter(f => available.has(f));
const m2oName = v => (Array.isArray(v) ? v[1] : null);
const imageVersion = writeDate => encodeURIComponent(String(writeDate || '').replace(/\D/g, ''));

function htmlToText(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

function attributeKind(attribute) {
  if (attribute.display_type === 'color' || /colou?r|couleur/i.test(attribute.name)) return 'color';
  if (/size|taille|pointure/i.test(attribute.name)) return 'size';
  return 'other';
}

function templateFields(schema) {
  return ['id', 'name', 'list_price', 'currency_id', 'description_sale', 'write_date', 'image_1920',
    ...pick(schema.tmpl, ['description_ecommerce', 'public_categ_ids', 'is_storable', 'type'])];
}

function templateOrder(schema) {
  return schema.tmpl.has('website_sequence') ? 'website_sequence asc, id asc' : 'id asc';
}

async function fetchVariants(schema, templateIds) {
  if (!templateIds.length) return [];
  const fields = ['id', 'product_tmpl_id', 'product_template_attribute_value_ids', 'lst_price', 'write_date', 'image_variant_1920',
    ...pick(schema.prod, ['qty_available', 'free_qty'])];
  return executeKw('product.product', 'search_read', [[['product_tmpl_id', 'in', templateIds]]], {fields, order: 'id asc', context: BIN_SIZE});
}

async function fetchAttributeValues(variants) {
  const ids = [...new Set(variants.flatMap(v => v.product_template_attribute_value_ids))];
  if (!ids.length) return {values: new Map(), attributes: new Map()};
  // search_read (unlike read) applies the model's natural ordering, which follows the attribute value sequence.
  const ptavs = await executeKw('product.template.attribute.value', 'search_read', [[['id', 'in', ids]]], {
    fields: ['id', 'name', 'attribute_id', 'html_color'],
  });
  const attributeIds = [...new Set(ptavs.map(p => p.attribute_id[0]))];
  const attrs = attributeIds.length ? await executeKw('product.attribute', 'read', [attributeIds], {fields: ['id', 'name', 'display_type', 'sequence']}) : [];
  return {
    values: new Map(ptavs.map((p, index) => [p.id, {...p, index}])),
    attributes: new Map(attrs.map(a => [a.id, {...a, kind: attributeKind(a)}])),
  };
}

async function fetchCategories(ids) {
  if (!ids.length) return new Map();
  const rows = await executeKw('product.public.category', 'read', [ids], {fields: ['id', 'name']});
  return new Map(rows.map(c => [c.id, {id: c.id, name: c.name}]));
}

function isTracked(template) {
  if ('is_storable' in template) return !!template.is_storable;
  return template.type === 'product';
}

function serializeVariant(variant, template, lookup) {
  const tracked = isTracked(template);
  const hasStock = 'free_qty' in variant && 'qty_available' in variant;
  const available = hasStock ? variant.free_qty : null;
  const options = {};
  const valueIds = [];
  for (const id of variant.product_template_attribute_value_ids) {
    const value = lookup.values.get(id);
    if (!value) continue;
    const attribute = lookup.attributes.get(value.attribute_id[0]);
    options[attribute ? attribute.name : value.attribute_id[1]] = value.name;
    valueIds.push(id);
  }
  return {
    id: variant.id,
    product_id: template.id,
    price: variant.lst_price,
    image: variant.image_variant_1920 ? `/api/images/variant/${variant.id}/512?v=${imageVersion(variant.write_date)}` : null,
    value_ids: valueIds,
    options,
    stock: {
      tracked,
      on_hand: tracked && hasStock ? variant.qty_available : null,
      available: tracked ? available : null,
      in_stock: tracked ? (available ?? 0) > 0 : true,
    },
  };
}

function serializeProduct(template, variants, lookup, categories, {includeVariants}) {
  const serialized = variants.map(v => serializeVariant(v, template, lookup));
  const usedValueIds = new Set(serialized.flatMap(v => v.value_ids));

  const attributeMap = new Map();
  for (const id of usedValueIds) {
    const value = lookup.values.get(id);
    const attrId = value.attribute_id[0];
    const attribute = lookup.attributes.get(attrId) || {id: attrId, name: value.attribute_id[1], kind: 'other', sequence: 0};
    if (!attributeMap.has(attrId)) attributeMap.set(attrId, {id: attrId, name: attribute.name, kind: attribute.kind, sequence: attribute.sequence ?? 0, values: []});
    attributeMap.get(attrId).values.push({id: value.id, name: value.name, color: attribute.kind === 'color' && value.html_color ? value.html_color : null, index: value.index});
  }
  const attributes = [...attributeMap.values()]
    .sort((a, b) => a.sequence - b.sequence || a.id - b.id)
    .map(({sequence, values, ...a}) => ({...a, values: values.sort((x, y) => x.index - y.index).map(({index, ...v}) => v)}));

  const prices = serialized.map(v => v.price);
  const productCategories = (template.public_categ_ids || []).map(id => categories.get(id)).filter(Boolean);
  const description = (template.description_sale || '').trim() || htmlToText(template.description_ecommerce);

  const product = {
    id: template.id,
    name: template.name,
    description,
    price: prices.length ? Math.min(...prices) : template.list_price,
    price_max: prices.length ? Math.max(...prices) : template.list_price,
    tax_included: false,
    currency: m2oName(template.currency_id),
    categories: productCategories,
    category: productCategories[0]?.name || null,
    image: template.image_1920 ? `/api/images/product/${template.id}/512?v=${imageVersion(template.write_date)}` : null,
    attributes,
    variant_count: serialized.length,
    in_stock: serialized.some(v => v.stock.in_stock),
  };
  if (includeVariants) product.variants = serialized;
  return product;
}

async function buildProducts(schema, templates, options) {
  const variants = await fetchVariants(schema, templates.map(t => t.id));
  const [lookup, categories] = await Promise.all([
    fetchAttributeValues(variants),
    fetchCategories([...new Set(templates.flatMap(t => t.public_categ_ids || []))]),
  ]);
  const byTemplate = new Map(templates.map(t => [t.id, []]));
  for (const v of variants) byTemplate.get(v.product_tmpl_id[0])?.push(v);
  return templates.map(t => serializeProduct(t, byTemplate.get(t.id), lookup, categories, options));
}

async function findTemplate(schema, id) {
  const rows = await executeKw('product.template', 'search_read', [[['id', '=', id], ...publicDomain(schema)]], {
    fields: templateFields(schema), limit: 1, context: BIN_SIZE,
  });
  return rows[0] || null;
}

export async function listProducts({limit, offset, categoryId, q}) {
  const schema = await getSchema();
  const domain = [...publicDomain(schema)];
  if (categoryId) {
    if (!schema.tmpl.has('public_categ_ids')) return {items: [], total: 0};
    domain.push(['public_categ_ids', 'child_of', categoryId]);
  }
  if (q) domain.push(['name', 'ilike', q]);
  const [total, templates] = await Promise.all([
    executeKw('product.template', 'search_count', [domain]),
    executeKw('product.template', 'search_read', [domain], {fields: templateFields(schema), limit, offset, order: templateOrder(schema), context: BIN_SIZE}),
  ]);
  return {items: await buildProducts(schema, templates, {includeVariants: false}), total};
}

export async function getProduct(id) {
  const schema = await getSchema();
  const template = await findTemplate(schema, id);
  if (!template) return null;
  const [product] = await buildProducts(schema, [template], {includeVariants: true});
  return product;
}

export async function getVariants(id) {
  const product = await getProduct(id);
  return product ? product.variants : null;
}

export async function listCategories() {
  const schema = await getSchema();
  if (!schema.tmpl.has('public_categ_ids')) return [];
  const templates = await executeKw('product.template', 'search_read', [publicDomain(schema)], {fields: ['public_categ_ids'], limit: 5000});
  const counts = new Map();
  for (const t of templates) for (const id of t.public_categ_ids) counts.set(id, (counts.get(id) || 0) + 1);
  if (!counts.size) return [];
  const rows = await executeKw('product.public.category', 'read', [[...counts.keys()]], {fields: ['id', 'name', 'sequence']});
  return rows
    .sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name))
    .map(c => ({id: c.id, name: c.name, product_count: counts.get(c.id)}));
}

function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null; // SVG and anything else is refused.
}

export async function getImage(kind, id, size) {
  const schema = await getSchema();
  const model = kind === 'product' ? 'product.template' : 'product.product';
  const field = `image_${size}`;
  const rows = await executeKw(model, 'search_read', [[['id', '=', id], ...publicDomain(schema)]], {fields: [field], limit: 1});
  const data = rows[0]?.[field];
  if (!data) return null;
  const body = Buffer.from(data, 'base64');
  const type = sniffImage(body);
  return type ? {body, type} : null;
}
