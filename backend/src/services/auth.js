'use strict';
const { randomToken, hashToken } = require('./tokens');
const { verifyOrDummy } = require('./passwords');
const { httpError } = require('../middleware/errors');
const { publicUser } = require('../repositories/auth');
function createAuthService(repo, config) {
  async function login(input, metadata) {
    return repo.transaction(async db => {
      const [business] = await repo.rows(db, 'SELECT id, status FROM businesses WHERE id = ? FOR UPDATE', [input.businessId]);
      const [user] = await repo.rows(db, 'SELECT * FROM users WHERE business_id = ? AND username = ? FOR UPDATE', [input.businessId, input.username]);
      const verified = await verifyOrDummy(user?.password_hash, input.password);
      if (!verified || !user?.active || business?.status !== 'ACTIVE') throw httpError(401, 'INVALID_CREDENTIALS');
      const token = randomToken();
      const expires = new Date(Date.now() + config.sessionSeconds * 1000);
      const result = await repo.rows(db, 'INSERT INTO sessions (business_id, user_id, token_hash, expires_at, created_at, ip_address, user_agent) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), ?, ?)', [String(user.business_id), String(user.id), hashToken(token), expires, metadata.ip, metadata.agent]);
      await repo.rows(db, 'UPDATE users SET last_login_at = UTC_TIMESTAMP(3) WHERE business_id = ? AND id = ?', [String(user.business_id), String(user.id)]);
      await repo.audit(db, { business_id: user.business_id, user_id: user.id }, 'LOGIN', 'sessions', result.insertId, {});
      return { token, expires, user: publicUser(user) };
    });
  }
  async function logout(auth) {
    return repo.tenant(auth, async (db, current) => {
      await repo.rows(db, 'DELETE FROM session_authorizations WHERE business_id = ? AND session_id = ?', [current.business_id, current.session_id]);
      await repo.rows(db, 'UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE business_id = ? AND id = ?', [current.business_id, current.session_id]);
      await repo.audit(db, current, 'LOGOUT', 'sessions', current.session_id, {});
    });
  }
  async function renew(auth) {
    return repo.tenant(auth, async (db, current) => {
      const token = randomToken();
      const expires = new Date(Math.min(Date.now() + config.sessionSeconds * 1000, new Date(current.created_at).getTime() + config.absoluteSeconds * 1000));
      await repo.rows(db, 'UPDATE sessions SET token_hash = ?, expires_at = ? WHERE business_id = ? AND id = ?', [hashToken(token), expires, current.business_id, current.session_id]);
      await repo.rows(db, 'DELETE FROM session_authorizations WHERE business_id = ? AND session_id = ?', [current.business_id, current.session_id]);
      await repo.audit(db, current, 'RENEW', 'sessions', current.session_id, {});
      return { token, expires, user: publicUser(current) };
    });
  }
  async function canAccess(auth, module, db = repo.pool) {
    if (auth.role === 'ADMIN' || module === 'sales') return true;
    const [grant] = await repo.rows(db, 'SELECT a.id FROM session_authorizations a JOIN users u ON u.business_id = a.business_id AND u.id = a.granted_by_user_id WHERE a.business_id = ? AND a.session_id = ? AND a.module = ? AND a.expires_at > UTC_TIMESTAMP(3) AND u.active = TRUE AND u.role = \'ADMIN\'', [auth.business_id, auth.session_id, module]);
    return Boolean(grant);
  }
  async function authorize(auth, input) {
    return repo.tenant(auth, async (db, current) => {
      if (current.role !== 'VENDEDOR') throw httpError(403, 'SELLER_REQUIRED');
      const [admin] = await repo.rows(db, 'SELECT id, password_hash, active, role FROM users WHERE business_id = ? AND username = ? FOR UPDATE', [current.business_id, input.adminUsername]);
      const verified = await verifyOrDummy(admin?.password_hash, input.adminPassword);
      if (!verified || !admin?.active || admin.role !== 'ADMIN') throw httpError(401, 'INVALID_CREDENTIALS');
      const expires = new Date(Math.min(Date.now() + config.grantSeconds * 1000, new Date(current.expires_at).getTime(), new Date(current.created_at).getTime() + config.absoluteSeconds * 1000));
      // Un solo modulo temporal por sesion, como la navegacion actual.
      await repo.rows(db, 'DELETE FROM session_authorizations WHERE business_id = ? AND session_id = ?', [current.business_id, current.session_id]);
      const result = await repo.rows(db, 'INSERT INTO session_authorizations (business_id, session_id, granted_by_user_id, module, expires_at, created_at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))', [current.business_id, current.session_id, String(admin.id), input.module, expires]);
      await repo.audit(db, current, 'GRANT_MODULE', 'session_authorizations', result.insertId, { module: input.module, grantedByUserId: String(admin.id) });
      return { module: input.module, expiresAt: expires, grantedByUserId: String(admin.id) };
    });
  }
  async function leave(auth, module) {
    return repo.tenant(auth, async (db, current) => {
      await repo.rows(db, 'DELETE FROM session_authorizations WHERE business_id = ? AND session_id = ? AND module = ?', [current.business_id, current.session_id, module]);
      await repo.audit(db, current, 'LEAVE_MODULE', 'sessions', current.session_id, { module });
    });
  }
  async function enter(auth, module) {
    return repo.tenant(auth, async (db, current) => {
      // Se revoca el modulo anterior aunque el destino sea rechazado.
      await repo.rows(db, 'DELETE FROM session_authorizations WHERE business_id = ? AND session_id = ? AND module <> ?', [current.business_id, current.session_id, module]);
      return { allowed: await canAccess(current, module, db), module };
    });
  }
  return { login, logout, renew, canAccess, authorize, leave, enter };
}
module.exports = { createAuthService };
