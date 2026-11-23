'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createGunzip, createGzip } = require('node:zlib');
const { PassThrough, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ROOT = path.resolve(__dirname, '..');

function safeDatabaseName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(value)) throw new Error('Database name is invalid');
  return value;
}

function safeImageName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(value)) throw new Error('Backend image name is invalid');
  return value;
}

function argumentsOf(args) {
  const options = { destination: null, project: null, envFiles: [], files: [], database: process.env.POS_DATABASE_NAME || 'pos_docker_local', backendImage: process.env.POS_BACKEND_IMAGE || 'pos-local-backend:latest' };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === '--out' && !options.destination) { options.destination = value; index++; }
    else if (arg === '--project') { options.project = value; index++; }
    else if (arg === '--env-file') { options.envFiles.push(value); index++; }
    else if (arg === '--file') { options.files.push(value); index++; }
    else if (arg === '--database') { options.database = value; index++; }
    else if (arg === '--backend-image') { options.backendImage = value; index++; }
    else throw new Error('Unknown or duplicate backup option');
    if (value === undefined || value.startsWith('--')) throw new Error(arg + ' requires a value');
  }
  if (!options.destination || !path.isAbsolute(options.destination)) throw new Error('Use: node scripts/docker-backup.cjs --out <absolute-backup-directory>');
  if (options.project && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(options.project)) throw new Error('Compose project name is invalid');
  if (options.envFiles.some(file => !path.isAbsolute(file))) throw new Error('Compose env-file paths must be absolute');
  if (options.files.some(file => !file || file.startsWith('-'))) throw new Error('Compose file path is invalid');
  options.database = safeDatabaseName(options.database);
  options.backendImage = safeImageName(options.backendImage);
  return { ...options, destination: path.resolve(options.destination) };
}

function composeArgs(options, args) {
  const prefix = ['compose'];
  if (options.project) prefix.push('--project-name', options.project);
  for (const envFile of options.envFiles) prefix.push('--env-file', envFile);
  for (const file of options.files) prefix.push('--file', file);
  return prefix.concat(args);
}

function composeRun(options, args, runOptions) {
  return run(composeArgs(options, args), runOptions);
}

function redact(value) {
  return String(value).replace(/(password|passwd|secret|token|MYSQL_PWD)\s*[:=]\s*\S+/ig, '$1=[redacted]');
}

