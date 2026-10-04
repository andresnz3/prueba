'use strict';
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { readConfig } = require('../src/config/environment');
const { createDatabasePool } = require('../src/config/database');

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply') throw new Error('Requires --apply');
  const config = readConfig(), pool = createDatabasePool(config.database), database = config.database.database;
  try {
    const [base] = await pool.execute("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = 'pos_operations'", [database]);
    const [baseColumns] = await pool.execute("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ? AND table_name = 'sales' AND column_name IN ('cash_received', 'change_amount')", [database]);
    if (!Number(base[0].n) || Number(baseColumns[0].n) !== 2) throw new Error('Migration 002 is required first');
    const [tables] = await pool.execute("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name IN ('sale_orders', 'sale_order_items')", [database]);
    const [columns] = await pool.execute("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ? AND ((table_name = 'businesses' AND column_name = 'sales_flow') OR (table_name = 'sales' AND column_name = 'cashier_user_id') OR (table_name = 'cash_movements' AND column_name IN ('confirmed_by_user_id', 'confirmed_at'))) ", [database]);
    if (Number(tables[0].n) || Number(columns[0].n)) throw new Error('Migration already applied or partial; inspect information_schema before proceeding');
    const sql = readFileSync(resolve(__dirname, '../../database/migrations/003_connected_cash_workflow.sql'), 'utf8');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await pool.query(statement);
    console.log('Migration 003 applied to ' + database + '. DDL is not transactional; do not repeat blindly.');
  } finally { await pool.end(); }
}
main().catch(() => { console.error('Migration 003 was not applied or is partial. Inspect the selected database and information_schema before retrying.'); process.exitCode = 1; });
