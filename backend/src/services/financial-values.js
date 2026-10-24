'use strict';
const v = require('../middleware/validation');
const { decimal, units } = require('./inventory-values');
const { operationKey } = require('./sales-values');
function manualCash(body) {
  const data = v.body(body, ['operationKey', 'direction', 'amount', 'reason']);
  if (!['IN', 'OUT'].includes(data.direction)) v.invalid();
  const amount = decimal(data.amount, 2, 10);
  if (units(amount) <= 0n) v.invalid();
  return { operationKey: operationKey(data.operationKey), direction: data.direction, amount, reason: v.text(data.reason, 500) };
}
module.exports = { manualCash };
