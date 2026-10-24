'use strict';
const v = require('../middleware/validation');
const { httpError } = require('../middleware/errors');

function fail(field) { throw Object.assign(httpError(400, 'INVALID_INPUT'), field ? { field } : {}); }
function optionalText(value, max, field) {
  if (value === undefined || value === null || value === '') return null;
  try { return v.text(value, max); } catch { fail(field); }
}
function stockValue(value) {
  const number = typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0 || number > 999999999.999 || Math.round(number * 1000) !== number * 1000) fail('minStockDefault');
  return number.toFixed(3);
}
function settings(body) {
  const data = v.body(body, ['businessName', 'legalName', 'ruc', 'phone', 'address', 'ticketHeader', 'ticketFooter', 'minStockDefault']);
  let businessName;
  try { businessName = v.text(data.businessName, 160); } catch { fail('businessName'); }
  return {
    businessName,
    legalName: optionalText(data.legalName, 160, 'legalName'),
    ruc: optionalText(data.ruc, 64, 'ruc'),
    phone: optionalText(data.phone, 40, 'phone'),
    address: optionalText(data.address, 255, 'address'),
    ticketHeader: optionalText(data.ticketHeader, 500, 'ticketHeader'),
    ticketFooter: optionalText(data.ticketFooter, 500, 'ticketFooter'),
    minStockDefault: stockValue(data.minStockDefault)
  };
}
function legacySettings(body) {
  const data = v.body(body, ['sourceBusinessName', 'legalName', 'ruc', 'phone', 'address', 'ticketHeader', 'ticketFooter', 'minStockDefault']);
  let sourceBusinessName;
  try { sourceBusinessName = v.text(data.sourceBusinessName, 160); } catch { fail('sourceBusinessName'); }
  return {
    sourceBusinessName,
    legalName: optionalText(data.legalName, 160, 'legalName'),
    ruc: optionalText(data.ruc, 64, 'ruc'),
    phone: optionalText(data.phone, 40, 'phone'),
    address: optionalText(data.address, 255, 'address'),
    ticketHeader: optionalText(data.ticketHeader, 500, 'ticketHeader'),
    ticketFooter: optionalText(data.ticketFooter, 500, 'ticketFooter'),
    minStockDefault: stockValue(data.minStockDefault)
  };
}
module.exports = { settings, legacySettings, stockValue };