function run(args, { env = process.env, inputFile, outputFile, gzipOutput = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { cwd: ROOT, env, windowsHide: true, stdio: [inputFile ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const errors = [];
    let errorBytes = 0;
    child.stderr.on('data', chunk => {
      if (errorBytes < 8192) { errors.push(chunk); errorBytes += chunk.length; }
    });
    child.once('error', error => reject(new Error(error.code === 'ENOENT' ? 'Docker CLI is unavailable; install and start Docker Desktop first' : redact(error.message))));

    const streams = [];
    if (outputFile) {
      const sink = createWriteStream(outputFile, { flags: 'wx', mode: 0o600 });
      const transform = gzipOutput ? createGzip({ level: 6 }) : new PassThrough();
      streams.push(pipeline(child.stdout, transform, sink));
    } else {
      const output = [];
      let outputBytes = 0;
      child.stdout.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > 4 * 1024 * 1024) { child.kill(); return; }
        output.push(chunk);
      });
      streams.push(new Promise((resolveOutput, rejectOutput) => {
        child.stdout.once('end', () => resolveOutput(Buffer.concat(output).toString('utf8')));
        child.stdout.once('error', rejectOutput);
      }));
    }
    if (inputFile) streams.push(pipeline(createReadStream(inputFile), child.stdin));

    const exited = new Promise((resolveExit, rejectExit) => {
      child.once('close', (code, signal) => {
        if (code !== 0) rejectExit(new Error('Docker command failed (' + (signal || code) + '): ' + redact(Buffer.concat(errors).toString('utf8').trim() || 'no details')));
        else resolveExit();
      });
    });
    Promise.all([...streams, exited]).then(values => resolve(values.find(value => typeof value === 'string') || '')).catch(error => {
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

async function verifyGzip(filename) {
  await pipeline(createReadStream(filename), createGunzip(), new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
}

async function main() {
  const options = argumentsOf(process.argv.slice(2));
  const { database, backendImage } = options;
  const destination = options.destination;
  await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
  const destinationReal = await fsp.realpath(destination);
  const relative = path.relative(ROOT, destinationReal);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Backups must be stored outside the repository');
  }

  const runningApplications = await composeRun(options, ['ps', '--status', 'running', '-q', 'backend', 'frontend']);
  if (runningApplications.trim()) throw new Error('Stop backend and frontend for a consistent database and image backup, then retry');
  const resolvedCompose = JSON.parse(await composeRun(options, ['config', '--format', 'json']));
  if (resolvedCompose.services?.mysql?.environment?.MYSQL_DATABASE !== database
    || resolvedCompose.services?.backend?.environment?.DB_NAME !== database
    || resolvedCompose.services?.backend?.image !== backendImage) {
    throw new Error('Resolved Compose database or backend image does not match the requested backup target');
  }
  const mysqlReady = 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql --user=root --database="$MYSQL_DATABASE" --execute="SELECT 1" >/dev/null';
  await composeRun(options, ['exec', '-T', 'mysql', 'sh', '-ec', mysqlReady]);
  await run(['image', 'inspect', backendImage]);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(destinationReal, 'pos-backup-' + stamp + '-' + crypto.randomBytes(4).toString('hex'));
  await fsp.mkdir(backupDir, { recursive: false, mode: 0o700 });
  const sqlFile = path.join(backupDir, 'database.sql.gz');
  const imageFile = path.join(backupDir, 'product-images.tar.gz');

  const databaseManifestCommand = ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'backend', 'backend/scripts/docker-database-manifest.cjs'];
  const databaseBefore = JSON.parse((await composeRun(options, databaseManifestCommand)).trim());
  if (databaseBefore.database !== database || !Number.isSafeInteger(databaseBefore.tableCount) || !/^\d+$/.test(databaseBefore.totalRows) || !/^[a-f0-9]{64}$/.test(databaseBefore.objectSha256)) {
    throw new Error('Database inventory returned an invalid format');
  }
  const dumpCommand = 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysqldump --user=root --single-transaction --quick --routines --triggers --events --hex-blob --no-tablespaces --default-character-set=utf8mb4 "$MYSQL_DATABASE"';
  await composeRun(options, ['exec', '-T', 'mysql', 'sh', '-ec', dumpCommand], { outputFile: sqlFile, gzipOutput: true });
  await verifyGzip(sqlFile);
  const databaseAfter = JSON.parse((await composeRun(options, databaseManifestCommand)).trim());
  if (JSON.stringify(databaseBefore) !== JSON.stringify(databaseAfter)) throw new Error('Database inventory changed while the backup was being created; no verified backup manifest was written');

  const imageOutput = await composeRun(options, ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'backend', 'backend/scripts/docker-image-manifest.cjs']);
  const imageManifest = JSON.parse(imageOutput.trim());
  if (!Number.isSafeInteger(imageManifest.fileCount) || !Number.isSafeInteger(imageManifest.totalBytes) || !/^[a-f0-9]{64}$/.test(imageManifest.sha256)) {
    throw new Error('Image inventory returned an invalid format');
  }
  const databaseManifest = databaseAfter;
  const tarCommand = 'tar --numeric-owner -czf - -C "$IMAGE_STORAGE_DIR" .';
  await composeRun(options, ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', 'backend', '-ec', tarCommand], { outputFile: imageFile });
  const checkTarCommand = 'tar -tzf - >/dev/null';
  await composeRun(options, ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'sh', 'backend', '-ec', checkTarCommand], { inputFile: imageFile });
  const finalImageOutput = await composeRun(options, ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'backend', 'backend/scripts/docker-image-manifest.cjs']);
  if (JSON.stringify(JSON.parse(finalImageOutput.trim())) !== JSON.stringify(imageManifest)) throw new Error('Product images changed while the backup was being created; no valid backup manifest was written');

  const [sqlStat, imageStat] = await Promise.all([fsp.stat(sqlFile), fsp.stat(imageFile)]);
  const manifest = {
    format: 'pos-docker-backup-v2',
    createdAt: new Date().toISOString(),
    database,
    backendImage,
    databaseState: databaseManifest,
    databaseDump: { file: 'database.sql.gz', bytes: sqlStat.size, sha256: await sha256(sqlFile) },
    productImages: { file: 'product-images.tar.gz', bytes: imageStat.size, archiveSha256: await sha256(imageFile), ...imageManifest }
  };
  await fsp.writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ backupDir, databaseBytes: sqlStat.size, databaseSha256: manifest.databaseDump.sha256, imageArchiveBytes: imageStat.size, imageArchiveSha256: manifest.productImages.archiveSha256, imageFiles: imageManifest.fileCount, imageBytes: imageManifest.totalBytes }));
}

main().catch(error => {
  console.error('Docker backup stopped safely: ' + redact(error?.message || 'unknown error'));
  process.exitCode = 1;
});
