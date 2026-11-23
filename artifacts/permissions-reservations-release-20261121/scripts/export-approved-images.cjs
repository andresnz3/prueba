'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createReadStream, createWriteStream } = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { createGzip } = require('node:zlib');
const { pipeline } = require('node:stream/promises');

const root = path.resolve(__dirname, '..');
const expectedImages = new Map([
  ['sv-softventa-frontend:permisos-reservas-20261121-c4a98ed1', 'sha256:f599b0995c00086ffb0393d020f1e51d180e8f69cab728d8588a80dd427b4288'],
  ['sv-softventa-backend:permisos-reservas-20261121-c4a98ed1', 'sha256:8858869b8d884bdd1a8397de93d07666055c6afaf5f5fde3e97d689b6ed2c819']
]);

async function sha256(filename) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

async function main() {
  const output = path.resolve(root, 'images', 'softventa-permissions-reservations-images.tar.gz');
  assert.equal(path.relative(root, output).startsWith('..'), false, 'archive must stay inside this release package');
  if (fs.existsSync(output)) throw new Error('Refusing to overwrite an existing image archive');
  for (const [tag, expected] of expectedImages) {
    const actual = execFileSync('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
    assert.equal(actual, expected, 'Approved image ID mismatch for ' + tag);
  }
  let fileCreated = false;
  try {
    const child = spawn('docker', ['image', 'save', ...expectedImages.keys()], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    const sink = createWriteStream(output, { flags: 'wx', mode: 0o600 });
    fileCreated = true;
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve() : reject(new Error('docker image save exited with status ' + code)));
    });
    await Promise.all([pipeline(child.stdout, createGzip({ level: 6 }), sink), exited]);
    const bytes = fs.statSync(output).size;
    process.stdout.write(JSON.stringify({ file: path.relative(root, output), bytes, sha256: await sha256(output), images: [...expectedImages].map(([tag, imageId]) => ({ tag, imageId })) }) + '\n');
  } catch (error) {
    if (fileCreated && fs.existsSync(output)) fs.unlinkSync(output);
    throw error;
  }
}

main().catch(error => { process.stderr.write('Image export stopped: ' + error.message + '\n'); process.exitCode = 1; });
