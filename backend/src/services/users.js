'use strict';
const { hashPassword } = require('./passwords');
const { publicUser } = require('../repositories/auth');
const { httpError } = require('../middleware/errors');
function createUsersService(repo) {
  const requireAdmin = auth => { if (auth.role !== 'ADMIN') throw httpError(403, 'ADMIN_REQUIRED'); };
  async function list(auth, limit, offset) {
    requireAdmin(auth);
    const users = await repo.rows(repo.pool, 'SELECT id, business_id, username, full_name, role, active FROM users WHERE business_id = ? ORDER BY id LIMIT ? OFFSET ?', [auth.business_id, limit, offset]);
    return users.map(publicUser);
  }
  async function create(auth, input) {
    const hash = await hashPassword(input.password);
    return repo.tenant(auth, async (db, current) => {
      requireAdmin(current);
      let result;
      try { result = await repo.rows(db, 'INSERT INTO users (business_id, username, full_name, password_hash, role, active) VALUES (?, ?, ?, ?, ?, TRUE)', [current.business_id, input.username, input.fullName, hash, input.role]); }
      catch (error) { if (error.code === 'ER_DUP_ENTRY') throw httpError(409, 'USERNAME_EXISTS'); throw error; }
      await repo.audit(db, current, 'CREATE_USER', 'users', result.insertId, { role: input.role });
      return publicUser({ id: result.insertId, business_id: current.business_id, username: input.username, full_name: input.fullName, role: input.role, active: true });
    });
  }
  async function update(auth, userId, input) {
    return repo.tenant(auth, async (db, current) => {
      requireAdmin(current);
      const [user] = await repo.rows(db, 'SELECT id, business_id, username, full_name, role, active FROM users WHERE business_id = ? AND id = ? FOR UPDATE', [current.business_id, userId]);
      if (!user) throw httpError(404, 'USER_NOT_FOUND');
      const role = input.role ?? user.role;
      const active = input.active ?? Boolean(user.active);
      if (user.role === 'ADMIN' && user.active && (role !== 'ADMIN' || !active)) {
        const admins = await repo.rows(db, 'SELECT id FROM users WHERE business_id = ? AND role = \'ADMIN\' AND active = TRUE FOR UPDATE', [current.business_id]);
        if (admins.length <= 1) throw httpError(409, 'LAST_ACTIVE_ADMIN');
      }
      await repo.rows(db, 'UPDATE users SET full_name = ?, role = ?, active = ? WHERE business_id = ? AND id = ?', [input.fullName ?? user.full_name, role, active, current.business_id, userId]);
      if (role !== user.role || active !== Boolean(user.active)) await repo.revokeUser(db, current.business_id, userId);
      await repo.audit(db, current, 'UPDATE_USER', 'users', userId, { role, active });
      return publicUser({ ...user, full_name: input.fullName ?? user.full_name, role, active });
    });
  }
  async function changePassword(auth, userId, password) {
    const hash = await hashPassword(password);
    return repo.tenant(auth, async (db, current) => {
      requireAdmin(current);
      const [user] = await repo.rows(db, 'SELECT id FROM users WHERE business_id = ? AND id = ? FOR UPDATE', [current.business_id, userId]);
      if (!user) throw httpError(404, 'USER_NOT_FOUND');
      await repo.rows(db, 'UPDATE users SET password_hash = ? WHERE business_id = ? AND id = ?', [hash, current.business_id, userId]);
      await repo.revokeUser(db, current.business_id, userId);
      await repo.audit(db, current, 'PASSWORD_CHANGED', 'users', userId, {});
    });
  }
  return { list, create, update, changePassword };
}
module.exports = { createUsersService };
