'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const mysql = require('mysql2/promise');
const { readConfig } = require('../src/config/environment');

const MAIN = 'pos_multitenant';
const BACKUP_TOOL = 'F:\\mysqldump.exe';
const RESTORE_TOOL = 'F:\\mysql.exe';
const BACKEND_DIR = path.resolve(__dirname, '..');
const REQUIRED_PRE = Array.from({ length: 16 }, (_, i) => String(i + 1).padStart(3, '0'));
const OMIT_DATA_TABLE = 'schema_migrations';
const SECRET_KEYS = ['DB_PASSWORD', 'CSRF_SECRET'];
const baseConfig = readConfig().database;

function safeError(error) {
  let message = String(error && error.message || 'unknown error');
  for (const key of SECRET_KEYS) {
    const secret = process.env[key];
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message.slice(0, 2500);
}

function quoteId(value) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(value)) throw new Error('Unsafe SQL identifier');
  return String.fromCharCode(96) + value + String.fromCharCode(96);
}

function encodeValue(value) {
  if (Buffer.isBuffer(value)) return { binaryHex: value.toString('hex') };
  if (typeof value === 'bigint') return { integer: value.toString() };
  if (value instanceof Date) return { date: value.toISOString() };
  return value;
}

function stableRow(row) {
  return JSON.stringify(Object.entries(row).map(([key, value]) => [key, encodeValue(value)]));
}

function digestStrings(values) {
  const hash = crypto.createHash('sha256');
  for (const value of values) {
    hash.update(value);
    hash.update('\n');
  }
  return hash.digest('hex');
}

function normalizeRows(rows) {
  return rows.map(stableRow).sort();
}

async function makePool(database) {
  return mysql.createPool({
    ...baseConfig,
    database,
    waitForConnections: false,
    connectionLimit: 2,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: true,
    timezone: 'Z',
    charset: 'utf8mb4',
    multipleStatements: false
  });
}

async function checkActivity(pool) {
  const [transactions] = await pool.execute(
    'SELECT COUNT(*) AS n FROM information_schema.innodb_trx tx JOIN information_schema.processlist p ON p.ID=tx.trx_mysql_thread_id WHERE p.DB=?',
    [MAIN]
  );
  const [queries] = await pool.execute(
    'SELECT COUNT(*) AS n FROM information_schema.processlist WHERE DB=? AND COMMAND<>? AND ID<>CONNECTION_ID()',
    [MAIN, 'Sleep']
  );
  const trx = Number(transactions[0].n);
  const active = Number(queries[0].n);
  if (trx || active) throw new Error('Activity gate: ' + trx + ' active InnoDB transaction(s), ' + active + ' active query connection(s)');
  return { activeTransactions: trx, activeQueries: active };
}

async function snapshot(pool, database) {
  const [objects] = await pool.execute(
    'SELECT table_name AS name, table_type AS type, engine FROM information_schema.tables WHERE table_schema=? ORDER BY table_name',
    [database]
  );
  const tables = {};
  const views = {};
  for (const object of objects) {
    const name = String(object.name);
    if (object.type === 'VIEW') {
      const [created] = await pool.query('SHOW CREATE VIEW ' + quoteId(database) + '.' + quoteId(name));
      const definition = Object.values(created[0])[1];
      views[name] = crypto.createHash('sha256').update(String(definition)).digest('hex');
      continue;
    }
    if (object.type !== 'BASE TABLE') continue;
    const [rows] = await pool.query('SELECT * FROM ' + quoteId(database) + '.' + quoteId(name));
    const encoded = normalizeRows(rows);
    tables[name] = {
      engine: object.engine,
      rowCount: rows.length,
      sha256: digestStrings(encoded)
    };
  }

  const [routineRows] = await pool.execute(
    'SELECT routine_name AS name,routine_type AS type,routine_definition AS definition,sql_data_access AS dataAccess,is_deterministic AS deterministicFlag,security_type AS securityType,definer FROM information_schema.routines WHERE routine_schema=? ORDER BY routine_name,routine_type',
    [database]
  );
  const [triggerRows] = await pool.execute(
    'SELECT trigger_name AS name,event_manipulation AS event,event_object_table AS tableName,action_statement AS statement,action_timing AS timing,definer FROM information_schema.triggers WHERE trigger_schema=? ORDER BY trigger_name',
    [database]
  );
  const [eventRows] = await pool.execute(
    'SELECT event_name AS name,event_definition AS definition,status,event_type AS type,interval_value AS intervalValue,interval_field AS intervalField,time_zone AS timeZone,definer FROM information_schema.events WHERE event_schema=? ORDER BY event_name',
    [database]
  );

  return {
    database,
    tables,
    views,
    routines: digestStrings(normalizeRows(routineRows)),
    routineCount: routineRows.length,
    triggers: digestStrings(normalizeRows(triggerRows)),
    triggerCount: triggerRows.length,
    events: digestStrings(normalizeRows(eventRows)),
    eventCount: eventRows.length
  };
}

