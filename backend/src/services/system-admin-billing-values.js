'use strict';
const { httpError } = require('../middleware/errors');

function invalid(field, code = 'INVALID_INPUT') {
  throw Object.assign(httpError(400, code), { field });
}

function date(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(field);
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) invalid(field);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.toISOString().slice(0, 10) !== value) invalid(field);
  return value;
}

function amount(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)) invalid('amount', 'PAYMENT_AMOUNT_INVALID');
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n) invalid('amount', 'PAYMENT_AMOUNT_INVALID');
  return (cents / 100n).toString() + '.' + (cents % 100n).toString().padStart(2, '0');
}

function addMonth(value) {
  const [year, month, day] = date(value, 'paymentDate').split('-').map(Number);
  const nextMonthIndex = month;
  const nextYear = year + Math.floor(nextMonthIndex / 12);
  const nextMonth = (nextMonthIndex % 12) + 1;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  return String(nextYear).padStart(4, '0') + '-' + String(nextMonth).padStart(2, '0') + '-' + String(Math.min(day, lastDay)).padStart(2, '0');
}

function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function dayDifference(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00.000Z') - Date.parse(from + 'T00:00:00.000Z')) / 86400000);
}

module.exports = { date, amount, addMonth, dateOnly, dayDifference };
