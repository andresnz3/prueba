'use strict';

const { httpError } = require('../middleware/errors');

function isSystemAdmin(auth) {
  return Boolean(auth && auth.role === 'ADMIN' && String(auth.business_id) === '1');
}

function requireSystemAdmin(auth) {
  if (!isSystemAdmin(auth)) throw httpError(403, 'SYSTEM_ADMIN_REQUIRED');
}

module.exports = { isSystemAdmin, requireSystemAdmin };
