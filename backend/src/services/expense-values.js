'use strict';
const v = require('../middleware/validation');
const { decimal } = require('./inventory-values');
const { httpError } = require('../middleware/errors');

const fail = (code, field) => { throw Object.assign(httpError(400, code), field ? { field } : {}); };

function operationKey(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) fail('OPERATION_KEY_INVALID', 'operationKey');
  return value;
}

function expense(body) {
  const data = v.body(body, ['operationKey', 'category', 'description', 'receiptReference', 'amount', 'paymentMethod']);
  if (!['Servicios Básicos', 'Renta / Alquiler', 'Transporte', 'Sueldos', 'Mantenimiento', 'Insumos de Limpieza', 'Otro'].includes(data.category)) fail('INVALID_INPUT', 'category');
  if (!['CASH', 'BANK', 'PENDING'].includes(data.paymentMethod)) fail('PAYMENT_METHOD_REQUIRED', 'paymentMethod');
  let description, receiptReference, amount;
  try { description = v.text(data.description, 500); } catch { fail('INVALID_INPUT', 'description'); }
  try { receiptReference = data.receiptReference === '' || data.receiptReference === null ? null : v.text(data.receiptReference, 100); } catch { fail('INVALID_INPUT', 'receiptReference'); }
  try { amount = decimal(data.amount, 2, 10); } catch { fail('INVALID_INPUT', 'amount'); }
  if (Number(amount) <= 0) fail('INVALID_INPUT', 'amount');
  return { operationKey: operationKey(data.operationKey), category: data.category, description, receiptReference, amount, paymentMethod: data.paymentMethod };
}

function cancellation(body) {
  const data = v.body(body, ['operationKey', 'reason']);
  let reason;
  try { reason = v.text(data.reason, 500); } catch { fail('REASON_REQUIRED', 'reason'); }
  return { operationKey: operationKey(data.operationKey), reason };
}

module.exports = { expense, cancellation, operationKey };
