'use strict';
const { hashToken } = require('../services/tokens');
const { httpError } = require('./errors');
// Limite por proceso; mapas acotados. Incrementa ANTES de verificar contrasenas.
function createAuthRateLimit({ rateMax, rateWindowSeconds }, now = Date.now) {
  const counters = new Map();
  function consume(key, max) {
    const time = now();
    for (const [k, row] of counters) if (row.until <= time) counters.delete(k);
    let row = counters.get(key);
    if (!row) {
      if (counters.size >= 10000) throw httpError(429, 'TOO_MANY_ATTEMPTS');
      row = { count: 0, until: time + rateWindowSeconds * 1000 }; counters.set(key, row);
    }
    row.count++;
    if (row.count > max) throw Object.assign(httpError(429, 'TOO_MANY_ATTEMPTS'), { retryAfter: Math.max(1, Math.ceil((row.until - time) / 1000)) });
  }
  return (req, res, next) => {
    try {
      consume('ip:' + hashToken(req.ip || 'unknown'), rateMax * 5);
      const identity = req.auth ? req.auth.business_id + ':' + req.auth.user_id : String(req.body?.businessId).slice(0, 20) + ':' + String(req.body?.username).slice(0, 100).toLowerCase();
      consume('identity:' + hashToken(identity), rateMax);
      next();
    } catch (error) { res.set('Retry-After', String(error.retryAfter || rateWindowSeconds)); next(error); }
  };
}
module.exports = { createAuthRateLimit };
