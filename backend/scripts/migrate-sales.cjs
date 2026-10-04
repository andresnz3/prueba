'use strict';
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { readConfig } = require('../src/config/environment');
const { createDatabasePool } = require('../src/config/database');
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply') throw new Error('Requires --apply');
  const config = readConfig(), pool = createDatabasePool(config.database);
  try {
    const [existing] = await pool.execute("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = 'pos_operations'", [config.database.database]);
    const [columns] = await pool.execute("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ? AND table_name = 'sales' AND column_name IN ('cash_received', 'change_amount')", [config.database.database]);
    if (Number(existing[0].n) || Number(columns[0].n)) throw new Error('Migration already applied or partial');
    const sql = readFileSync(resolve(__dirname, '../../database/migrations/002_sales_operations.sql'), 'utf8');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await pool.query(statement);
    console.log('Migracion 002 aplicada. No repetir; DDL no es transaccional.');
  } finally { await pool.end(); }
}
main().catch(() => { console.error('Migracion 002 incompleta o no aplicada. Revisar estado antes de repetir.'); process.exitCode = 1; });
