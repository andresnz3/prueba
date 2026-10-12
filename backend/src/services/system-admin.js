'use strict';
const { hashPassword } = require('./passwords');
const { randomToken, hashToken } = require('./tokens');
const { publicUser } = require('../repositories/auth');
const { httpError } = require('../middleware/errors');

const isSystemAdmin = auth => auth?.username === 'andres' && auth.role === 'ADMIN' && String(auth.business_id) === '1';
const requireSystemAdmin = auth => { if (!isSystemAdmin(auth)) throw httpError(403, 'SYSTEM_ADMIN_REQUIRED'); };
const businessRecord = row => ({ id: String(row.id), name: row.name, status: row.status, createdAt: row.created_at, userCount: Number(row.user_count || 0) });
const operationalTables = [
  'products', 'clients', 'suppliers', 'sales', 'sale_items', 'purchases', 'purchase_items',
  'cash_sessions', 'cash_movements', 'inventory_movements', 'audit_logs', 'sale_orders',
  'sale_order_items', 'customer_payments', 'supplier_payments', 'expenses', 'document_sequences',
  'pos_operations'
];
const removableConfigurationTables = ['business_settings'];

function createSystemAdminService(repo) {
  async function listBusinesses(auth) {
    requireSystemAdmin(auth);
    const businesses = await repo.rows(repo.pool, 'SELECT b.id, b.name, b.status, b.created_at, COUNT(u.id) AS user_count FROM businesses b LEFT JOIN users u ON u.business_id = b.id GROUP BY b.id, b.name, b.status, b.created_at ORDER BY b.id', []);
    return businesses.map(businessRecord);
  }

  async function createBusiness(auth, name) {
    requireSystemAdmin(auth);
    return repo.transaction(async db => {
      const result = await repo.rows(db, 'INSERT INTO businesses (name, status) VALUES (?, \'ACTIVE\')', [name]);
      const [created] = await repo.rows(db, 'SELECT id, name, status, created_at, 0 AS user_count FROM businesses WHERE id = ?', [String(result.insertId)]);
      await repo.audit(db, auth, 'CREATE_BUSINESS', 'businesses', result.insertId, {});
      return businessRecord(created);
    });
  }

  async function setBusinessStatus(auth, businessId, status) {
    requireSystemAdmin(auth);
    if (String(businessId) === '1' && status === 'INACTIVE') throw httpError(409, 'BUSINESS_PROTECTED');
    return repo.transaction(async db => {
      const [business] = await repo.rows(db, 'SELECT id, name, status, created_at FROM businesses WHERE id = ? FOR UPDATE', [businessId]);
      if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
      if (business.status !== status) {
        await repo.rows(db, 'UPDATE businesses SET status = ? WHERE id = ?', [status, businessId]);
        if (status === 'INACTIVE') {
          await repo.rows(db, 'DELETE FROM session_authorizations WHERE business_id = ?', [businessId]);
          await repo.rows(db, 'UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE business_id = ? AND revoked_at IS NULL', [businessId]);
        }
      }
      await repo.audit(db, auth, 'UPDATE_BUSINESS_STATUS', 'businesses', businessId, { businessId: String(businessId), status });
      const [updated] = await repo.rows(db, 'SELECT b.id, b.name, b.status, b.created_at, COUNT(u.id) AS user_count FROM businesses b LEFT JOIN users u ON u.business_id = b.id WHERE b.id = ? GROUP BY b.id, b.name, b.status, b.created_at', [businessId]);
      return businessRecord(updated);
    });
  }

  async function deleteBusiness(auth, businessId, confirmation) {
    requireSystemAdmin(auth);
    if (confirmation !== 'ELIMINAR') throw httpError(400, 'BUSINESS_DELETE_CONFIRMATION_REQUIRED');
    const id = String(businessId);
    if (id === '1') throw httpError(409, 'BUSINESS_DELETE_PROTECTED');
    try {
      return await repo.transaction(async db => {
        const [business] = await repo.rows(db, 'SELECT id, name FROM businesses WHERE id = ? FOR UPDATE', [id]);
        if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');

        const tablesToFind = [...operationalTables, ...removableConfigurationTables];
        const installed = await repo.rows(db,
          'SELECT TABLE_NAME AS tableName FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (' + tablesToFind.map(() => '?').join(', ') + ')',
          tablesToFind
        );
        const installedTables = new Set(installed.map(row => row.tableName));
        for (const table of operationalTables) {
          if (!installedTables.has(table)) continue;
          const [record] = await repo.rows(db, 'SELECT 1 AS present FROM `' + table + '` WHERE business_id = ? LIMIT 1', [id]);
          if (record) throw httpError(409, 'BUSINESS_HAS_DATA');
        }

        await repo.rows(db, 'DELETE FROM session_authorizations WHERE business_id = ?', [id]);
        await repo.rows(db, 'DELETE FROM sessions WHERE business_id = ?', [id]);
        if (installedTables.has('business_settings')) await repo.rows(db, 'DELETE FROM business_settings WHERE business_id = ?', [id]);
        await repo.rows(db, 'DELETE FROM users WHERE business_id = ?', [id]);
        await repo.audit(db, auth, 'DELETE_BUSINESS', 'businesses', id, { businessName: business.name });
        await repo.rows(db, 'DELETE FROM businesses WHERE id = ?', [id]);
        return { id, name: business.name };
      });
    } catch (error) {
      if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.errno === 1451) throw httpError(409, 'BUSINESS_HAS_DATA');
      throw error;
    }
  }

  async function listBusinessUsers(auth, businessId) {
    requireSystemAdmin(auth);
    const [business] = await repo.rows(repo.pool, 'SELECT id FROM businesses WHERE id = ?', [businessId]);
    if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
    const users = await repo.rows(repo.pool, 'SELECT id, business_id, username, full_name, role, active FROM users WHERE business_id = ? ORDER BY id', [businessId]);
    return users.map(publicUser);
  }

  async function createBusinessUser(auth, businessId, input) {
    requireSystemAdmin(auth);
    const passwordHash = await hashPassword(input.password);
    return repo.transaction(async db => {
      const [business] = await repo.rows(db, 'SELECT id FROM businesses WHERE id = ? FOR UPDATE', [businessId]);
      if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
      const duplicate = await repo.rows(db, 'SELECT id FROM users WHERE username = ? LIMIT 1 FOR UPDATE', [input.username]);
      if (duplicate.length) throw httpError(409, 'USERNAME_EXISTS');
      let result;
      try {
        result = await repo.rows(db, 'INSERT INTO users (business_id, username, full_name, password_hash, role, active) VALUES (?, ?, ?, ?, ?, TRUE)', [businessId, input.username, input.fullName, passwordHash, input.role]);
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') throw httpError(409, 'USERNAME_EXISTS');
        throw error;
      }
      const user = publicUser({ id: result.insertId, business_id: businessId, username: input.username, full_name: input.fullName, role: input.role, active: true });
      await repo.audit(db, auth, 'CREATE_BUSINESS_USER', 'users', result.insertId, { businessId: String(businessId), role: input.role });
      return user;
    });
  }

  async function setUserStatus(auth, userId, active) {
    requireSystemAdmin(auth);
    return repo.transaction(async db => {
      const [user] = await repo.rows(db, 'SELECT id, business_id, username, full_name, role, active FROM users WHERE id = ? FOR UPDATE', [userId]);
      if (!user) throw httpError(404, 'USER_NOT_FOUND');
      if (!active && user.username === 'andres' && user.role === 'ADMIN' && String(user.business_id) === '1') throw httpError(409, 'SYSTEM_ADMIN_PROTECTED');
      if (Boolean(user.active) !== active) {
        if (user.role === 'ADMIN' && user.active && !active) {
          const admins = await repo.rows(db, 'SELECT id FROM users WHERE business_id = ? AND role = \'ADMIN\' AND active = TRUE FOR UPDATE', [user.business_id]);
          if (admins.length <= 1) throw httpError(409, 'LAST_ACTIVE_ADMIN');
        }
        await repo.rows(db, 'UPDATE users SET active = ? WHERE business_id = ? AND id = ?', [active, user.business_id, userId]);
        await repo.revokeUser(db, user.business_id, userId);
      }
      await repo.audit(db, auth, 'UPDATE_BUSINESS_USER_STATUS', 'users', userId, { businessId: String(user.business_id), active });
      return publicUser({ ...user, active });
    });
  }

  async function startSupportSession(auth, businessId, metadata) {
    requireSystemAdmin(auth);
    if (String(businessId) === '1') throw httpError(409, 'SUPPORT_TARGET_INVALID');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const tokenHash = hashToken(randomToken());
    return repo.transaction(async db => {
      const [business] = await repo.rows(db, 'SELECT id, name, status FROM businesses WHERE id = ? FOR UPDATE', [businessId]);
      if (!business) throw httpError(404, 'BUSINESS_NOT_FOUND');
      if (business.status !== 'ACTIVE') throw httpError(409, 'SUPPORT_BUSINESS_UNAVAILABLE');
      const [target] = await repo.rows(db, 'SELECT u.id AS user_id, u.business_id, u.username, u.full_name, u.role, u.active, b.name AS business_name, b.status AS business_status FROM users u JOIN businesses b ON b.id = u.business_id WHERE u.business_id = ? AND u.role = \'ADMIN\' AND u.active = TRUE AND b.status = \'ACTIVE\' ORDER BY u.id LIMIT 1 FOR UPDATE', [businessId]);
      if (!target) throw httpError(409, 'SUPPORT_ADMIN_REQUIRED');
      const supportSession = await repo.rows(db, 'INSERT INTO sessions (business_id, user_id, token_hash, expires_at, created_at, ip_address, user_agent) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), ?, ?)', [businessId, target.user_id, tokenHash, expiresAt, metadata.ip, metadata.agent]);
      await repo.audit(db, auth, 'START_SUPPORT_SESSION', 'businesses', businessId, { businessId: String(businessId), businessName: business.name, expiresAt: expiresAt.toISOString() });
      return { businessId: String(business.id), businessName: business.name, expiresAt, user: publicUser(target), supportSession: { session_id: String(supportSession.insertId), token_hash: tokenHash } };
    });
  }

  async function endSupportSession(auth, claims) {
    requireSystemAdmin(auth);
    if (!claims) return;
    await repo.transaction(async db => {
      await repo.rows(db, 'UPDATE sessions SET revoked_at = UTC_TIMESTAMP(3) WHERE business_id = ? AND id = ? AND token_hash = ? AND revoked_at IS NULL', [claims.businessId, claims.supportSessionId, claims.supportTokenHash]);
      await repo.audit(db, auth, 'END_SUPPORT_SESSION', 'businesses', claims.businessId, { businessId: String(claims.businessId), supportSessionId: String(claims.supportSessionId) });
    });
  }

  return { isSystemAdmin, listBusinesses, createBusiness, setBusinessStatus, deleteBusiness, listBusinessUsers, createBusinessUser, setUserStatus, startSupportSession, endSupportSession };
}

module.exports = { createSystemAdminService, isSystemAdmin, requireSystemAdmin };
