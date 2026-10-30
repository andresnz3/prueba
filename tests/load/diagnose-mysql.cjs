'use strict';

const mysql = require('/app/backend/node_modules/mysql2/promise');

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    charset: 'utf8mb4'
  });
  try {
    const [processes] = await db.execute("SELECT ID, USER, DB, COMMAND, TIME, STATE FROM INFORMATION_SCHEMA.PROCESSLIST WHERE DB LIKE 'pos_auth_test_%' OR (DB = DATABASE() AND USER <> 'root')");
    let waits = [];
    try {
      [waits] = await db.execute('SELECT REQUESTING_ENGINE_TRANSACTION_ID AS requesting, BLOCKING_ENGINE_TRANSACTION_ID AS blocking, REQUESTING_THREAD_ID AS requestingThread, BLOCKING_THREAD_ID AS blockingThread FROM performance_schema.data_lock_waits');
    } catch { /* Performance Schema access may be restricted in local builds. */ }
    process.stdout.write(JSON.stringify({ database: process.env.DB_NAME, processes, waits }) + '\n');
  } finally {
    await db.end();
  }
}

main().catch(error => {
  process.stderr.write('Temporary MySQL diagnostic failed (' + (error.code || 'unknown') + ').\n');
  process.exitCode = 1;
});
