'use strict';
const v = require('../middleware/validation');
const { decimal, units } = require('./inventory-values');
const { httpError } = require('../middleware/errors');
const fail = (code, field) => { throw Object.assign(httpError(400, code), { field }); };

function optionalText(value, max, field) {
  if (value === undefined || value === null || value === '') return null;
  try { return v.text(value, max); } catch { fail('INVALID_INPUT', field); }
}
function money(value, field) {
  try { return decimal(value, 2, 10); } catch { fail('INVALID_INPUT', field); }
}
function supplier(body, editing = false) {
  const fields = ['name', 'contact', 'phone', 'ruc', 'address'];
  const data = v.body(body, fields, editing ? [] : ['name']);
  const result = {};
  if (Object.hasOwn(data, 'name')) { try { result.name = v.text(data.name, 180); } catch { fail('INVALID_INPUT', 'name'); } }
  for (const [field, max] of [['contact', 160], ['phone', 40], ['ruc', 64], ['address', 255]]) {
    if (Object.hasOwn(data, field)) result[field] = optionalText(data[field], max, field);
  }
  if (editing && !Object.keys(result).length) fail('INVALID_INPUT');
  return result;
}
function active(body) {
  const data = v.body(body, ['active']);
  if (typeof data.active !== 'boolean') fail('INVALID_INPUT', 'active');
  return data.active;
}
function operationKey(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) fail('OPERATION_KEY_INVALID', 'operationKey');
  return value;
}
function purchase(body) {
  const data = v.body(body, ['operationKey', 'supplierId', 'invoiceNumber', 'supplierInvoiceNumber', 'purchaseType', 'paymentMethod', 'dueDays', 'items'], ['operationKey', 'supplierId', 'purchaseType', 'items']);
  if (Object.hasOwn(data, 'invoiceNumber') && Object.hasOwn(data, 'supplierInvoiceNumber')) fail('INVALID_INPUT', 'supplierInvoiceNumber');
  const supplierInvoiceNumber = optionalText(data.supplierInvoiceNumber ?? data.invoiceNumber, 100, 'supplierInvoiceNumber');
  if (supplierInvoiceNumber && /^COMP-\d{6,}$/i.test(supplierInvoiceNumber)) fail('INVALID_INPUT', 'supplierInvoiceNumber');
  if (!['CASH', 'CREDIT'].includes(data.purchaseType)) fail('INVALID_INPUT', 'purchaseType');
  let paymentMethod = null, dueDays = null;
  if (data.purchaseType === 'CASH') {
    if (!['CASH', 'CARD', 'TRANSFER', 'OTHER'].includes(data.paymentMethod)) fail('PAYMENT_METHOD_REQUIRED', 'paymentMethod');
    paymentMethod = data.paymentMethod;
    if (data.dueDays !== undefined && data.dueDays !== null) fail('INVALID_INPUT', 'dueDays');
  } else {
    if (data.paymentMethod !== undefined && data.paymentMethod !== null) fail('INVALID_INPUT', 'paymentMethod');
    dueDays = Number(data.dueDays);
    if (!Number.isInteger(dueDays) || dueDays < 1 || dueDays > 3650) fail('INVALID_INPUT', 'dueDays');
  }
  if (!Array.isArray(data.items) || !data.items.length || data.items.length > 100) fail('CART_EMPTY', 'items');
  const seen = new Set();
  const items = data.items.map(item => {
    v.body(item, ['productId', 'quantity', 'unitCost']);
    const productId = v.id(item.productId);
    if (seen.has(productId)) fail('INVALID_INPUT', 'items');
    seen.add(productId);
    let quantity, unitCost;
    try { quantity = decimal(item.quantity, 3, 9); } catch { fail('QUANTITY_INVALID', 'quantity'); }
    try { unitCost = money(item.unitCost, 'unitCost'); } catch { fail('INVALID_INPUT', 'unitCost'); }
    if (units(quantity) <= 0n) fail('QUANTITY_INVALID', 'quantity');
    return { productId, quantity, unitCost };
  });
  return { operationKey: operationKey(data.operationKey), supplierId: v.id(data.supplierId), invoiceNumber: supplierInvoiceNumber || '', supplierInvoiceNumber, purchaseType: data.purchaseType, paymentMethod, dueDays, items };
}
function payment(body) {
  const data = v.body(body, ['operationKey', 'amount', 'paymentMethod']);
  if (!['CASH', 'CARD', 'TRANSFER', 'OTHER'].includes(data.paymentMethod)) fail('PAYMENT_METHOD_REQUIRED', 'paymentMethod');
  const amount = money(data.amount, 'amount');
  if (units(amount) <= 0n) fail('INVALID_INPUT', 'amount');
  return { operationKey: operationKey(data.operationKey), amount, paymentMethod: data.paymentMethod };
}
function cancellation(body) {
  const data = v.body(body, ['operationKey', 'reason']);
  let reason;
  try { reason = v.text(data.reason, 500); } catch { throw Object.assign(httpError(400, 'REASON_REQUIRED'), { field: 'reason' }); }
  return { operationKey: operationKey(data.operationKey), reason };
}
module.exports = { supplier, active, purchase, payment, cancellation, operationKey };
