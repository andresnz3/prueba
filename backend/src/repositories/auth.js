'use strict';
const { httpError } = require('../middleware/errors');
const publicUser = row => ({ id: String(row.user_id ?? row.id), businessId: String(row.business_id), username: row.username, fullName: row.full_name, role: row.role, active: Boolean(row.active), ...(typeof row.business_name === 'string' ? { businessName: row.business_name } : {}), ...(typeof row.business_status === 'string' ? { businessStatus: row.business_status } : {}), ...(row.plan !== undefined ? { plan: row.plan } : {}) });
async function rows(db, sql, values) { return (await db.execute(sql, values))[0]; }
async function transaction(pool, work) {
  const db = await pool.getConnection();
  try { await db.beginTransaction(); const value = await work(db); await db.commit(); return value; }
  catch (error) { await db.rollback(); throw error; } finally { db.release(); }
}
async function lockBusiness(db, businessId) {
  const [business] = await rows(db, 'SELECT id, status FROM businesses WHERE id = ? FOR UPDATE', [businessId]);
  if (!business || business.status !== 'ACTIVE') throw httpError(401, 'INVALID_SESSION');
  const [gate] = await rows(db, 'SELECT COUNT(*) AS present FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'business_migration_controls\'', []);
  if (Number(gate.present) === 1) {
    const [control] = await rows(db, 'SELECT state FROM business_migration_controls WHERE business_id = ? FOR UPDATE', [businessId]);
    if (control?.state === 'PENDING') throw httpError(401, 'INVALID_SESSION');
  }
}
async function businessMigrationState(db, businessId) {
  const [gate] = await rows(db, 'SELECT COUNT(*) AS present FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'business_migration_controls\'', []);
  if (Number(gate.present) !== 1) return 'NOT_REQUIRED';
  const [control] = await rows(db, 'SELECT state FROM business_migration_controls WHERE business_id = ?', [businessId]);
  return control?.state || 'NOT_REQUIRED';
}
function createAuthRepository(pool, config) {
  const selectSession = 'SELECT s.id AS session_id, s.business_id, s.user_id, s.token_hash, s.expires_at, s.created_at, u.username, u.full_name, u.role, u.active, b.name AS business_name, b.status AS business_status FROM sessions s JOIN users u ON u.business_id = s.business_id AND u.id = s.user_id JOIN businesses b ON b.id = s.business_id WHERE s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP(3) AND s.created_at > TIMESTAMPADD(SECOND, -?, UTC_TIMESTAMP(3)) AND u.active = TRUE AND b.status = \'ACTIVE\' ';
  async function session(tokenHash) {
    const found = (await rows(pool, selectSession + 'AND s.token_hash = ?', [config.absoluteSeconds, tokenHash]))[0];
    if (!found || await businessMigrationState(pool, found.business_id) === 'PENDING') return undefined;
    return found;
  }
  async function tenant(auth, work) {
    return transaction(pool, async db => {
      if (auth.support) {
        const actor = auth.support.actor;
        const [owner] = await rows(db, selectSession + 'AND s.business_id = ? AND s.id = ? AND s.token_hash = ? FOR UPDATE', [config.absoluteSeconds, actor.business_id, actor.session_id, actor.token_hash]);
        if (!owner || owner.username !== 'andres' || owner.role !== 'ADMIN' || String(owner.business_id) !== '1') throw httpError(401, 'SUPPORT_OWNER_SESSION_INVALID');
        try { await lockBusiness(db, auth.business_id); }
        catch (error) { if (error.publicCode === 'INVALID_SESSION') throw httpError(403, 'SUPPORT_BUSINESS_UNAVAILABLE'); throw error; }
        const [current] = await rows(db, selectSession + 'AND s.business_id = ? AND s.id = ? AND s.token_hash = ? AND u.role = \'ADMIN\' FOR UPDATE', [config.absoluteSeconds, auth.business_id, auth.session_id, auth.token_hash]);
        if (!current) throw httpError(401, 'INVALID_SUPPORT_SESSION');
        return work(db, { ...current, support: { ...auth.support, actor: owner } });
      }
      await lockBusiness(db, auth.business_id);
      const [current] = await rows(db, selectSession + 'AND s.business_id = ? AND s.id = ? AND s.token_hash = ? FOR UPDATE', [config.absoluteSeconds, auth.business_id, auth.session_id, auth.token_hash]);
      if (!current) throw httpError(401, 'INVALID_SESSION');
      return work(db, current);
    });
  }
  async function audit(db, auth, action, entity, entityId, details) {
    const auditDetails = auth.support ? {
      ...(details && typeof details === 'object' && !Array.isArray(details) ? details : { value: details }),
      supportSession: {
        actor: { userId: String(auth.support.actor.user_id), businessId: String(auth.support.actor.business_id), username: auth.support.actor.username, role: auth.support.actor.role },
        operatedAs: { userId: String(auth.user_id), businessId: String(auth.business_id), username: auth.username },
        expiresAt: new Date(auth.support.expiresAt).toISOString()
      }
    } : details;
    await rows(db, 'INSERT INTO audit_logs (business_id, user_id, action, entity, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))', [auth.business_id, auth.user_id, action, entity, String(entityId), JSON.stringify(auditDetails)]);
  }
  async function revokeUser(db, businessId, userId) {
    await rows(db, 'DELETE FROM session_authorizations WHERE business_id = ? AND (granted_by_user_id = ? OR session_id IN (SELECT id FROM sessions WHERE business_id = ? AND user_id = ?))', [businessId, userId, businessId, userId]);
    await rows(db, 'UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE business_id = ? AND user_id = ? AND revoked_at IS NULL', [businessId, userId]);
  }
  return { pool, rows, transaction: work => transaction(pool, work), lockBusiness, businessMigrationState, session, tenant, audit, revokeUser };
}
module.exports = { createAuthRepository, publicUser, rows, transaction, lockBusiness };
