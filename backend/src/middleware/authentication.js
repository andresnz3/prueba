'use strict';
const { cookies, hashToken, equal, validLoginCsrf, sessionCsrf, verifySupportToken } = require('../services/tokens');
const { httpError } = require('./errors');
const { publicUser } = require('../repositories/auth');
function authMiddleware(repo, config) {
  async function readOwnerSession(req) {
    const token = cookies(req)[config.cookieName];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw httpError(401, 'INVALID_SESSION');
    const owner = await repo.session(hashToken(token));
    if (!owner) throw httpError(401, 'INVALID_SESSION');
    return owner;
  }
  async function authenticateOwner(req, res, next) {
    const owner = await readOwnerSession(req);
    req.ownerAuth = owner;
    req.auth = owner;
    const hasSupportCookie = Boolean(cookies(req)[config.supportCookieName]);
    if (hasSupportCookie && !(owner.username === 'andres' && owner.role === 'ADMIN' && String(owner.business_id) === '1')) {
      res.clearCookie(config.supportCookieName, { httpOnly: true, secure: config.production, sameSite: config.sameSite, path: '/' });
    }
    next();
  }
  async function authenticate(req, res, next) {
    const owner = await readOwnerSession(req);
    req.ownerAuth = owner;
    req.auth = owner;
    const token = cookies(req)[config.supportCookieName];
    if (!token) return next();
    const claims = verifySupportToken(config.secret, token);
    const systemOwner = owner.username === 'andres' && owner.role === 'ADMIN' && String(owner.business_id) === '1';
    if (!systemOwner || !claims || claims.ownerSessionId !== String(owner.session_id) || claims.ownerUserId !== String(owner.user_id) || claims.ownerBusinessId !== String(owner.business_id)) {
      res.clearCookie(config.supportCookieName, { httpOnly: true, secure: config.production, sameSite: config.sameSite, path: '/' });
      throw httpError(401, 'INVALID_SUPPORT_SESSION');
    }
    const target = await repo.session(claims.supportTokenHash);
    if (!target || String(target.session_id) !== claims.supportSessionId || String(target.business_id) !== claims.businessId || target.role !== 'ADMIN') {
      res.clearCookie(config.supportCookieName, { httpOnly: true, secure: config.production, sameSite: config.sameSite, path: '/' });
      throw httpError(401, 'INVALID_SUPPORT_SESSION');
    }
    const support = { actor: owner, businessId: String(target.business_id), businessName: target.business_name, expiresAt: claims.expiresAt };
    req.support = { businessId: support.businessId, businessName: support.businessName, expiresAt: new Date(support.expiresAt).toISOString(), user: publicUser(target) };
    req.auth = { ...target, support };
    next();
  }
  function csrf(req, res, next) {
    const auth = req.ownerAuth || req.auth;
    if (!equal(req.get('X-CSRF-Token'), sessionCsrf(config.secret, auth.token_hash))) throw httpError(403, 'CSRF_FAILED');
    next();
  }
  function loginProtection(req, res, next) {
    const token = cookies(req)[config.preCookieName];
    if (!validLoginCsrf(config.secret, token) || !equal(token, req.get('X-CSRF-Token'))) throw httpError(403, 'CSRF_FAILED');
    next();
  }
  function admin(req, res, next) { if (req.auth.role !== 'ADMIN') throw httpError(403, 'ADMIN_REQUIRED'); next(); }
  const cookieOptions = { httpOnly: true, secure: config.production, sameSite: config.sameSite, path: '/' };
  return { authenticate, authenticateOwner, csrf, loginProtection, admin, cookieOptions };
}
function requireModule(service, module) {
  return async (req, res, next) => { if (!await service.canAccess(req.auth, module)) throw httpError(403, 'MODULE_FORBIDDEN'); next(); };
}
module.exports = { authMiddleware, requireModule };