function dataDiff(before, after, omitLedger) {
  const diffs = [];
  const names = [...new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])].sort();
  for (const name of names) {
    if (omitLedger && name === OMIT_DATA_TABLE) continue;
    const left = before.tables[name];
    const right = after.tables[name];
    if (!left || !right || left.rowCount !== right.rowCount || left.sha256 !== right.sha256) {
      diffs.push({ table: name, before: left || null, after: right || null });
    }
  }
  return diffs;
}

function objectDiff(before, after) {
  return ['views', 'routines', 'routineCount', 'triggers', 'triggerCount', 'events', 'eventCount']
    .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

function quoteOption(value) {
  const raw = String(value);
  if (/[\r\n\0]/.test(raw)) throw new Error('Invalid newline in MySQL connection configuration');
  return '"' + raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

async function createOptionFile() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pos-017-mysql-'));
  const optionPath = path.join(dir, 'client.cnf');
  const content = [
    '[client]',
    'host=' + quoteOption(baseConfig.host),
    'port=' + quoteOption(baseConfig.port),
    'user=' + quoteOption(baseConfig.user),
    'password=' + quoteOption(baseConfig.password),
    'default-character-set=utf8mb4',
    ''
  ].join('\n');
  await fsp.writeFile(optionPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { dir, optionPath };
}

function runStream(command, args, streamSetup) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: BACKEND_DIR, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { if (stderr.length < 8000) stderr += chunk; });
    const closePromise = new Promise((done, fail) => {
      child.once('error', fail);
      child.once('close', (code, signal) => done({ code, signal }));
    });
    Promise.resolve().then(() => streamSetup(child)).then(async () => {
      const result = await closePromise;
      if (result.code !== 0) return reject(new Error(path.basename(command) + ' exited ' + result.code + ': ' + safeError(new Error(stderr || result.signal || 'no diagnostic'))));
      resolve();
    }).catch(error => {
      child.kill();
      reject(error);
    });
  });
}

function assertPlan(output, expectedPending) {
  const rows = output.split(/\r?\n/).map(line => {
    const match = line.match(/^\s*(\d{3})\s+(applied|pending)\s+(skipped|planned|applied)\s*$/);
    return match ? { version: match[1], status: match[2], action: match[3] } : null;
  }).filter(Boolean);
  const versions = rows.map(row => row.version);
  const expected = [...REQUIRED_PRE, '017'];
  if (JSON.stringify(versions) !== JSON.stringify(expected)) throw new Error('Official migration plan did not list exactly 001–017; received=' + JSON.stringify(rows) + '; output=' + output.slice(0, 2000));
  const bad = rows.filter(row => row.version === '017' ? row.status !== expectedPending : row.status !== 'applied');
  if (bad.length) throw new Error('Unexpected official migration plan states: ' + JSON.stringify(bad));
  return rows;
}

