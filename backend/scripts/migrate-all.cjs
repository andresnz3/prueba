'use strict';

const { readConfig } = require('../src/config/environment');
const { createDatabasePool } = require('../src/config/database');
const { parseArguments, planNewInstall, installBaseSchema, migrate } = require('../src/services/schema-migrations');

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const config = readConfig();
  if (config.database.database !== options.target) throw new Error('Configured DB_NAME must exactly match --target');
  const pool = createDatabasePool(config.database);
  try {
    if (options.mode === 'plan' && options.installBase) {
      const plan = await planNewInstall(pool, options.target);
      console.log('Base-schema import: planned (' + plan.baseTables + ' tables)');
      console.log('Migration plan for ' + options.target);
      for (const item of plan.migrations) console.log(item.version + '  ' + item.status + '  ' + item.action);
      console.log('Read-only plan; no schema or migration DDL was executed.');
      return;
    }
    if (options.installBase) {
      const count = await installBaseSchema(pool, options.target);
      console.log('Imported ' + count + ' base tables into the verified empty target.');
    }
    const result = await migrate(pool, options.target, options.mode);
    console.log((options.mode === 'apply' ? 'Migration result for ' : 'Migration plan for ') + options.target);
    for (const item of result) console.log(item.version + '  ' + item.status + '  ' + item.action);
    if (options.mode === 'plan') console.log('Read-only plan; no migration DDL was executed.');
    else console.log('Migrations complete. Back up and review the target database before enabling the updated application.');
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error('Migration stopped safely: ' + (error.message || 'unknown error'));
  process.exitCode = 1;
});
