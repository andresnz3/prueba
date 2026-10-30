'use strict';
const { mkdirSync, copyFileSync, readdirSync, rmSync, readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { resolve, join } = require('node:path');
const { createHash } = require('node:crypto');
const root = resolve(__dirname, '..');
const output = join(root, 'dist');
const check = spawnSync(process.execPath, [join(__dirname, 'check-vendored-assets.cjs')], { stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status || 1);
const publicFiles = ['index.html', 'app.js', 'local-auth.js', 'local-license-config.js', 'local-license.js', 'data-tables.js', 'styles.css', 'icons.js', '404.html', 'offline.html', 'manifest.webmanifest', 'pwa.js', 'api-config.js', 'api-client.js', 'connected-auth.js', 'connected-inventory.js', 'validation.js', 'connected-sales.js', 'connected-clients.js', 'connected-expenses.js', 'connected-purchases.js', 'connected-reports.js', 'dashboard-period.js', 'period-filters.js', 'connected-dashboard.js', 'local-cash-flow.js', 'local-migration-preview.js', 'local-migration-export.js', 'connected-migration-history.js'];
const publicDirectories = ['vendor', 'assets/pwa'];
mkdirSync(output, { recursive: true });
// Destino absoluto y fijo dentro del repositorio: solo se limpia dist.
for (const entry of readdirSync(output)) rmSync(join(output, entry), { recursive: true, force: true });
for (const file of publicFiles) copyFileSync(join(root, file), join(output, file));
function copyPublicDirectory(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) copyPublicDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) copyFileSync(sourcePath, destinationPath);
  }
}
for (const directory of publicDirectories) copyPublicDirectory(join(root, directory), join(output, directory));
const cacheableExtensions = new Set(['.html', '.css', '.js', '.svg', '.png', '.ico', '.woff2', '.webmanifest']);
const precachePaths = [];
function collectStaticFiles(directory, relative = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const diskPath = join(directory, entry.name);
    const urlPath = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) collectStaticFiles(diskPath, urlPath);
    else if (entry.isFile() && urlPath !== 'service-worker.js' && cacheableExtensions.has(require('node:path').extname(entry.name).toLowerCase())) {
      precachePaths.push('/' + urlPath.replace(/\\/g, '/'));
    }
  }
}
collectStaticFiles(output);
precachePaths.sort();
const template = readFileSync(join(root, 'service-worker.js'), 'utf8');
const revisionHash = createHash('sha256');
revisionHash.update(template);
for (const path of precachePaths) {
  revisionHash.update(path);
  revisionHash.update(readFileSync(join(output, path.slice(1))));
}
const revision = revisionHash.digest('hex').slice(0, 16);
const worker = template
  .replace('__POS_CACHE_NAME__', 'pos-pwa-shell-' + revision)
  .replace('__POS_PRECACHE_URLS__', JSON.stringify(precachePaths));
if (worker.includes('__POS_CACHE_NAME__') || worker.includes('__POS_PRECACHE_URLS__')) throw new Error('La plantilla de uso sin conexión no se pudo preparar.');
writeFileSync(join(output, 'service-worker.js'), worker, 'utf8');
console.log('dist preparado: solo archivos publicos del POS');
