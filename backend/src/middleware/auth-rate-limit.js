'use strict';
const { hashToken } = require('../services/tokens');
const { httpError } = require('./errors');
const { createHmac } = require('node:crypto');
let lastLoginStoreDiagnostic = 0;
let lastReauthorizationStoreDiagnostic = 0;
// Limitador local para protecciones auxiliares; login y reautorización usan contadores compartidos.
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
      const identity = req.auth ? req.auth.business_id + ':' + req.auth.user_id : String(req.body?.username || '').slice(0, 100).toLowerCase();
      consume('identity:' + hashToken(identity), rateMax);
      next();
    } catch (error) { res.set('Retry-After', String(error.retryAfter || rateWindowSeconds)); next(error); }
  };
}

function loginRateLimitKey(secret, address) {
  const source = String(address || 'unknown').trim().toLowerCase().slice(0, 64) || 'unknown';
  return createHmac('sha256', secret).update('connected-login-ip-v1\0' + source).digest('hex');
}

function reauthorizationRateLimitKey(secret, scope, value) {
  if (!['ip', 'user', 'session'].includes(scope)) throw new TypeError('Invalid reauthorization rate-limit scope');
  return createHmac('sha256', secret)
    .update('connected-reauthorization-v1\0' + scope + '\0' + String(value))
    .digest('hex');
}

function createDistributedLoginRateLimit({ repo, config, now = Date.now }) {
  let cleanupAfter = 0;
  return (req, res, next) => {
    const key = loginRateLimitKey(config.secret, req.ip || req.socket?.remoteAddress);
    Promise.resolve().then(() => repo.consumeLoginRateLimit(key, config.rateWindowSeconds)).then(result => {
      if (result.attempts > config.loginRateMax) {
        const retryAfter = Math.max(1, Number(result.retryAfter) || config.rateWindowSeconds);
        res.set('Retry-After', String(retryAfter));
        throw Object.assign(httpError(429, 'TOO_MANY_ATTEMPTS'), { retryAfter });
      }
      if (now() >= cleanupAfter) {
        cleanupAfter = now() + 60000;
        Promise.resolve(repo.cleanupLoginRateLimits()).catch(error => {
          const code = typeof error?.code === 'string' && /^[A-Z0-9_:-]{1,64}$/.test(error.code) ? error.code : 'UNKNOWN';
          console.warn(JSON.stringify({ event: 'login_rate_limit_cleanup_failed', errorCode: code }));
        });
      }
      next();
    }).catch(error => {
      if (error.publicCode === 'TOO_MANY_ATTEMPTS') return next(error);
      // Without shared state, do not silently fall back to a per-process or unlimited limiter.
      if (now() - lastLoginStoreDiagnostic >= 1000) {
        const errorCode = typeof error?.code === 'string' && /^[A-Z0-9_:-]{1,64}$/.test(error.code) ? error.code : 'UNKNOWN';
        console.warn(JSON.stringify({ event: 'login_rate_limit_store_unavailable', errorCode }));
        lastLoginStoreDiagnostic = now();
      }
      next(httpError(503, 'LOGIN_PROTECTION_UNAVAILABLE'));
    });
  };
}

function createDistributedReauthorizationRateLimit({ repo, config, now = Date.now }) {
  let cleanupAfter = 0;
  return (req, res, next) => {
    const auth = req.auth;
    const ids = [auth?.business_id, auth?.user_id, auth?.session_id].map(value => String(value ?? ''));
    if (ids.some(value => !/^[1-9]\d{0,19}$/.test(value))) return next(httpError(401, 'INVALID_SESSION'));

    const address = String(req.ip || req.socket?.remoteAddress || 'unknown').trim().toLowerCase().slice(0, 64) || 'unknown';
    const buckets = [
      { scope: 'ip', value: address, max: config.reauthIpRateMax },
      { scope: 'user', value: ids[0] + ':' + ids[1], max: config.reauthUserRateMax },
      { scope: 'session', value: ids.join(':'), max: config.reauthSessionRateMax }
    ];

    Promise.resolve().then(async () => {
      let blocked;
      for (const bucket of buckets) {
        const key = reauthorizationRateLimitKey(config.secret, bucket.scope, bucket.value);
        const result = await repo.consumeSharedRateLimit(key, config.reauthRateWindowSeconds);
        if (result.attempts > bucket.max) {
          const retryAfter = Math.max(1, Number(result.retryAfter) || config.reauthRateWindowSeconds);
          blocked = Math.max(blocked || 0, retryAfter);
        }
      }

      if (now() >= cleanupAfter) {
        cleanupAfter = now() + 60000;
        Promise.resolve(repo.cleanupSharedRateLimits()).catch(error => {
          const errorCode = typeof error?.code === 'string' && /^[A-Z0-9_:-]{1,64}$/.test(error.code) ? error.code : 'UNKNOWN';
          console.warn(JSON.stringify({ event: 'reauthorization_rate_limit_cleanup_failed', errorCode }));
        });
      }

      if (blocked) {
        res.set('Retry-After', String(blocked));
        throw Object.assign(httpError(429, 'REAUTHORIZATION_RATE_LIMITED'), { retryAfter: blocked });
      }
      next();
    }).catch(error => {
      if (error.publicCode === 'REAUTHORIZATION_RATE_LIMITED') return next(error);
      if (now() - lastReauthorizationStoreDiagnostic >= 1000) {
        const errorCode = typeof error?.code === 'string' && /^[A-Z0-9_:-]{1,64}$/.test(error.code) ? error.code : 'UNKNOWN';
        console.warn(JSON.stringify({ event: 'reauthorization_rate_limit_store_unavailable', errorCode }));
        lastReauthorizationStoreDiagnostic = now();
      }
      next(httpError(503, 'REAUTHORIZATION_PROTECTION_UNAVAILABLE'));
    });
  };
}

module.exports = { createAuthRateLimit, createDistributedLoginRateLimit, createDistributedReauthorizationRateLimit, loginRateLimitKey, reauthorizationRateLimitKey };
