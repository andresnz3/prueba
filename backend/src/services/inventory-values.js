'use strict';
const v = require('../middleware/validation');
const { httpError } = require('../middleware/errors');
function decimal(value, scale, digits, signed = false) {
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) v.invalid();
  const raw = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match || (!signed && match[1]) || (match[3] || '').length > scale) v.invalid();
  const units = BigInt(match[2] + (match[3] || '').padEnd(scale, '0')) * (match[1] ? -1n : 1n);
  if (units <= -(10n ** BigInt(digits + scale)) || units >= 10n ** BigInt(digits + scale)) v.invalid();
  return fixed(units, scale);
}
function fixed(units, scale) {
  const negative = units < 0n;
  const raw = (negative ? -units : units).toString().padStart(scale + 1, '0');
  return (negative ? '-' : '') + raw.slice(0, -scale) + '.' + raw.slice(-scale);
}
function units(value) { return BigInt(String(value).replace('.', '')); }
function image(value) {
  if (value === null) return null;
  if (typeof value === 'string' && value.startsWith('data:')) throw httpError(400,'IMAGE_REQUIRES_UPLOAD');
  if (typeof value !== 'string' || !/^\/api\/product-images\/[1-9]\d{0,19}\/[a-f0-9]{32}\.jpg$/.test(value)) throw httpError(400,'IMAGE_REFERENCE_INVALID');
  return value;
}
const fields = ['barcode', 'name', 'category', 'cost', 'marginRetail', 'marginWholesale', 'retailPrice', 'wholesalePrice', 'stock', 'minStock', 'taxRate', 'image', 'active'];
function product(body, editing = false) {
  const data = v.body(body, editing ? [...fields, 'revision'] : fields, editing ? ['revision'] : ['barcode', 'name', 'category', 'cost', 'marginRetail', 'marginWholesale', 'retailPrice', 'wholesalePrice', 'stock', 'minStock']);
  if (editing && (!/^[a-f0-9]{64}$/.test(data.revision || '') || Object.keys(data).length < 2)) v.invalid();
  const result = {};
  for (const field of fields) {
    if (!Object.hasOwn(data, field)) continue;
    try {
    if (['barcode', 'name', 'category'].includes(field)) result[field] = v.text(data[field], field === 'name' ? 180 : 100);
    else if (['cost', 'retailPrice', 'wholesalePrice'].includes(field)) result[field] = decimal(data[field], 2, 10);
    else if (['stock', 'minStock'].includes(field)) result[field] = decimal(data[field], 3, 9);
    else if (['marginRetail', 'marginWholesale'].includes(field)) result[field] = decimal(data[field], 4, 3, true);
    else if (field === 'taxRate') result[field] = decimal(data[field], 4, 3);
    else if (field === 'image') result[field] = image(data[field]);
    else { if (typeof data.active !== 'boolean') v.invalid(); result.active = data.active; }
    } catch (error) { error.field = field; throw error; }
  }
  if (!editing) return { taxRate: '0.0000', image: null, active: true, ...result };
  return { ...result, revision: data.revision };
}
function movement(body) {
  const data = v.body(body, ['type', 'quantity', 'reason']);
  if (!['ADJUSTMENT', 'WASTE'].includes(data.type)) v.invalid();
  let quantity;
  try { quantity = decimal(data.quantity, 3, 9, data.type === 'ADJUSTMENT'); } catch (error) { error.field = 'quantity'; throw error; }
  if (units(quantity) === 0n) v.invalid();
  return { type: data.type, quantity, reason: v.text(data.reason, 500) };
}
function page(query, allowed = []) {
  if (Object.keys(query).some(key => !['limit', 'offset', ...allowed].includes(key))) v.invalid();
  const limit = query.limit ?? '100', offset = query.offset ?? '0';
  if (typeof limit !== 'string' || !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 || typeof offset !== 'string' || !/^\d{1,7}$/.test(offset)) v.invalid();
  return { limit: Number(limit), offset: Number(offset) };
}
module.exports = { decimal, fixed, units, product, movement, page };
