'use strict';

const mysql = require('/app/backend/node_modules/mysql2/promise');

async function main() {
  const target = process.env.POS_TEMP_DB_TO_DROP;
  if (!/^pos_auth_test_[a-f0-9]{24}$/.test(target || '') || target === process.env.DB_NAME || ['pos_multitenant', 'pos_docker_local'].includes(target)) {
    throw new Error('Refusing database cleanup outside a verified isolated test database.');
  }
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    charset: 'utf8mb4'
  });
  try {
    const [existing] = await db.execute('SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?', [target]);
    if (!existing.length) {
      process.stdout.write('Temporary test database already absent.\n');
      return;
    }
    await db.query('DROP DATABASE `' + target + '`');
    process.stdout.write('Removed validated temporary database ' + target + '.\n');
  } finally {
    await db.end();
  }
}

main().catch(error => {
  process.stderr.write('Temporary database cleanup refused or failed (' + (error.code || 'validation') + ').\n');
  process.exitCode = 1;
});
