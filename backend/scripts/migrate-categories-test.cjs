'use strict';

// Run from backend with an isolated test connection in .env:
// node --env-file=.env scripts/migrate-categories-test.cjs pos_auth_test_<24-hex> --plan|--apply
// Roll back only disposable test data with:
// node --env-file=.env scripts/migrate-categories-test.cjs pos_auth_test_<24-hex> --rollback --confirm-discard-test-categories

const { readConfig } = require('../src/config/environment');
const { createDatabasePool } = require('../src/config/database');
const { migrate } = require('../src/services/schema-migrations');

const [target, mode, confirmation] = process.argv.slice(2);
const validTarget = /^pos_auth_test_[a-f0-9]{24}$/.test(target || '');
const validMode = ['--plan', '--apply', '--rollback'].includes(mode);

async function main() {
  if (!validTarget || !validMode) throw new Error('Uso: <pos_auth_test_<24-hex>> --plan|--apply|--rollback [--confirm-discard-test-categories]');
  if (mode === '--rollback' && confirmation !== '--confirm-discard-test-categories') throw new Error('La reversión requiere --confirm-discard-test-categories');
  if (mode !== '--rollback' && confirmation) throw new Error('Argumento adicional no permitido');

  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database: target });
  try {
    const [[row]] = await pool.query('SELECT DATABASE() AS databaseName');
    if (row?.databaseName !== target) throw new Error('La conexión no coincide con la base temporal indicada');

    const prior = await migrate(pool, target, 'plan', { throughVersion: '020' });
    if (prior.length !== 20 || prior.some(item => item.status !== 'applied')) {
      throw new Error('Se requiere una base temporal con las migraciones 001–020 aplicadas');
    }

    if (mode === '--rollback') {
      const [[record]] = await pool.execute('SELECT file_name AS fileName, status FROM schema_migrations WHERE version=?', ['021']);
      const [[table]] = await pool.execute('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema=? AND table_name=?', [target, 'product_categories']);
      if (record?.fileName !== '021_business_product_categories.sql' || record.status !== 'APPLIED' || Number(table.count) !== 1) {
        throw new Error('La 021 no está aplicada completamente; no se revirtió nada');
      }
      await pool.execute('DROP TABLE product_categories');
      const [deleted] = await pool.execute('DELETE FROM schema_migrations WHERE version=? AND file_name=? AND status=?', ['021', '021_business_product_categories.sql', 'APPLIED']);
      if (deleted.affectedRows !== 1) throw new Error('Tabla retirada, pero no se pudo retirar la entrada 021 del ledger');
      console.log('Reversión 021 completada en ' + target);
      return;
    }

    const plan = await migrate(pool, target, 'plan', { throughVersion: '021' });
    const migration = plan.find(item => item.version === '021');
    if (migration?.status !== 'pending') throw new Error('La migración 021 debe estar pendiente; no se aplicó nada');
    if (mode === '--plan') {
      console.log('Plan: 021 pending en ' + target + '; no se ejecutó DDL');
      return;
    }

    const result = await migrate(pool, target, 'apply', { throughVersion: '021' });
    const applied = result.find(item => item.version === '021');
    if (applied?.status !== 'applied') throw new Error('La migración 021 no terminó como aplicada');
    console.log('Migración 021 aplicada en ' + target);
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error('Migración de prueba detenida: ' + (error.message || 'error desconocido'));
  process.exitCode = 1;
});
