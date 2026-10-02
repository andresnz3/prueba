'use strict';
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');
const { randomBytes } = require('node:crypto');
const { runBrowserTests } = require('./test-connected.cjs');
const { readConfig } = require('../src/config/environment');
async function main() {
  const config = readConfig();
  const name = 'pos_auth_test_' + randomBytes(12).toString('hex');
  if (!/^pos_auth_test_[a-f0-9]{24}$/.test(name) || name === config.database.database) throw new Error('Nombre de pruebas inseguro');
  const connection = await mysql.createConnection({ ...config.database, database: undefined, connectionLimit: undefined });
  let created = false;
  try {
    await connection.query('CREATE DATABASE \x60' + name + '\x60 CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    created = true;
    await connection.query('USE \x60' + name + '\x60');
    const schema = readFileSync(resolve(__dirname, '../../database/schema.sql'), 'utf8');
    // Importar solo CREATE TABLE; nunca CREATE DATABASE/USE del esquema principal.
    const tables = schema.slice(schema.indexOf('CREATE TABLE businesses'));
    for (const sql of tables.split(';').map(s => s.trim()).filter(Boolean)) await connection.query(sql);
    const migration = readFileSync(resolve(__dirname, '../../database/migrations/001_authorization_grantor.sql'), 'utf8');
    await connection.query(migration);
    console.log('Integracion: base temporal ' + name);
    if (process.argv[2] === '--browser') {
      process.exitCode = await runBrowserTests({ config, database: name });
      return;
    }
    const child = spawn(process.execPath, ['--test', 'tests/integration/auth.test.cjs'], { cwd: resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true, env: { ...process.env, NODE_ENV: 'test', POS_INTEGRATION_DATABASE: name } });
    process.exitCode = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', code => resolveExit(code ?? 1)); });
  } finally {
    if (created) { await connection.query('DROP DATABASE \x60' + name + '\x60'); console.log('Base temporal eliminada'); }
    await connection.end();
  }
}
main().catch(() => { console.error('Fallo la integracion. Requiere MySQL accesible y permisos CREATE/DROP sobre pos_auth_test_*. No se modifico la base principal.'); process.exitCode = 1; });
