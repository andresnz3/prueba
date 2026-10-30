'use strict';
const { resolve, basename } = require('node:path');
const { readdirSync } = require('node:fs');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');
const { randomBytes } = require('node:crypto');
const { readConfig } = require('../src/config/environment');
const { MIGRATIONS, planNewInstall, installBaseSchema, migrate } = require('../src/services/schema-migrations');

const integrationFiles = [
  'tests/integration/schema-migrations.test.cjs',
  'tests/integration/pool-saturation.test.cjs',
  'tests/integration/migration-016-compatibility.test.cjs',
  'tests/integration/migration-017-compatibility.test.cjs',
  'tests/integration/business-plans.test.cjs',
  'tests/integration/business-settings.test.cjs',
  'tests/integration/financial.test.cjs',
  'tests/integration/auth.test.cjs',
  'tests/integration/local-licenses.test.cjs',
  'tests/integration/inventory.test.cjs',
  'tests/integration/system-admin-inventory-migration.test.cjs',
  'tests/integration/system-admin-sales-migration.test.cjs',
  'tests/integration/system-admin-purchases-migration.test.cjs',
  'tests/integration/system-admin-credit-migration.test.cjs',
  'tests/integration/system-admin-migration-archive.test.cjs',
  'tests/integration/system-admin-migration-real-continuation.test.cjs',
  'tests/integration/system-admin-migration-projection.test.cjs',
  'tests/integration/system-admin-migration-onboarding.test.cjs',
  'tests/integration/business-deletion.test.cjs',
  'tests/integration/migration-history.test.cjs',
  'tests/integration/product-images.test.cjs',
  'tests/integration/sales.test.cjs',
  'tests/integration/cash-support-history.test.cjs',
  'tests/integration/customers.test.cjs',
  'tests/integration/expenses.test.cjs',
  'tests/integration/procurement.test.cjs',
  'tests/integration/reports.test.cjs'
];

function databaseName(config) {
  const name = 'pos_auth_test_' + randomBytes(12).toString('hex');
  if (!/^pos_auth_test_[a-f0-9]{24}$/.test(name) || name === config.database.database) throw new Error('Nombre de pruebas inseguro');
  return name;
}

async function seedSystemAdminFixture(connection) {
  const [business] = await connection.query('INSERT INTO businesses (name) VALUES (?)', ['Migration 005 preservation fixture']);
  const [user] = await connection.query('INSERT INTO users (business_id,username,full_name,password_hash,role) VALUES (?,?,?,?,?)', [business.insertId, 'migration005_fixture', 'Migration fixture', 'not-a-login-hash', 'ADMIN']);
  const [supplier] = await connection.query('INSERT INTO suppliers (business_id,name) VALUES (?,?)', [business.insertId, 'Migration 005 supplier']);
  await connection.query("INSERT INTO supplier_payments (business_id,user_id,supplier_id,amount,payment_method,status) VALUES (?,?,?,'3.17','CARD','POSTED')", [business.insertId, user.insertId, supplier.insertId]);
}

async function prepareDatabase(connection, config, { empty = false, throughVersion = null } = {}) {
  const name = databaseName(config);
  let created = false;
  let isolated;
  try {
    await connection.query('CREATE DATABASE `' + name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    created = true;
    const mysqlConfig = { ...config.database };
    delete mysqlConfig.connectionQueueLimit;
    delete mysqlConfig.acquireTimeout;
    isolated = await mysql.createConnection({ ...mysqlConfig, database: name, connectionLimit: undefined });
    const initialPlan = await planNewInstall(isolated, name);
    if (initialPlan.baseTables < 1 || initialPlan.migrations.length !== MIGRATIONS.length) throw new Error('El plan inicial de migraciones está incompleto');
    await installBaseSchema(isolated, name);
    if (!empty) await seedSystemAdminFixture(isolated);
    await migrate(isolated, name, 'apply', throughVersion ? { throughVersion } : undefined);
    return name;
  } catch (error) {
    if (isolated) { await isolated.end(); isolated = undefined; }
    if (created) await connection.query('DROP DATABASE `' + name + '`');
    throw error;
  } finally {
    if (isolated) await isolated.end();
  }
}

async function runFile(connection, config, file, { throughVersion = null } = {}) {
  const name = await prepareDatabase(connection, config, { empty: ['auth.test.cjs', 'business-deletion.test.cjs', 'business-plans.test.cjs'].includes(basename(file)), throughVersion });
  console.log('Integración aislada: ' + file + ' [' + name + ']');
  try {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', file], {
      cwd: resolve(__dirname, '..'),
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, NODE_ENV: 'test', POS_INTEGRATION_DATABASE: name }
    });
    return await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolveExit(code ?? 1));
    });
  } finally {
    await connection.query('DROP DATABASE `' + name + '`');
    console.log('Base temporal eliminada: ' + name);
  }
}

