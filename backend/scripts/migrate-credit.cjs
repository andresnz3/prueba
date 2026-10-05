'use strict';
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { readConfig } = require('../src/config/environment');
const { createDatabasePool } = require('../src/config/database');
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply') throw new Error('Requires --apply');
  const config = readConfig(), pool = createDatabasePool(config.database), database = config.database.database;
  try {
    const [cash] = await pool.execute("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ? AND ((table_name = 'sales' AND column_name IN ('cash_received','change_amount','cashier_user_id')) OR (table_name = 'businesses' AND column_name = 'sales_flow'))", [database]);
    const [orders] = await pool.execute("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name IN ('sale_orders','sale_order_items')", [database]);
    if (Number(cash[0].n) !== 4 || Number(orders[0].n) !== 2) throw new Error('Migrations 002 and 003 are required first');
    const [columns] = await pool.execute("SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = ? AND ((table_name = 'clients' AND column_name = 'credit_days') OR (table_name = 'sale_orders' AND column_name IN ('client_id','credit_days')))", [database]);
    if (Number(columns[0].n)) throw new Error('Migration 004 already applied or partial; inspect information_schema before proceeding');
    const [status] = await pool.execute("SELECT column_type FROM information_schema.columns WHERE table_schema = ? AND table_name = 'customer_payments' AND column_name = 'status'", [database]);
    if (!status.length || !status[0].column_type.includes('POSTED') || !status[0].column_type.includes('VOID')) throw new Error('Unexpected customer payment schema');
    if (status[0].column_type.includes('PENDING')) throw new Error('Migration 004 already applied or partial; inspect information_schema before proceeding');
    const sql = readFileSync(resolve(__dirname, '../../database/migrations/004_connected_credit_accounts.sql'), 'utf8');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await pool.query(statement);
    console.log('Migration 004 applied to ' + database + '. DDL is not transactional; do not repeat blindly.');
  } finally { await pool.end(); }
}
main().catch(() => { console.error('Migration 004 was not applied or is partial. Inspect information_schema before retrying.'); process.exitCode = 1; });
