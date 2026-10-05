'use strict';
const v = require('../middleware/validation');
const { decimal, fixed, units } = require('./inventory-values');
const { httpError } = require('../middleware/errors');
const fail = (code, field) => { throw Object.assign(httpError(400, code), { field }); };
function number(value, scale, digits, code, field) {
  try { return decimal(value, scale, digits); } catch { fail(code, field); }
}
function operationKey(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) fail('OPERATION_KEY_INVALID', 'operationKey');
  return value;
}
function cart(data) {
  if (!Array.isArray(data.items) || data.items.length === 0) fail('CART_EMPTY', 'items');
  if (data.items.length > 100) fail('QUANTITY_INVALID', 'items');
  const seen = new Set();
  const items = data.items.map(item => {
    v.body(item, ['productId', 'quantity']);
    const productId = v.id(item.productId);
    if (seen.has(productId)) fail('QUANTITY_INVALID', 'items');
    seen.add(productId);
    const quantity = number(item.quantity, 3, 9, 'QUANTITY_INVALID', 'quantity');
    if (units(quantity) <= 0n) fail('QUANTITY_INVALID', 'quantity');
    return { productId, quantity };
  }).sort((a, b) => BigInt(a.productId) < BigInt(b.productId) ? -1 : 1);
  if (!['RETAIL', 'WHOLESALE'].includes(data.priceType)) fail('PRICE_TYPE_INVALID', 'priceType');
  if (!['CASH', 'CARD', 'TRANSFER', 'CREDIT'].includes(data.paymentMethod)) fail('PAYMENT_METHOD_REQUIRED', 'paymentMethod');
  const clientId = data.paymentMethod === 'CREDIT' ? (data.clientId ? v.id(data.clientId) : null) : null;
  if (data.paymentMethod === 'CREDIT' && !clientId) fail('CREDIT_CLIENT_REQUIRED', 'clientId');
  const discountPercent = number(data.discountPercent, 4, 3, 'DISCOUNT_INVALID', 'discountPercent');
  if (units(discountPercent) > 1000000n) fail('DISCOUNT_INVALID', 'discountPercent');
  return { items, priceType: data.priceType, paymentMethod: data.paymentMethod, discountPercent, clientId };
}
const quoteFields = ['items', 'priceType', 'paymentMethod', 'discountPercent', 'clientId'];
function quote(body) { return cart(v.body(body, quoteFields, ['items', 'priceType', 'paymentMethod', 'discountPercent'])); }
function sale(body) {
  const fields = [...quoteFields, 'operationKey', 'quoteToken', 'cashReceived', 'detail'];
  const data = v.body(body, fields, fields.filter(field => field !== 'clientId'));
  const result = { ...cart(data), operationKey: operationKey(data.operationKey) };
  if (typeof data.quoteToken !== 'string' || !/^[a-f0-9]{64}$/.test(data.quoteToken)) fail('QUOTE_CHANGED', 'quoteToken');
  result.quoteToken = data.quoteToken;
  result.cashReceived = result.paymentMethod === 'CASH' ? number(data.cashReceived, 2, 10, 'CASH_INVALID', 'cashReceived') : null;
  if (result.paymentMethod !== 'CASH' && data.cashReceived !== null) fail('CASH_INVALID', 'cashReceived');
  if (typeof data.detail !== 'string' || data.detail.length > 500 || [...data.detail].some(character => character.charCodeAt(0) <= 31)) fail('DETAIL_INVALID', 'detail');
  result.detail = data.detail.trim();
  return result;
}
function order(body) {
  const fields = ['items', 'priceType', 'discountPercent', 'detail', 'operationKey', 'clientId'];
  const data = v.body(body, fields, fields.filter(field => field !== 'clientId'));
  const items = cart({ ...data, paymentMethod: 'CASH' });
  if (typeof data.detail !== 'string' || data.detail.length > 500 || [...data.detail].some(character => character.charCodeAt(0) <= 31)) fail('DETAIL_INVALID', 'detail');
  const clientId = data.clientId === undefined || data.clientId === null ? null : v.id(data.clientId);
  return { ...items, clientId, detail: data.detail.trim(), operationKey: operationKey(data.operationKey) };
}
function orderQuote(body) {
  const data = v.body(body, ['paymentMethod']);
  if (!['CASH', 'CARD', 'TRANSFER', 'CREDIT'].includes(data.paymentMethod)) fail('PAYMENT_METHOD_REQUIRED', 'paymentMethod');
  return { paymentMethod: data.paymentMethod };
}
function orderCharge(body) {
  const data = v.body(body, ['operationKey', 'quoteToken', 'paymentMethod', 'cashReceived']);
  if (typeof data.quoteToken !== 'string' || !/^[a-f0-9]{64}$/.test(data.quoteToken)) fail('QUOTE_CHANGED', 'quoteToken');
  if (!['CASH', 'CARD', 'TRANSFER', 'CREDIT'].includes(data.paymentMethod)) fail('PAYMENT_METHOD_REQUIRED', 'paymentMethod');
  const cashReceived = data.paymentMethod === 'CASH' ? number(data.cashReceived, 2, 10, 'CASH_INVALID', 'cashReceived') : null;
  if (data.paymentMethod !== 'CASH' && data.cashReceived !== null) fail('CASH_INVALID', 'cashReceived');
  return { operationKey: operationKey(data.operationKey), quoteToken: data.quoteToken, paymentMethod: data.paymentMethod, cashReceived };
}
function salesFlow(body) {
  const data = v.body(body, ['salesFlow']);
  if (!['DIRECT', 'CENTRALIZED'].includes(data.salesFlow)) fail('INVALID_INPUT', 'salesFlow');
  return data.salesFlow;
}
function paymentConfirmation(body) {
  return { operationKey: operationKey(v.body(body, ['operationKey']).operationKey) };
}
function cash(body, closing = false) {
  const fields = closing ? ['operationKey', 'countedAmount'] : ['operationKey', 'openingAmount'];
  const data = v.body(body, fields);
  const field = closing ? 'countedAmount' : 'openingAmount';
  return { operationKey: operationKey(data.operationKey), [field]: number(data[field], 2, 10, 'CASH_INVALID', field) };
}
function cancel(body) {
  const data = v.body(body, ['operationKey', 'reason']);
  let reason;
  try { reason = v.text(data.reason, 500); } catch { fail('REASON_REQUIRED', 'reason'); }
  return { operationKey: operationKey(data.operationKey), reason };
}
function calculate(products, data) {
  const lines = data.items.map(item => {
    const product = products.find(p => String(p.id) === item.productId);
    if (!product || product.deleted) throw httpError(404, 'PRODUCT_NOT_FOUND');
    if (!product.active) throw httpError(409, 'PRODUCT_INACTIVE');
    if (units(product.stock) < units(item.quantity)) throw httpError(409, 'INSUFFICIENT_STOCK');
    const price = data.priceType === 'RETAIL' ? product.retail_price : product.wholesale_price;
    const subtotal = (units(price) * units(item.quantity) + 500n) / 1000n;
    return { product, productId: item.productId, quantity: item.quantity, unitPrice: price, subtotalUnits: subtotal };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.subtotalUnits, 0n);
  const percent = units(data.discountPercent);
  const discount = (subtotal * percent + 500000n) / 1000000n;
  let cumulative = 0n, allocated = 0n;
  for (const line of lines) {
    cumulative += line.subtotalUnits;
    const target = (cumulative * percent + 500000n) / 1000000n;
    line.discountUnits = target - allocated; allocated = target;
    line.totalUnits = line.subtotalUnits - line.discountUnits;
    line.subtotal = fixed(line.subtotalUnits, 2); line.discount = fixed(line.discountUnits, 2); line.total = fixed(line.totalUnits, 2);
  }
  if (subtotal >= 1000000000000n) fail('TOTAL_LIMIT', 'items');
  return { lines, subtotal: fixed(subtotal, 2), discount: fixed(discount, 2), tax: '0.00', total: fixed(subtotal - discount, 2) };
}
module.exports = { quote, sale, order, orderQuote, orderCharge, salesFlow, paymentConfirmation, cash, cancel, operationKey, calculate };
