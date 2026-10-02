'use strict';
const { httpError } = require('../middleware/errors');
const publicUser = row => ({ id: String(row.user_id ?? row.id), businessId: String(row.business_id), username: row.username, fullName: row.full_name, role: row.role, active: Boolean(row.active) });
async function rows(db, sql, values) { return (await db.execute(sql, values))[0]; }
async function transaction(pool, work) {
  const db = await pool.getConnection();
  try { await db.beginTransaction(); const value = await work(db); await db.commit(); return value; }
  catch (error) { await db.rollback(); throw error; } finally { db.release(); }
}
async function lockBusiness(db, businessId) {
  const [business] = await rows(db, 'SELECT id, status FROM businesses WHERE id = ? FOR UPDATE', [businessId]);
  if (!business || business.status !== 'ACTIVE') throw httpError(401, 'INVALID_SESSION');
}
function createAuthRepository(pool, config) {
  const selectSession = 'SELECT s.id AS session_id, s.business_id, s.user_id, s.token_hash, s.expires_at, s.created_at, u.username, u.full_name, u.role, u.active FROM sessions s JOIN users u ON u.business_id = s.business_id AND u.id = s.user_id JOIN businesses b ON b.id = s.business_id WHERE s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP(3) AND s.created_at > TIMESTAMPADD(SECOND, -?, UTC_TIMESTAMP(3)) AND u.active = TRUE AND b.status = \'ACTIVE\' ';
  async function session(tokenHash) { return (await rows(pool, selectSession + 'AND s.token_hash = ?', [config.absoluteSeconds, tokenHash]))[0]; }
  async function tenant(auth, work) {
    return transaction(pool, async db => {
      await lockBusiness(db, auth.business_id);
      const [current] = await rows(db, selectSession + 'AND s.business_id = ? AND s.id = ? AND s.token_hash = ? FOR UPDATE', [config.absoluteSeconds, auth.business_id, auth.session_id, auth.token_hash]);
      if (!current) throw httpError(401, 'INVALID_SESSION');
      return work(db, current);
    });
  }
  async function audit(db, auth, action, entity, entityId, details) {
    await rows(db, 'INSERT INTO audit_logs (business_id, user_id, action, entity, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))', [auth.business_id, auth.user_id, action, entity, String(entityId), JSON.stringify(details)]);
  }
  async function revokeUser(db, businessId, userId) {
    await rows(db, 'DELETE FROM session_authorizations WHERE business_id = ? AND (granted_by_user_id = ? OR session_id IN (SELECT id FROM sessions WHERE business_id = ? AND user_id = ?))', [businessId, userId, businessId, userId]);
    await rows(db, 'UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE business_id = ? AND user_id = ? AND revoked_at IS NULL', [businessId, userId]);
  }
  return { pool, rows, transaction: work => transaction(pool, work), lockBusiness, session, tenant, audit, revokeUser };
}
module.exports = { createAuthRepository, publicUser, rows, transaction, lockBusiness };
