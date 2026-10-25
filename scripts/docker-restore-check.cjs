'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createGunzip } = require('node:zlib');
const { PassThrough, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const BACKEND_IMAGE = 'pos-local-backend:latest';
const MYSQL_IMAGE = 'mysql:8.4.13';
const MAX_STDOUT = 8 * 1024 * 1024;

function argsOf(args) {
  if (args.length !== 2 || args[0] !== '--backup' || !path.isAbsolute(args[1])) {
    throw new Error('Use: node scripts/docker-restore-check.cjs --backup <absolute-backup-directory>');
  }
  return path.resolve(args[1]);
}

function redact(value) {
  return String(value).replace(/(password|passwd|secret|token|MYSQL_PWD)\s*[:=]\s*\S+/ig, '$1=[redacted]');
}

function run(args, { env = process.env, inputFile, gunzipInput = false, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env, windowsHide: true, stdio: [inputFile ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const stderr = [];
    let stderrSize = 0;
    const stdout = [];
    let stdoutSize = 0;
    child.stderr.on('data', chunk => { if (stderrSize < MAX_STDOUT) { stderr.push(chunk); stderrSize += chunk.length; } });
    child.stdout.on('data', chunk => {
      if (!capture) return;
      stdoutSize += chunk.length;
      if (stdoutSize > MAX_STDOUT) child.kill();
      else stdout.push(chunk);
    });
    child.once('error', error => reject(new Error(error.code === 'ENOENT' ? 'Docker CLI is unavailable' : redact(error.message))));
    const input = inputFile
      ? pipeline(createReadStream(inputFile), gunzipInput ? createGunzip() : new PassThrough(), child.stdin)
      : Promise.resolve();
    const exited = new Promise((resolveExit, rejectExit) => {
      child.once('close', (code, signal) => {
        if (code !== 0) rejectExit(new Error('Docker command failed (' + (signal || code) + '): ' + redact(Buffer.concat(stderr).toString('utf8').trim() || 'no details')));
        else resolveExit();
      });
    });
    Promise.all([input, exited]).then(() => resolve(Buffer.concat(stdout).toString('utf8'))).catch(error => {
      child.kill();
      reject(new Error(redact(error.message)));
    });
  });
}

async function sha256(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function sizeOf(filename) {
  return (await fsp.stat(filename)).size;
}

function isGeneratedName(value) {
  return /^pos_auth_test_[a-f0-9]{24}(?:_db|_images|_net)?$/.test(value);
}

async function exists(kind, name) {
  const result = await run([kind, 'inspect', name], { capture: true }).then(() => true, error => {
    if (/no such|not found|does not exist/i.test(error.message)) return false;
    throw error;
  });
  return result;
}

async function verifyGzip(filename) {
  await pipeline(createReadStream(filename), createGunzip(), new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
}

function validateTarListing(contents) {
  const paths = contents.split(/\r?\n/).filter(Boolean);
  for (const item of paths) {
    const normalized = item.replace(/^\.\//, '');
    if (normalized === '.' || normalized === '') continue;
    if (normalized.startsWith('/') || normalized.includes('\\') || normalized.includes('\0') || /^[A-Za-z]:/.test(normalized)) throw new Error('Image archive contains an unsafe path');
    if (normalized.split('/').some(part => part === '..')) throw new Error('Image archive contains a parent-directory path');
  }
}

async function main() {
  const backupDir = await fsp.realpath(argsOf(process.argv.slice(2)));
  const manifestPath = path.join(backupDir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  if (manifest.format !== 'pos-docker-backup-v2' || manifest.database !== 'pos_docker_local') throw new Error('Backup manifest is not a supported Docker POS backup');
  const sqlFile = path.join(backupDir, 'database.sql.gz');
  const imageFile = path.join(backupDir, 'product-images.tar.gz');
  for (const [filename, item, hashKey] of [[sqlFile, manifest.databaseDump, 'sha256'], [imageFile, manifest.productImages, 'archiveSha256']]) {
    if (!item || item.file !== path.basename(filename) || !Number.isSafeInteger(item.bytes) || !/^[a-f0-9]{64}$/.test(item[hashKey])) throw new Error('Backup manifest fields are invalid');
    if (await sizeOf(filename) !== item.bytes || await sha256(filename) !== item[hashKey]) throw new Error('Backup checksum mismatch: ' + path.basename(filename));
  }
  if (!Number.isSafeInteger(manifest.productImages.fileCount) || !Number.isSafeInteger(manifest.productImages.totalBytes) || !/^[a-f0-9]{64}$/.test(manifest.productImages.sha256)) throw new Error('Image manifest fields are invalid');
  await verifyGzip(sqlFile);
  await fsp.access(imageFile, fs.constants.R_OK);
  await run(['image', 'inspect', BACKEND_IMAGE]);
  await run(['image', 'inspect', MYSQL_IMAGE]).catch(async () => { await run(['pull', MYSQL_IMAGE]); });

  const suffix = crypto.randomBytes(12).toString('hex');
  const network = 'pos_auth_test_' + suffix + '_net';
  const databaseVolume = 'pos_auth_test_' + suffix + '_db';
  const imageVolume = 'pos_auth_test_' + suffix + '_images';
  const container = 'pos_restore_' + suffix;
  if (![network, databaseVolume, imageVolume].every(isGeneratedName)) throw new Error('Temporary resource name failed validation');
  const created = { network: false, databaseVolume: false, imageVolume: false, container: false };
  const rootPassword = crypto.randomBytes(32).toString('hex');
  const runtimeEnv = { ...process.env, MYSQL_ROOT_PASSWORD: rootPassword };
  let cleanupFailed = false;
  try {
    for (const [kind, name] of [['network', network], ['volume', databaseVolume], ['volume', imageVolume]]) {
      if (await exists(kind, name)) throw new Error('Generated temporary Docker resource already exists; refusing to reuse it');
    }
    await run(['network', 'create', '--internal', network]);
    created.network = true;
    await run(['volume', 'create', databaseVolume]);
    created.databaseVolume = true;
    await run(['volume', 'create', imageVolume]);
    created.imageVolume = true;

    await run(['run', '-d', '--name', container, '--network', network, '--network-alias', 'mysql', '--env', 'MYSQL_DATABASE=pos_docker_local', '--env', 'MYSQL_ROOT_PASSWORD', '--mount', 'type=volume,src=' + databaseVolume + ',dst=/var/lib/mysql', MYSQL_IMAGE], { env: runtimeEnv, capture: true });
    created.container = true;
    let ready = false;
    const deadline = Date.now() + 120000;
    const mysqlReady = 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --user=root --host=127.0.0.1 --database="$MYSQL_DATABASE" --execute="SELECT 1" >/dev/null';
    while (Date.now() < deadline) {
      try {
        await run(['exec', container, 'sh', '-ec', mysqlReady], { env: runtimeEnv });
        ready = true;
        break;
      } catch { await new Promise(resolve => setTimeout(resolve, 2000)); }
    }
    if (!ready) throw new Error('Temporary MySQL did not become healthy within 120 seconds');

    const mysqlRestore = 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --user=root "$MYSQL_DATABASE"';
    await run(['exec', '-i', container, 'sh', '-ec', mysqlRestore], { env: runtimeEnv, inputFile: sqlFile, gunzipInput: true });
    const tableListQuery = 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --user=root --batch --skip-column-names --database="$MYSQL_DATABASE" --execute="SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE=\'BASE TABLE\' ORDER BY TABLE_NAME"';
    const tableList = await run(['exec', container, 'sh', '-ec', tableListQuery], { env: runtimeEnv, capture: true });
    const tableNames = tableList.split(/\r?\n/).map(name => name.trim()).filter(Boolean);
    if (tableNames.length === 0 || tableNames.some(name => !/^[A-Za-z0-9_$]+$/.test(name))) {
      throw new Error('Restored database did not return a valid base-table inventory');
    }
    const checkSql = tableNames.map(name => 'CHECK TABLE `pos_docker_local`.`' + name + '`').join('; ');
    const checkCommand = 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --user=root --batch --raw --skip-column-names --execute=\'' + checkSql + '\'';
    const mysqlCheck = await run(['exec', container, 'sh', '-ec', checkCommand], { env: runtimeEnv, capture: true });
    const checkRows = mysqlCheck.trim().split(/\r?\n/).filter(Boolean).map(row => row.split('\t'));
    const checkedTables = new Set();
    for (const [table, operation, messageType, message] of checkRows) {
      if (operation === 'check' && messageType === 'status' && message === 'OK' && table.startsWith('pos_docker_local.')) {
        checkedTables.add(table.slice('pos_docker_local.'.length));
      }
    }
    if (checkRows.length !== tableNames.length || checkedTables.size !== tableNames.length || tableNames.some(name => !checkedTables.has(name))) {
      throw new Error('One or more restored MySQL tables failed CHECK TABLE integrity validation');
    }

    const migrationEnv = { ...process.env, DB_HOST: 'mysql', DB_PORT: '3306', DB_NAME: 'pos_docker_local', DB_USER: 'root', DB_PASSWORD: rootPassword, NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '3000', CORS_ORIGINS: 'http://localhost:8080', CSRF_SECRET: crypto.randomBytes(32).toString('hex'), IMAGE_STORAGE_DIR: '/tmp/pos-restore-images', TRUST_PROXY_HOPS: '0' };
    const restoredDatabaseText = await run(['run', '--rm', '--network', network, '--env', 'DB_HOST', '--env', 'DB_PORT', '--env', 'DB_NAME', '--env', 'DB_USER', '--env', 'DB_PASSWORD', '--env', 'NODE_ENV', '--env', 'HOST', '--env', 'PORT', '--env', 'CORS_ORIGINS', '--env', 'CSRF_SECRET', '--env', 'IMAGE_STORAGE_DIR', '--env', 'TRUST_PROXY_HOPS', '--entrypoint', 'node', BACKEND_IMAGE, 'backend/scripts/docker-database-manifest.cjs'], { env: migrationEnv, capture: true });
    const restoredDatabase = JSON.parse(restoredDatabaseText.trim());
    const originalDatabase = manifest.databaseState;
    if (!originalDatabase || originalDatabase.database !== 'pos_docker_local' || restoredDatabase.database !== originalDatabase.database || restoredDatabase.totalRows !== originalDatabase.totalRows || restoredDatabase.tableCount !== originalDatabase.tableCount || restoredDatabase.objectSha256 !== originalDatabase.objectSha256 || JSON.stringify(restoredDatabase.objectCounts) !== JSON.stringify(originalDatabase.objectCounts) || JSON.stringify(restoredDatabase.tables) !== JSON.stringify(originalDatabase.tables)) {
      throw new Error('Restored database inventory differs from its backup manifest');
    }
    const plan = await run(['run', '--rm', '--network', network, '--env', 'DB_HOST', '--env', 'DB_PORT', '--env', 'DB_NAME', '--env', 'DB_USER', '--env', 'DB_PASSWORD', '--env', 'NODE_ENV', '--env', 'HOST', '--env', 'PORT', '--env', 'CORS_ORIGINS', '--env', 'CSRF_SECRET', '--env', 'IMAGE_STORAGE_DIR', '--env', 'TRUST_PROXY_HOPS', '--entrypoint', 'node', BACKEND_IMAGE, 'backend/scripts/migrate-all.cjs', '--plan', '--target', 'pos_docker_local', '--confirm-target', 'pos_docker_local'], { env: migrationEnv, capture: true });
    for (let number = 1; number <= 17; number++) {
      const version = String(number).padStart(3, '0');
      if (!new RegExp('^' + version + '\\s+applied\\s+skipped$', 'm').test(plan)) throw new Error('Restored database did not report migration ' + version + ' as APPLIED');
    }

    const tarListing = await run(['run', '--rm', '-i', '--network', 'none', '--entrypoint', 'sh', BACKEND_IMAGE, '-ec', 'tar -tzf -'], { inputFile: imageFile, capture: true });
    validateTarListing(tarListing);
    const extractCommand = 'tar -xzf - -C "$IMAGE_STORAGE_DIR" && node backend/scripts/docker-image-manifest.cjs';
    const restoredImagesText = await run(['run', '--rm', '-i', '--network', 'none', '--mount', 'type=volume,src=' + imageVolume + ',dst=/var/lib/pos/product-images', '--env', 'IMAGE_STORAGE_DIR=/var/lib/pos/product-images', '--entrypoint', 'sh', BACKEND_IMAGE, '-ec', extractCommand], { inputFile: imageFile, capture: true });
    const restoredImages = JSON.parse(restoredImagesText.trim());
    if (restoredImages.fileCount !== manifest.productImages.fileCount || restoredImages.totalBytes !== manifest.productImages.totalBytes || restoredImages.sha256 !== manifest.productImages.sha256) {
      throw new Error('Restored image inventory does not match its backup manifest');
    }

    console.log(JSON.stringify({ restore: 'verified', tableIntegrityCheck: 'CHECK TABLE OK', databaseRows: restoredDatabase.totalRows, tableCount: restoredDatabase.tableCount, routinesTriggersEventsSha256: restoredDatabase.objectSha256, migrations: '001-017 APPLIED', imageFiles: restoredImages.fileCount, imageBytes: restoredImages.totalBytes, temporaryResources: 'isolated; cleanup follows' }));
  } finally {
    if (created.container && /^pos_restore_[a-f0-9]{24}$/.test(container)) {
      try { await run(['rm', '-f', container]); } catch { cleanupFailed = true; }
    }
    for (const [key, name] of [['imageVolume', imageVolume], ['databaseVolume', databaseVolume]]) {
      if (created[key] && isGeneratedName(name)) {
        try { await run(['volume', 'rm', name]); } catch { cleanupFailed = true; }
      }
    }
    if (created.network && isGeneratedName(network)) {
      try { await run(['network', 'rm', network]); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) {
      console.error('Temporary Docker cleanup needs attention; inspect only these generated pos_auth_test_/pos_restore_ resources.');
      process.exitCode = 1;
    }
  }
}

main().catch(error => {
  console.error('Docker restore check stopped safely: ' + redact(error?.message || 'unknown error'));
  process.exitCode = 1;
});
