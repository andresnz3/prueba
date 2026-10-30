'use strict';

const { randomBytes } = require('node:crypto');
const { mkdir, writeFile } = require('node:fs/promises');
const mysql = require('/app/backend/node_modules/mysql2/promise');
const { hashPassword } = require('/app/backend/src/services/passwords');

async function main() {
  const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, charset: 'utf8mb4' });
  const password = randomBytes(24).toString('base64url') + 'A1!';
  const passwordHash = await hashPassword(password);
  const accounts = [];
  const businesses = [];
  try {
    await db.beginTransaction();
    for (let tenant = 0; tenant < 10; tenant += 1) {
      const [businessResult] = await db.execute('INSERT INTO businesses (name, status) VALUES (?, \'ACTIVE\')', [`Load test ${tenant + 1}`]);
      const businessId = String(businessResult.insertId);
      businesses.push(businessId);
      await db.execute('INSERT INTO business_subscriptions (business_id, plan_code) VALUES (?, \'CONECTADO_PREMIUM\')', [businessId]);
      let adminId;
      for (let seat = 0; seat < 10; seat += 1) {
        const username = seat === 0 ? `loadadmin${String(tenant).padStart(2, '0')}` : `loadseller${String(tenant).padStart(2, '0')}_${String(seat).padStart(2, '0')}`;
        const role = seat === 0 ? 'ADMIN' : 'VENDEDOR';
        const [userResult] = await db.execute('INSERT INTO users (business_id, username, full_name, password_hash, role, active) VALUES (?, ?, ?, ?, ?, TRUE)', [businessId, username, `Load ${role} ${tenant + 1}-${seat + 1}`, passwordHash, role]);
        const userId = String(userResult.insertId);
        if (seat === 0) adminId = userId;
        accounts.push({ businessId, username, role, userId });
      }
      const [productResult] = await db.execute('INSERT INTO products (business_id, barcode, name, category, cost, retail_margin, wholesale_margin, retail_price, wholesale_price, stock, min_stock, active) VALUES (?, ?, ?, ?, \'0.10\', \'0.0000\', \'0.0000\', \'1.00\', \'0.90\', \'1000000.000\', \'0.000\', TRUE)', [businessId, `LOAD-${tenant + 1}`, `Load product ${tenant + 1}`, 'Pruebas']);
      await db.execute('INSERT INTO cash_sessions (business_id, opened_by, opening_amount, status) VALUES (?, ?, \'100000.00\', \'OPEN\')', [businessId, adminId]);
      businesses[tenant] = { businessId, productId: String(productResult.insertId) };
    }
    await db.commit();
    await mkdir('/run/load', { recursive: true });
    await writeFile('/run/load/fixtures.json', JSON.stringify({ password, accounts, businesses }), { mode: 0o600 });
    process.stdout.write(JSON.stringify({ businesses: businesses.length, users: accounts.length, products: businesses.length, cashSessions: businesses.length }) + '\n');
  } catch (error) {
    await db.rollback();
    process.stderr.write('Load fixture preparation failed (' + (error.code || 'unknown') + ').\n');
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch(() => { process.stderr.write('Load fixture preparation failed.\n'); process.exitCode = 1; });