function runOfficial(database, mode, principal = false) {
  const args = ['--env-file=.env', 'scripts/migrate-all.cjs', '--' + mode, '--target', database, '--confirm-target', database];
  if (principal) args.push('--allow-principal');
  const result = spawnSync(process.execPath, args, {
    cwd: BACKEND_DIR,
    env: { ...process.env, DB_NAME: database },
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error('Official migration executor failed: ' + safeError(result.error || new Error(result.stderr || 'nonzero exit')));
  }
  return result.stdout;
}

async function currentMainSnapshot() {
  const pool = await makePool(MAIN);
  try {
    const activity = await checkActivity(pool);
    const current = await snapshot(pool, MAIN);
    return { activity, current };
  } finally {
    await pool.end();
  }
}

async function loadMetadata(file) {
  const raw = await fsp.readFile(file, 'utf8');
  const metadata = JSON.parse(raw);
  if (metadata.database !== MAIN || typeof metadata.backupPath !== 'string' || !metadata.preSnapshot) {
    throw new Error('Verification metadata is not a backup created by this helper');
  }
  return metadata;
}

async function saveMetadata(file, metadata) {
  await fsp.writeFile(file, JSON.stringify(metadata, null, 2) + '\n', { encoding: 'utf8' });
}

async function makeBackup(directory) {
  if (baseConfig.database !== MAIN) throw new Error('Configured DB_NAME must exactly match pos_multitenant');
  if (!fs.existsSync(BACKUP_TOOL)) throw new Error('mysqldump.exe is unavailable at the verified tool path');
  const info = await fsp.stat(directory);
  if (!info.isDirectory()) throw new Error('Backup destination is not a directory');
  const pool = await makePool(MAIN);
  let activity, preSnapshot, schema;
  try {
    activity = await checkActivity(pool);
    const [schemaRows] = await pool.execute('SELECT default_character_set_name AS characterSet,default_collation_name AS collation FROM information_schema.schemata WHERE schema_name=?', [MAIN]);
    if (!schemaRows[0]) throw new Error('Principal schema was not found');
    schema = schemaRows[0];
    const [engines] = await pool.execute('SELECT table_name AS name,engine FROM information_schema.tables WHERE table_schema=? AND table_type=? AND engine<>?', [MAIN, 'BASE TABLE', 'InnoDB']);
    if (engines.length) throw new Error('Non-InnoDB tables prevent a consistent single-transaction backup: ' + engines.map(row => row.name).join(', '));
    preSnapshot = await snapshot(pool, MAIN);
  } finally {
    await pool.end();
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace(/-/g, '');
  const suffix = crypto.randomBytes(4).toString('hex');
  const base = 'pos_multitenant-pre-017-' + stamp + '-' + suffix;
  const backupPath = path.join(directory, base + '.sql');
  const metadataPath = path.join(directory, base + '.verification.json');
  if (fs.existsSync(backupPath) || fs.existsSync(metadataPath)) throw new Error('Refusing to overwrite an existing backup artifact');
  const option = await createOptionFile();
  try {
    await runStream(BACKUP_TOOL, [
      '--defaults-extra-file=' + option.optionPath,
      '--single-transaction',
      '--skip-lock-tables',
      '--quick',
      '--routines',
      '--triggers',
      '--events',
      '--hex-blob',
      '--default-character-set=utf8mb4',
      '--no-create-db',
      '--no-tablespaces',
      '--column-statistics=0',
      '--set-gtid-purged=OFF',
      MAIN
    ], child => pipeline(child.stdout, fs.createWriteStream(backupPath, { flags: 'wx' })));
  } catch (error) {
    if (fs.existsSync(backupPath)) await fsp.unlink(backupPath).catch(() => {});
    throw error;
  } finally {
    await fsp.rm(option.dir, { recursive: true, force: true });
  }
  const digest = crypto.createHash('sha256');
  const input = fs.createReadStream(backupPath);
  for await (const chunk of input) digest.update(chunk);
  const stat = await fsp.stat(backupPath);
  const metadata = {
    createdAt: new Date().toISOString(),
    database: MAIN,
    backupPath,
    backupBytes: stat.size,
    backupSha256: digest.digest('hex'),
    schemaDefaults: schema,
    activityAtBackup: activity,
    preSnapshot,
    restoreVerified: false,
    temporaryMigrationVerified: false,
    postApplyVerified: false
  };
  await fsp.writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({ backupPath, metadataPath, bytes: stat.size, sha256: metadata.backupSha256, tables: Object.keys(preSnapshot.tables).length, rows: Object.values(preSnapshot.tables).reduce((sum, row) => sum + row.rowCount, 0), routines: preSnapshot.routineCount, triggers: preSnapshot.triggerCount, events: preSnapshot.eventCount }));
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyAndTempApply(metadataPath) {
  const metadata = await loadMetadata(metadataPath);
  if (!fs.existsSync(RESTORE_TOOL)) throw new Error('mysql.exe is unavailable at the verified tool path');
  const actualHash = await hashFile(metadata.backupPath);
  const stat = await fsp.stat(metadata.backupPath);
  if (actualHash !== metadata.backupSha256 || stat.size !== metadata.backupBytes) throw new Error('Backup SHA-256 or byte length does not match its manifest');
  const tempDatabase = 'pos_auth_test_' + crypto.randomBytes(12).toString('hex');
  if (!/^pos_auth_test_[a-f0-9]{24}$/.test(tempDatabase)) throw new Error('Generated temporary database name failed validation');
  let created = false;
  const option = await createOptionFile();
  try {
    const admin = await makePool(MAIN);
    try {
      const [exists] = await admin.execute('SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name=?', [tempDatabase]);
      if (Number(exists[0].n)) throw new Error('Generated temporary database already exists; refusing to touch it');
      const charset = metadata.schemaDefaults.characterSet;
      const collation = metadata.schemaDefaults.collation;
      if (!/^[A-Za-z0-9_]+$/.test(charset) || !/^[A-Za-z0-9_]+$/.test(collation)) throw new Error('Source schema charset metadata is invalid');
      await admin.query('CREATE DATABASE ' + quoteId(tempDatabase) + ' CHARACTER SET ' + charset + ' COLLATE ' + collation);
      created = true;
    } finally {
      await admin.end();
    }

    await runStream(RESTORE_TOOL, [
      '--defaults-extra-file=' + option.optionPath,
      '--binary-mode=1',
      '--default-character-set=utf8mb4',
      tempDatabase
    ], child => pipeline(fs.createReadStream(metadata.backupPath), child.stdin));

    const restoredPool = await makePool(tempDatabase);
    let restored;
    try {
      restored = await snapshot(restoredPool, tempDatabase);
    } finally {
      await restoredPool.end();
    }
    const dataDifferences = dataDiff(metadata.preSnapshot, restored, false);
    const objectDifferences = objectDiff(metadata.preSnapshot, restored);
    if (dataDifferences.length || objectDifferences.length) {
      throw new Error('Restored backup differs from the source snapshot: ' + JSON.stringify({ dataDifferences: dataDifferences.slice(0, 8), objectDifferences }));
    }

    const planBefore = runOfficial(tempDatabase, 'plan');
    assertPlan(planBefore, 'pending');
    const applied = runOfficial(tempDatabase, 'apply');
    assertPlan(applied, 'applied');
    const planAfter = runOfficial(tempDatabase, 'plan');
    assertPlan(planAfter, 'applied');
    const afterPool = await makePool(tempDatabase);
    let after;
    try {
      after = await snapshot(afterPool, tempDatabase);
      const [constraint] = await afterPool.execute(
        'SELECT cc.check_clause AS clause FROM information_schema.check_constraints cc JOIN information_schema.table_constraints tc ON tc.constraint_schema=cc.constraint_schema AND tc.constraint_name=cc.constraint_name WHERE cc.constraint_schema=? AND tc.table_name=? AND tc.constraint_name=? AND tc.constraint_type=?',
        [tempDatabase, 'business_subscriptions', 'chk_business_subscriptions_plan', 'CHECK']
      );
      const clause = String(constraint[0]?.clause || '').toUpperCase();
      for (const code of ['LOCAL', 'CONECTADO_BASICO', 'CONECTADO_ESTANDAR', 'CONECTADO_PREMIUM']) {
        if (!clause.includes(code)) throw new Error('Restored test schema does not accept expected plan ' + code);
      }
    } finally {
      await afterPool.end();
    }
    const postDifferences = dataDiff(restored, after, true);
    if (postDifferences.length) throw new Error('Temporary 017 changed table data: ' + JSON.stringify(postDifferences.slice(0, 8)));
    metadata.restoreVerified = true;
    metadata.restoreVerifiedAt = new Date().toISOString();
    metadata.restoreSnapshot = restored;
    metadata.temporaryMigrationVerified = true;
    metadata.temporaryMigrationPlanBefore = planBefore;
    metadata.temporaryMigrationPlanAfter = planAfter;
    metadata.temporaryMigrationDataDifferences = postDifferences;
    metadata.temporaryDatabaseCreated = tempDatabase;
    await saveMetadata(metadataPath, metadata);
    console.log(JSON.stringify({ restore: 'verified', temporaryMigration017: 'APPLIED', dataDifferences: 0, objectsVerified: true, temporaryDatabase: tempDatabase }));
  } finally {
    await fsp.rm(option.dir, { recursive: true, force: true });
    if (created) {
      if (!/^pos_auth_test_[a-f0-9]{24}$/.test(tempDatabase) || tempDatabase === MAIN) {
        process.exitCode = 1;
        console.error('Refusing to clean up an invalid temporary database target');
      } else {
        const cleanup = await makePool(MAIN);
        try {
          await cleanup.query('DROP DATABASE ' + quoteId(tempDatabase));
        } finally {
          await cleanup.end();
        }
      }
    }
  }
}

async function verifyPreApply(metadataPath) {
  const metadata = await loadMetadata(metadataPath);
  if (!metadata.restoreVerified || !metadata.temporaryMigrationVerified) throw new Error('Backup restoration and temporary migration checks are required first');
  const plan = runOfficial(MAIN, 'plan', true);
  assertPlan(plan, 'pending');
  const { activity, current } = await currentMainSnapshot();
  if (activity.activeTransactions || activity.activeQueries) throw new Error('Activity gate: main database is not quiescent');
  const diffs = dataDiff(metadata.preSnapshot, current, false);
  const objects = objectDiff(metadata.preSnapshot, current);
  if (diffs.length || objects.length) throw new Error('Principal database changed after the backup; stop and create a new backup: ' + JSON.stringify({ dataDifferences: diffs.slice(0, 8), objectDifferences: objects }));
  metadata.preApplyVerifiedAt = new Date().toISOString();
  metadata.preApplyActivity = activity;
  await saveMetadata(metadataPath, metadata);
  console.log(JSON.stringify({ plan: '001-016 APPLIED, 017 PENDING', activity, dataAgainstBackup: 'identical', objectsAgainstBackup: 'identical' }));
}

async function verifyPostApply(metadataPath) {
  const metadata = await loadMetadata(metadataPath);
  if (!metadata.preApplyVerifiedAt) throw new Error('Pre-apply verification is required first');
  const plan = runOfficial(MAIN, 'plan', true);
  assertPlan(plan, 'applied');
  const { activity, current } = await currentMainSnapshot();
  const diffs = dataDiff(metadata.preSnapshot, current, true);
  if (diffs.length) throw new Error('Unexpected data changes after 017: ' + JSON.stringify(diffs.slice(0, 8)));
  const pool = await makePool(MAIN);
  let constraint;
  try {
    const [rows] = await pool.execute(
      'SELECT cc.check_clause AS clause FROM information_schema.check_constraints cc JOIN information_schema.table_constraints tc ON tc.constraint_schema=cc.constraint_schema AND tc.constraint_name=cc.constraint_name WHERE cc.constraint_schema=? AND tc.table_name=? AND tc.constraint_name=? AND tc.constraint_type=?',
      [MAIN, 'business_subscriptions', 'chk_business_subscriptions_plan', 'CHECK']
    );
    constraint = String(rows[0]?.clause || '').toUpperCase();
  } finally {
    await pool.end();
  }
  for (const code of ['LOCAL', 'CONECTADO_BASICO', 'CONECTADO_ESTANDAR', 'CONECTADO_PREMIUM']) {
    if (!constraint.includes(code)) throw new Error('Main schema does not accept expected plan ' + code);
  }
  metadata.postApplyVerified = true;
  metadata.postApplyVerifiedAt = new Date().toISOString();
  metadata.postApplyPlan = plan;
  metadata.postApplyDataDifferences = diffs;
  metadata.postApplyActivity = activity;
  await saveMetadata(metadataPath, metadata);
  console.log(JSON.stringify({ plan: '001-017 APPLIED', dataDifferences: 0, businessUserSubscriptionPaymentAndCommerceRows: 'unchanged', standardConstraint: 'verified' }));
}

async function main() {
  const [mode, argument] = process.argv.slice(2);
  if (mode === 'backup' && argument) return makeBackup(argument);
  if (mode === 'restore-test' && argument) return verifyAndTempApply(argument);
  if (mode === 'preapply' && argument) return verifyPreApply(argument);
  if (mode === 'post' && argument) return verifyPostApply(argument);
  throw new Error('Use backup <directory>, restore-test <verification.json>, preapply <verification.json>, or post <verification.json>');
}

main().catch(error => {
  console.error('Backup verification stopped safely: ' + safeError(error));
  process.exitCode = 1;
});
