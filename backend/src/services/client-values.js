'use strict';
const v = require('../middleware/validation');
const { decimal, units } = require('./inventory-values');
const { httpError } = require('../middleware/errors');
const fail = (code, field) => { throw Object.assign(httpError(400, code), { field }); };
function optionalText(value, max, field) {
  if (value === null || value === undefined || value === '') return null;
  try { return v.text(value, max); } catch { fail('INVALID_INPUT', field); }
}
function money(value, field) {
  try { return decimal(value, 2, 10); } catch { fail('INVALID_INPUT', field); }
}
function client(body, editing = false) {
  const fields = ['name', 'phone', 'ruc', 'address', 'creditLimit', 'creditDays'];
  const data = v.body(body, fields, editing ? [] : fields);
  const result = {};
  if (Object.hasOwn(data, 'name')) { try { result.name = v.text(data.name, 180); } catch { fail('INVALID_INPUT', 'name'); } }
  else if (!editing) fail('INVALID_INPUT', 'name');
  result.phone = optionalText(data.phone, 40, 'phone');
  result.ruc = optionalText(data.ruc, 64, 'ruc');
  result.address = optionalText(data.address, 255, 'address');
  if (Object.hasOwn(data, 'creditLimit')) result.creditLimit = money(data.creditLimit, 'creditLimit');
  if (Object.hasOwn(data, 'creditDays')) {
    const days = Number(data.creditDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) fail('INVALID_INPUT', 'creditDays');
    result.creditDays = days;
  }
  return result;
}
function active(body) {
  const data = v.body(body, ['active']);
  if (typeof data.active !== 'boolean') fail('INVALID_INPUT', 'active');
  return data.active;
}
function payment(body, operationKey) {
  const data = v.body(body, ['amount', 'paymentMethod', 'operationKey']);
  if (!['CASH', 'CARD', 'TRANSFER'].includes(data.paymentMethod)) fail('PAYMENT_METHOD_REQUIRED', 'paymentMethod');
  const value = operationKey(data.operationKey);
  const amount = money(data.amount, 'amount');
  if (units(amount) <= 0n) fail('INVALID_INPUT', 'amount');
  return { amount, paymentMethod: data.paymentMethod, operationKey: value };
}
module.exports = { client, active, payment };
