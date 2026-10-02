'use strict';
const { hashPassword } = require('./passwords');
const { rows } = require('../repositories/auth');
async function bootstrap(pool, input, databaseName) {
  const db = await pool.getConnection();
  const lock = 'pos-bootstrap:' + require('./tokens').hashToken(databaseName).slice(0, 40);
  let locked = false;
  try {
    const [result] = await rows(db, 'SELECT GET_LOCK(?, 10) AS acquired', [lock]);
    if (Number(result.acquired) !== 1) throw new Error('Otro registro inicial esta en ejecucion');
    locked = true;
    await db.beginTransaction();
    const existing = await rows(db, 'SELECT id FROM businesses LIMIT 1');
    if (existing.length) throw new Error('La base ya tiene negocios; no se permite repetir el registro inicial');
    const hash = await hashPassword(input.password);
    const business = await rows(db, 'INSERT INTO businesses (name) VALUES (?)', [input.businessName]);
    const businessId = String(business.insertId);
    const user = await rows(db, 'INSERT INTO users (business_id, username, full_name, password_hash, role, active) VALUES (?, ?, ?, ?, \'ADMIN\', TRUE)', [businessId, input.username, input.fullName, hash]);
    await rows(db, 'INSERT INTO audit_logs (business_id, user_id, action, entity, entity_id, details) VALUES (?, ?, \'BOOTSTRAP\', \'businesses\', ?, ?)', [businessId, String(user.insertId), businessId, JSON.stringify({ procedure: 'terminal' })]);
    await db.commit();
    return { businessId, userId: String(user.insertId), username: input.username };
  } catch (error) { await db.rollback(); throw error; }
  finally { if (locked) await rows(db, 'SELECT RELEASE_LOCK(?)', [lock]); db.release(); }
}
module.exports = { bootstrap };
