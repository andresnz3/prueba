'use strict';
const { cookies, hashToken, equal, validLoginCsrf, sessionCsrf } = require('../services/tokens');
const { httpError } = require('./errors');
function authMiddleware(repo, config) {
  async function authenticate(req, res, next) {
    const token = cookies(req)[config.cookieName];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw httpError(401, 'INVALID_SESSION');
    req.auth = await repo.session(hashToken(token));
    if (!req.auth) throw httpError(401, 'INVALID_SESSION');
    next();
  }
  function csrf(req, res, next) {
    if (!equal(req.get('X-CSRF-Token'), sessionCsrf(config.secret, req.auth.token_hash))) throw httpError(403, 'CSRF_FAILED');
    next();
  }
  function loginProtection(req, res, next) {
    const token = cookies(req)[config.preCookieName];
    if (!validLoginCsrf(config.secret, token) || !equal(token, req.get('X-CSRF-Token'))) throw httpError(403, 'CSRF_FAILED');
    next();
  }
  function admin(req, res, next) { if (req.auth.role !== 'ADMIN') throw httpError(403, 'ADMIN_REQUIRED'); next(); }
  const cookieOptions = { httpOnly: true, secure: config.production, sameSite: config.sameSite, path: '/' };
  return { authenticate, csrf, loginProtection, admin, cookieOptions };
}
function requireModule(service, module) {
  return async (req, res, next) => { if (!await service.canAccess(req.auth, module)) throw httpError(403, 'MODULE_FORBIDDEN'); next(); };
}
module.exports = { authMiddleware, requireModule };
