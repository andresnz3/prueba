'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const members = ['Dockerfile.frontend', 'MANIFEST.sha256', 'apply-connected-charge-fix.cjs'];
const manifestMembers = ['Dockerfile.frontend', 'apply-connected-charge-fix.cjs'];
const blockSize = 512;

function fail(message) { throw new Error(message); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function deterministicGzip(bytes) {
  const chunks = [Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff])];
  let offset = 0;
  if (!bytes.length) {
    const emptyBlock = Buffer.from([0x01, 0x00, 0x00, 0xff, 0xff]);
    chunks.push(emptyBlock);
  }
  while (offset < bytes.length) {
    const length = Math.min(65535, bytes.length - offset);
    const final = offset + length === bytes.length;
    const block = Buffer.alloc(5);
    block[0] = final ? 0x01 : 0x00;
    block.writeUInt16LE(length, 1);
    block.writeUInt16LE((~length) & 0xffff, 3);
    chunks.push(block, bytes.subarray(offset, offset + length));
    offset += length;
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(bytes), 0);
  trailer.writeUInt32LE(bytes.length >>> 0, 4);
  chunks.push(trailer);
  return Buffer.concat(chunks);
}

function octalField(value, width, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`Valor TAR inválido: ${label}`);
  const text = value.toString(8).padStart(width - 1, '0') + '\0';
  if (text.length !== width) fail(`Campo TAR fuera de rango: ${label}`);
  return Buffer.from(text, 'ascii');
}

function verifyManifest(files) {
  const manifest = files.get('MANIFEST.sha256');
  if (!manifest) fail('Falta MANIFEST.sha256.');
  const rows = manifest.toString('utf8').replace(/\r/g, '').trimEnd().split('\n');
  if (rows.length !== manifestMembers.length) fail('MANIFEST.sha256 no cubre el allowlist esperado.');
  const found = new Map();
  for (const row of rows) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(row);
    if (!match || !manifestMembers.includes(match[2]) || found.has(match[2])) fail('MANIFEST.sha256 contiene una fila inválida.');
    found.set(match[2], match[1]);
  }
  for (const name of manifestMembers) {
    const bytes = files.get(name);
    if (!bytes || sha256(bytes) !== found.get(name)) fail(`SHA-256 de payload incorrecto: ${name}`);
  }
}

function createTar(files) {
  if (!(files instanceof Map) || files.size !== members.length || members.some(name => !Buffer.isBuffer(files.get(name)))) {
    fail('El TAR debe contener exclusivamente los tres recursos allowlist.');
  }
  verifyManifest(files);
  const chunks = [];
  for (const name of members) {
    const nameBytes = Buffer.from(name, 'ascii');
    if (!nameBytes.length || nameBytes.length > 100 || nameBytes.toString('ascii') !== name || name.includes('..')) fail('Nombre TAR no permitido.');
    const data = files.get(name);
    const header = Buffer.alloc(blockSize, 0);
    nameBytes.copy(header, 0);
    octalField(0o644, 8, 'mode').copy(header, 100);
    octalField(0, 8, 'uid').copy(header, 108);
    octalField(0, 8, 'gid').copy(header, 116);
    octalField(data.length, 12, 'size').copy(header, 124);
    octalField(0, 12, 'mtime').copy(header, 136);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    Buffer.from('ustar\0', 'ascii').copy(header, 257);
    Buffer.from('00', 'ascii').copy(header, 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const checksumText = checksum.toString(8).padStart(6, '0') + '\0 ';
    if (checksumText.length !== 8) fail('Checksum TAR fuera de rango.');
    Buffer.from(checksumText, 'ascii').copy(header, 148);
    chunks.push(header, data);
    const remainder = data.length % blockSize;
    if (remainder) chunks.push(Buffer.alloc(blockSize - remainder, 0));
  }
  chunks.push(Buffer.alloc(blockSize * 2, 0));
  const compressed = deterministicGzip(Buffer.concat(chunks));
  if (compressed.length < 10 || compressed[0] !== 0x1f || compressed[1] !== 0x8b || compressed.subarray(4, 8).some(byte => byte !== 0)) {
    fail('El encabezado gzip no tiene timestamp cero.');
  }
  return compressed;
}

function readTar(bytes) {
  const tar = zlib.gunzipSync(bytes);
  const files = new Map();
  let offset = 0;
  while (offset + blockSize <= tar.length) {
    const header = tar.subarray(offset, offset + blockSize);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('ascii').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText, 8);
    if (!members.includes(name) || files.has(name) || !Number.isSafeInteger(size) || size < 0 || (header[156] !== 0 && header[156] !== 0x30)) fail('El TAR de regresión no es válido.');
    const start = offset + blockSize, end = start + size;
    if (end > tar.length) fail('El TAR está truncado.');
    files.set(name, Buffer.from(tar.subarray(start, end)));
    offset = start + Math.ceil(size / blockSize) * blockSize;
  }
  if (files.size !== members.length || members.some(name => !files.has(name))) fail('El TAR no contiene exactamente el allowlist.');
  verifyManifest(files);
  return files;
}

function sourceFiles(root) {
  const resolved = path.resolve(root);
  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  const names = entries.map(entry => entry.name).sort();
  if (names.join('\n') !== [...members].sort().join('\n')) fail('El staging local contiene archivos adicionales o faltantes.');
  const files = new Map();
  for (const name of members) {
    const full = path.join(resolved, name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`Recurso de payload no regular: ${name}`);
    files.set(name, fs.readFileSync(full));
  }
  return files;
}

function selfTest() {
  const dockerfile = Buffer.from('FROM ${FRONTEND_BASE}\nCOPY --from=patcher /tmp/site /usr/share/nginx/html\n', 'utf8');
  const transformer = Buffer.from("'use strict';\nprocess.stdout.write('fixture');\n", 'utf8');
  const manifest = Buffer.from(`${sha256(dockerfile)}  Dockerfile.frontend\n${sha256(transformer)}  apply-connected-charge-fix.cjs\n`, 'utf8');
  const fixture = new Map([
    ['Dockerfile.frontend', dockerfile],
    ['MANIFEST.sha256', manifest],
    ['apply-connected-charge-fix.cjs', transformer]
  ]);
  const first = createTar(fixture);
  const second = createTar(fixture);
  const firstHash = sha256(first), secondHash = sha256(second);
  if (!first.equals(second) || firstHash !== secondHash) fail('SelfTest: dos generaciones del TAR no son idénticas.');
  const extracted = readTar(first);
  for (const name of members) if (!extracted.get(name).equals(fixture.get(name))) fail(`SelfTest: cambió el miembro ${name}.`);
  process.stdout.write(`REPRODUCIBLE_TAR=PASS\nTAR_GENERATIONS_IDENTICAL=PASS\nGZIP_MTIME_ZERO=PASS\nTAR_ALLOWLIST=PASS\nTAR_SHA256=${firstHash}\n`);
}

const mode = process.argv[2];
if (mode === '--self-test' && process.argv.length === 3) selfTest();
else if (mode === '--create' && process.argv.length === 5) {
  const root = process.argv[3], output = path.resolve(process.argv[4]);
  const files = sourceFiles(root);
  if (members.some(name => path.resolve(root, name) === output)) fail('El archivo TAR no puede reemplazar un miembro del payload.');
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) fail('No se acepta una salida TAR simbólica.');
  const archive = createTar(files);
  fs.writeFileSync(output, archive, { mode: 0o600 });
  process.stdout.write(`ARCHIVE_SHA256=${sha256(archive)}\n`);
} else fail('Uso: --self-test o --create <payload-root> <output.tar.gz>.');
