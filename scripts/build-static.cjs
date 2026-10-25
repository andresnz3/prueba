'use strict';
const { mkdirSync, copyFileSync, readdirSync, rmSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { resolve, join } = require('node:path');
const root = resolve(__dirname, '..');
const output = join(root, 'dist');
const check = spawnSync(process.execPath, [join(__dirname, 'check-vendored-assets.cjs')], { stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status || 1);
const publicFiles = ['index.html', 'app.js', 'data-tables.js', 'styles.css', 'icons.js', '404.html', 'api-config.js', 'api-client.js', 'connected-auth.js', 'connected-inventory.js', 'validation.js', 'connected-sales.js', 'connected-clients.js', 'connected-expenses.js', 'connected-purchases.js', 'connected-reports.js', 'dashboard-period.js', 'period-filters.js', 'connected-dashboard.js', 'local-cash-flow.js', 'local-migration-preview.js', 'local-migration-export.js', 'connected-migration-history.js'];
const publicDirectories = ['vendor'];
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
console.log('dist preparado: solo archivos publicos del POS');
