'use strict';

const { createHash } = require('node:crypto');
const { readConfig } = require('../src/config/environment');
const { createDatabasePool } = require('../src/config/database');

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function quoteIdentifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_$]+$/.test(value)) throw new Error('Unexpected table name in information_schema');
  return '`' + value + '`';
}

async function main() {
  const config = readConfig();
  const pool = createDatabasePool(config.database);
  try {
    const [tableRows] = await pool.execute(
      'SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema=? AND table_type=\'BASE TABLE\' ORDER BY table_name',
      [config.database.database]
    );
    const tables = [];
    for (const row of tableRows) {
      const [countRows] = await pool.query('SELECT COUNT(*) AS rowCount FROM ' + quoteIdentifier(row.tableName));
      tables.push({ name: row.tableName, rowCount: String(countRows[0].rowCount) });
    }
    const [routines] = await pool.execute(
      'SELECT routine_name AS name, routine_type AS type, routine_definition AS definition, data_type AS returnType, sql_data_access AS dataAccess, security_type AS securityType FROM information_schema.routines WHERE routine_schema=? ORDER BY routine_name, routine_type',
      [config.database.database]
    );
    const [triggers] = await pool.execute(
      'SELECT trigger_name AS name, event_object_table AS tableName, action_timing AS timing, event_manipulation AS event, action_statement AS definition FROM information_schema.triggers WHERE trigger_schema=? ORDER BY trigger_name',
      [config.database.database]
    );
    const [events] = await pool.execute(
      'SELECT event_name AS name, event_definition AS definition, event_type AS type, status FROM information_schema.events WHERE event_schema=? ORDER BY event_name',
      [config.database.database]
    );
    const objects = { routines, triggers, events };
    const totalRows = tables.reduce((total, table) => total + BigInt(table.rowCount), 0n).toString();
    const migrationLedger = tables.some(table => table.name === 'schema_migrations')
      ? await pool.execute('SELECT version, file_name AS fileName, checksum, status FROM schema_migrations ORDER BY version').then(([rows]) => rows)
      : null;
    process.stdout.write(JSON.stringify({
      database: config.database.database,
      tableCount: tables.length,
      totalRows,
      tables,
      migrationLedger,
      objectCounts: { routines: routines.length, triggers: triggers.length, events: events.length },
      objectSha256: hash(objects)
    }) + '\n');
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error('Database manifest failed; no credentials or row contents were printed');
  process.exitCode = 1;
});
