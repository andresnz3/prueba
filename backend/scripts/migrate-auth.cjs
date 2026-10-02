'use strict';
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { readConfig } = require('../src/config/environment');
const { createDatabasePool } = require('../src/config/database');
async function main() {
  if (process.argv[2] !== '--apply' || process.argv.length !== 3) throw new Error('Requiere --apply');
  const config = readConfig(); const pool = createDatabasePool(config.database);
  try {
    const sql = readFileSync(resolve(__dirname, '../../database/migrations/001_authorization_grantor.sql'), 'utf8');
    await pool.query(sql);
    console.log('Migracion 001 aplicada. No repetir.');
  } finally { await pool.end(); }
}
main().catch(() => { console.error('No se aplico la migracion. Requiere --apply, permisos ALTER y que la columna no exista.'); process.exitCode = 1; });