function selectedIntegrationFiles(args) {
  const filters = [
    ['--pool-only', ['tests/integration/schema-migrations.test.cjs', 'tests/integration/pool-saturation.test.cjs']],
    ['--migration-archive-only', ['tests/integration/schema-migrations.test.cjs', 'tests/integration/system-admin-migration-archive.test.cjs', 'tests/integration/system-admin-migration-onboarding.test.cjs']],
    ['--migration-projection-only', ['tests/integration/schema-migrations.test.cjs', 'tests/integration/system-admin-migration-archive.test.cjs', 'tests/integration/system-admin-migration-projection.test.cjs', 'tests/integration/system-admin-migration-onboarding.test.cjs']],
    ['--migration-continuation-only', ['tests/integration/schema-migrations.test.cjs', 'tests/integration/system-admin-migration-real-continuation.test.cjs']],
      ['--migration-016-only', ['tests/integration/migration-016-compatibility.test.cjs']],
    ['--migration-017-only', ['tests/integration/migration-017-compatibility.test.cjs']],
    ['--business-plans-only', ['tests/integration/business-plans.test.cjs']],
    ['--auth-only', ['tests/integration/auth.test.cjs']],
    ['--local-licenses-only', ['tests/integration/schema-migrations.test.cjs', 'tests/integration/local-licenses.test.cjs']],
    ['--login-limit-only', ['tests/integration/schema-migrations.test.cjs', 'tests/integration/auth.test.cjs']],
    ['--migration-onboarding-only', ['tests/integration/system-admin-migration-onboarding.test.cjs']],
    ['--migration-history-only', ['tests/integration/schema-migrations.test.cjs', 'tests/integration/system-admin-migration-archive.test.cjs', 'tests/integration/system-admin-migration-onboarding.test.cjs', 'tests/integration/migration-history.test.cjs']],
    ['--financial-only', ['tests/integration/schema-migrations.test.cjs', 'tests/integration/financial.test.cjs']],
    ['--procurement-only', ['tests/integration/schema-migrations.test.cjs', 'tests/integration/procurement.test.cjs']],
    ['--settings-only', ['tests/integration/schema-migrations.test.cjs', 'tests/integration/business-settings.test.cjs']],
    ['--cash-support-only', ['tests/integration/cash-support-history.test.cjs']],
    ['--reports-only', ['tests/integration/reports.test.cjs']],
    ['--sales-only', ['tests/integration/schema-migrations.test.cjs', 'tests/integration/sales.test.cjs']],
    ['--business-deletion-only', ['tests/integration/business-deletion.test.cjs']]
  ];
  let selected = integrationFiles;
  for (const [flag, files] of filters) if (args.includes(flag)) selected = selected.filter(file => files.includes(file));
  if (args.includes('--operational-only')) selected = selected.filter(file => !file.includes('migration.test.cjs'));
  return selected;
}

async function main() {
  const config = readConfig();
  const mysqlConfig = { ...config.database };
  delete mysqlConfig.connectionQueueLimit;
  delete mysqlConfig.acquireTimeout;
  const connection = await mysql.createConnection({ ...mysqlConfig, database: undefined, connectionLimit: undefined });
  let exitCode = 0;
  try {
    if (process.argv[2] === '--browser') {
      const { runBrowserTests } = require('./test-connected.cjs');
      const args = process.argv.slice(3);
      const testDirectory = resolve(__dirname, '../../tests-connected');
      const availableSpecs = readdirSync(testDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.spec.cjs'))
        .map(entry => 'tests-connected/' + entry.name)
        .sort();
      const available = new Set(availableSpecs);
      const requestedSpecs = args
        .filter(argument => argument.replaceAll('\\', '/').startsWith('tests-connected/') && argument.endsWith('.spec.cjs'))
        .map(argument => argument.replaceAll('\\', '/'));
      if (requestedSpecs.some(file => !available.has(file))) throw new Error('Suite de navegador no reconocida');
      const specs = requestedSpecs.length ? requestedSpecs : availableSpecs;
      const playwrightOptions = args.filter(argument => !requestedSpecs.includes(argument.replaceAll('\\', '/')));
      for (const spec of specs) {
        const name = await prepareDatabase(connection, config, { empty: true });
        console.log('Integración de navegador: base temporal ' + name + ' (' + spec + ')');
        try {
          const code = await runBrowserTests({ config, database: name, playwrightArgs: [spec, ...playwrightOptions] });
          if (code !== 0) exitCode = 1;
        } finally {
          await connection.query('DROP DATABASE `' + name + '`');
          console.log('Base temporal eliminada: ' + name);
        }
      }
      return exitCode;
    }

    const files = selectedIntegrationFiles(process.argv.slice(2));
    if (!files.length) throw new Error('No hay suites de integración seleccionadas');
    for (const file of files) {
      const throughVersion = process.argv.includes('--migration-016-only') ? '015' : process.argv.includes('--migration-017-only') || file.endsWith('migration-017-compatibility.test.cjs') ? '016' : null;
      const code = await runFile(connection, config, file, { throughVersion });
      if (code !== 0) exitCode = 1;
    }
    return exitCode;
  } finally {
    await connection.end();
  }
}

main().then(code => { process.exitCode = code; }).catch(error => {
  const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
  const message = typeof error?.message === 'string' ? error.message.replace(/(password|passwd|secret|token)\s*[:=]\s*\S+/ig, '$1=[redacted]') : 'Error sin detalle';
  console.error('Falló la integración (' + code + '): ' + message + '. Requiere MySQL accesible y permisos CREATE/DROP sobre pos_auth_test_*. No se modificó la base principal.');
  process.exitCode = 1;
});
