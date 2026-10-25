'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, 'vendor', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

for (const [relativePath, expectedHash] of Object.entries(manifest.sha256)) {
  const filePath = path.resolve(root, relativePath);
  assert.ok(filePath.startsWith(path.join(root, 'vendor') + path.sep), `Ruta fuera de vendor/: ${relativePath}`);
  assert.ok(existsSync(filePath), `Falta el archivo vendorizado: ${relativePath}`);
  const actualHash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
  assert.equal(actualHash, expectedHash, `SHA-256 inesperado: ${relativePath}`);
}

const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const css = readFileSync(path.join(root, 'styles.css'), 'utf8');
const assetReferences = [
  ...[...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => match[1]),
  ...[...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/gi)].map(match => match[1]),
  ...[...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map(match => match[1]),
  ...[...css.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/gi)].map(match => match[1])
];

for (const reference of assetReferences) {
  assert.ok(!/^(?:https?:)?\/\//i.test(reference), `Recurso externo en el frontend: ${reference}`);
  if (/^(?:data:|#)/i.test(reference)) continue;
  const localPath = reference.split(/[?#]/, 1)[0];
  assert.ok(existsSync(path.resolve(root, localPath)), `No existe el recurso local: ${reference}`);
}

for (const oldEndpoint of ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com']) {
  assert.ok(!html.includes(oldEndpoint) && !css.includes(oldEndpoint), `Quedó una referencia a ${oldEndpoint}`);
}

console.log(`Recursos locales verificados: ${Object.keys(manifest.sha256).length} hashes y ${assetReferences.length} referencias HTML/CSS.`);
