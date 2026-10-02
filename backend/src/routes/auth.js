'use strict';
const { Router } = require('express');
const v = require('../middleware/validation');
const { authMiddleware } = require('../middleware/authentication');
const { createAuthRateLimit } = require('../middleware/auth-rate-limit');
const { loginCsrf, cookies, hashToken, sessionCsrf } = require('../services/tokens');
const { publicUser } = require('../repositories/auth');
const { httpError } = require('../middleware/errors');
function authRoutes({ repo, auth, users, config }) {
  const router = Router();
  const m = authMiddleware(repo, config);
  const rate = createAuthRateLimit(config);
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.is('application/json')) throw httpError(415, 'JSON_REQUIRED');
    next();
  });
  function setSession(res, result) {
    res.cookie(config.cookieName, result.token, { ...m.cookieOptions, expires: result.expires });
    res.clearCookie(config.preCookieName, m.cookieOptions);
    return { user: result.user, expiresAt: result.expires, csrfToken: sessionCsrf(config.secret, hashToken(result.token)) };
  }
  router.get('/auth/csrf', async (req, res) => {
    const token = cookies(req)[config.cookieName];
    const session = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? await repo.session(hashToken(token)) : undefined;
    if (session) return res.json({ csrfToken: sessionCsrf(config.secret, session.token_hash) });
    const csrfToken = loginCsrf(config.secret);
    res.cookie(config.preCookieName, csrfToken, { ...m.cookieOptions, maxAge: 600000 });
    res.json({ csrfToken });
  });
  router.post('/auth/login', m.loginProtection, rate, async (req, res) => {
    const data = v.body(req.body, ['businessId', 'username', 'password']);
    const input = { businessId: v.id(data.businessId), username: v.username(data.username), password: v.password(data.password) };
    const result = await auth.login(input, { ip: req.ip.slice(0, 45), agent: (req.get('User-Agent') || '').slice(0, 512) });
    res.json(setSession(res, result));
  });
  router.use(m.authenticate);
  router.get('/auth/me', (req, res) => res.json({ user: publicUser(req.auth), expiresAt: req.auth.expires_at, csrfToken: sessionCsrf(config.secret, req.auth.token_hash) }));
  router.get('/auth/access/:module', async (req, res) => {
    const module = v.moduleName(req.params.module);
    if (!await auth.canAccess(req.auth, module)) throw httpError(403, 'MODULE_FORBIDDEN');
    res.json({ module, allowed: true });
  });
  router.get('/users', m.admin, async (req, res) => {
    if (Object.keys(req.query).some(k => !['limit', 'offset'].includes(k))) v.invalid();
    const limit = req.query.limit ?? '50', offset = req.query.offset ?? '0';
    if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 || !/^\d{1,7}$/.test(offset)) v.invalid();
    res.json({ users: await users.list(req.auth, Number(limit), Number(offset)) });
  });
  router.use(m.csrf);
  router.post('/auth/logout', async (req, res) => {
    v.body(req.body, []); await auth.logout(req.auth);
    res.clearCookie(config.cookieName, m.cookieOptions); res.status(204).end();
  });
  router.post('/auth/renew', async (req, res) => { v.body(req.body, []); res.json(setSession(res, await auth.renew(req.auth))); });
  router.post('/auth/authorizations', rate, async (req, res) => {
    const data = v.body(req.body, ['module', 'adminUsername', 'adminPassword']);
    const module = v.moduleName(data.module); if (module === 'sales') v.invalid();
    res.status(201).json(await auth.authorize(req.auth, { module, adminUsername: v.username(data.adminUsername), adminPassword: v.password(data.adminPassword) }));
  });
  router.delete('/auth/authorizations/:module', async (req, res) => { v.body(req.body, []); await auth.leave(req.auth, v.moduleName(req.params.module)); res.status(204).end(); });
  router.post('/auth/modules/:module/enter', async (req, res) => {
    v.body(req.body, []); const result = await auth.enter(req.auth, v.moduleName(req.params.module));
    if (!result.allowed) throw httpError(403, 'MODULE_FORBIDDEN'); res.json(result);
  });
  router.post('/users', m.admin, async (req, res) => {
    const data = v.body(req.body, ['username', 'fullName', 'password', 'role']);
    res.status(201).json({ user: await users.create(req.auth, { username: v.username(data.username), fullName: v.text(data.fullName, 160), password: v.password(data.password, true), role: v.role(data.role) }) });
  });
  router.patch('/users/:id', m.admin, async (req, res) => {
    const data = v.body(req.body, ['fullName', 'role', 'active'], []); if (!Object.keys(data).length) v.invalid();
    const input = {};
    if (Object.hasOwn(data, 'fullName')) input.fullName = v.text(data.fullName, 160);
    if (Object.hasOwn(data, 'role')) input.role = v.role(data.role);
    if (Object.hasOwn(data, 'active')) { if (typeof data.active !== 'boolean') v.invalid(); input.active = data.active; }
    res.json({ user: await users.update(req.auth, v.id(req.params.id), input) });
  });
  router.put('/users/:id/password', m.admin, async (req, res) => {
    const data = v.body(req.body, ['password']); await users.changePassword(req.auth, v.id(req.params.id), v.password(data.password, true)); res.status(204).end();
  });
  return router;
}
module.exports = { authRoutes };
