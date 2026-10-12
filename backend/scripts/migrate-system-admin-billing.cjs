'use strict';
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { readConfig } = require('../src/config/environment');
const { createDatabasePool } = require('../src/config/database');

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--apply') throw new Error('Requires --apply');
  const config = readConfig();
  const pool = createDatabasePool(config.database);
  const database = config.database.database;
  try {
    const [existing] = await pool.execute("SELECT TABLE_NAME AS tableName FROM information_schema.tables WHERE table_schema = ? AND table_name IN ('business_subscriptions', 'business_subscription_payments')", [database]);
    if (existing.length) throw new Error('Migration 006 already applied or partial; inspect information_schema before proceeding');
    const [required] = await pool.execute("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name IN ('businesses', 'users', 'audit_logs')", [database]);
    if (Number(required[0].n) !== 3) throw new Error('The businesses, users and audit_logs tables are required first');
    const sql = readFileSync(resolve(__dirname, '../../database/migrations/006_system_admin_billing.sql'), 'utf8');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await pool.query(statement);
    console.log('Migration 006 applied to ' + database + '. DDL is not transactional; do not repeat blindly.');
  } finally { await pool.end(); }
}

main().catch(() => {
  console.error('Migration 006 was not applied or is partial. Inspect information_schema before retrying. This command changes the selected database.');
  process.exitCode = 1;
});
