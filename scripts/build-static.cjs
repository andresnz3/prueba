'use strict';
const { mkdirSync, copyFileSync, readdirSync, rmSync } = require('node:fs');
const { resolve, join } = require('node:path');
const root = resolve(__dirname, '..');
const output = join(root, 'dist');
const publicFiles = ['index.html', 'app.js', 'styles.css', 'icons.js', '404.html', 'api-config.js', 'api-client.js', 'connected-auth.js', 'connected-inventory.js', 'validation.js', 'connected-sales.js', 'connected-clients.js', 'local-cash-flow.js'];
mkdirSync(output, { recursive: true });
// Destino absoluto y fijo dentro del repositorio: solo se limpia dist.
for (const entry of readdirSync(output)) rmSync(join(output, entry), { recursive: true, force: true });
for (const file of publicFiles) copyFileSync(join(root, file), join(output, file));
console.log('dist preparado: solo archivos publicos del POS');
