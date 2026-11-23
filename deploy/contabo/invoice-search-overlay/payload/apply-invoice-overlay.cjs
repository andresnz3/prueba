'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mode = process.argv[2];
const root = path.resolve(process.argv[3] || '');
const patchFile = path.resolve(process.argv[4] || '');
const packageSha = process.argv[5] || '';
if (!['frontend', 'backend'].includes(mode) || !root || !patchFile || !/^[a-f0-9]{64}$/.test(packageSha)) {
  throw new Error('Uso interno inválido del overlay.');
}
function die(message) { throw new Error(message); }
function readText(file) { return fs.readFileSync(file, 'utf8'); }
function writeAtomic(file, text) {
  const stat = fs.statSync(file);
  const original = readText(file);
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const normalized = text.replace(/\r\n/g, '\n');
  const output = newline === '\n' ? normalized : normalized.replace(/\n/g, newline);
  const temp = file + '.invoice-' + process.pid + '.tmp';
  fs.writeFileSync(temp, output, { mode: stat.mode & 0o777 });
  fs.renameSync(temp, file);
}
function countOccurrences(source, needle) {
  if (!needle) return 0;
  let count = 0, at = -1;
  while ((at = source.indexOf(needle, at + 1)) !== -1) count++;
  return count;
}
function occurrencesAtLineBoundaries(source, needle) {
  let count = 0, at = -1;
  while ((at = source.indexOf(needle, at + 1)) !== -1) {
    const before = at === 0 || source[at - 1] === '\n';
    const end = at + needle.length;
    const after = end === source.length || source[end] === '\n';
    if (before && after) count++;
  }
  return count;
}
function applyUnifiedPatch(patchPath) {
  const lines = readText(patchPath).replace(/\r\n/g, '\n').split('\n');
  let i = 0, changed = 0;
  const allowed = mode === 'frontend'
    ? new Set(['app.js', 'connected-sales.js', 'api-client.js'])
    : new Set(['backend/src/routes/sales.js', 'backend/src/services/sales.js']);
  while (i < lines.length) {
    if (!lines[i].startsWith('diff --git ')) { i++; continue; }
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[i]);
    if (!match || match[1] !== match[2] || !allowed.has(match[1])) die('El parche intenta tocar una ruta fuera del allowlist.');
    const relative = match[1];
    const file = path.join(root, ...relative.split('/'));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) die('Falta un archivo base requerido: ' + relative);
    let text = readText(file).replace(/\r\n/g, '\n');
    let fileChanged = 0;
    i++;
    while (i < lines.length && !lines[i].startsWith('diff --git ')) {
      if (!lines[i].startsWith('@@ ')) { i++; continue; }
      i++;
      const oldRows = [], newRows = [];
      while (i < lines.length && !lines[i].startsWith('@@ ') && !lines[i].startsWith('diff --git ')) {
        const line = lines[i++];
        if (line.startsWith('\\')) continue;
        if (line.startsWith(' ')) { oldRows.push(line.slice(1)); newRows.push(line.slice(1)); }
        else if (line.startsWith('-')) oldRows.push(line.slice(1));
        else if (line.startsWith('+')) newRows.push(line.slice(1));
        else if (line === '') continue;
        else die('Formato de parche inesperado en ' + relative + '.');
      }
      const oldText = oldRows.join('\n');
      const newText = newRows.join('\n');
      const oldCount = occurrencesAtLineBoundaries(text, oldText);
      const newCount = occurrencesAtLineBoundaries(text, newText);
      if (oldCount === 1 && newCount === 0) {
        const at = text.indexOf(oldText);
        text = text.slice(0, at) + newText + text.slice(at + oldText.length);
        changed++;
        fileChanged++;
      } else if (oldCount === 0 && newCount === 1) {
        // Esta hunk ya está publicada; no volver a aplicarla.
      } else {
        die('La base publicada difiere en ' + relative + '; el overlay no se aplicó.');
      }
    }
    if (fileChanged > 0) writeAtomic(file, text);
  }
  return changed;
}
function replaceUnique(source, oldText, newText, label) {
  const count = countOccurrences(source, oldText);
  if (count !== 1) die('No se encontró una única ubicación de ' + label + '.');
  return source.replace(oldText, newText);
}
function patchFrontend() {
  const changedCode = applyUnifiedPatch(patchFile);
  const indexPath = path.join(root, 'index.html');
  let index = readText(indexPath);
  const start = '<!-- SOFTVENTA_INVOICE_SEARCH_START -->';
  const end = '<!-- SOFTVENTA_INVOICE_SEARCH_END -->';
  const markup = [
    start,
    '<div class="form-group" style="max-width: 420px; margin-bottom: 12px;">',
    '    <label for="historyInvoiceSearch">Buscar facturas por número, detalle o nombre del cliente</label>',
    '    <input id="historyInvoiceSearch" type="search" maxlength="100" autocomplete="off" placeholder="Número, detalle o nombre del cliente">',
    '</div>',
    end
  ].join('\n');
  let htmlChanged = 0;
  if (index.includes(start) || index.includes(end)) {
    if (countOccurrences(index, start) !== 1 || countOccurrences(index, end) !== 1 ||
        !index.includes('id="historyInvoiceSearch"') ||
        !index.includes('Buscar facturas por número, detalle o nombre del cliente')) {
      die('El campo de búsqueda publicado no coincide con el formato esperado.');
    }
  } else if (index.includes('id="historyInvoiceSearch"')) {
    if (countOccurrences(index, 'id="historyInvoiceSearch"') !== 1 ||
        !index.includes('Buscar facturas por número, detalle o nombre del cliente')) {
      die('Existe un buscador anterior, pero no coincide con el alcance esperado.');
    }
  } else {
    const anchor = '<p id="connectedHistoryStatus"';
    const at = index.indexOf(anchor);
    if (at < 0 || index.indexOf(anchor, at + 1) >= 0) die('No se encontró el ancla única del historial en index.html.');
    index = index.slice(0, at) + markup + '\n' + index.slice(at);
    writeAtomic(indexPath, index);
    htmlChanged = 1;
  }

  index = readText(indexPath);
  if (!/<title>\s*SoftVentaWeb\s*<\/title>/i.test(index)) die('El título SoftVentaWeb no está presente en la imagen activa.');
  if (!/softventaweb-logo\.webp/i.test(index)) die('No se encontró el logo oficial publicado.');
  for (const id of ['manageProductCategoriesBtn', 'productCategoriesModal', 'navSystemAdminBtn']) {
    if (!index.includes('id="' + id + '"')) die('Falta un elemento publicado que debe preservarse: ' + id);
  }

  function validateIconLinks(html, pagePath, needsManifest) {
    let hasIcon = false, hasManifest = false;
    const tags = html.match(/<link\b[^>]*>/gi) || [];
    for (const tag of tags) {
      const rel = /\brel=["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase().split(/\s+/) || [];
      const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1];
      if (rel.includes('icon') || rel.includes('apple-touch-icon')) hasIcon = true;
      if (rel.includes('manifest')) hasManifest = true;
      if (!href || !(rel.includes('icon') || rel.includes('apple-touch-icon') || rel.includes('manifest'))) continue;
      const url = new URL(href, 'https://softventa.invalid' + pagePath);
      if (url.origin !== 'https://softventa.invalid') continue;
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.split('/').includes('..') || !fs.existsSync(path.join(root, decoded.replace(/^\/+/, '')))) {
        die('Una ruta de icono publicada no existe: ' + href);
      }
      if (rel.includes('manifest')) {
        let manifest;
        try { manifest = JSON.parse(readText(path.join(root, decoded.replace(/^\/+/, '')))); }
        catch { die('El manifest publicado no es JSON válido.'); }
        for (const item of (Array.isArray(manifest.icons) ? manifest.icons : [])) {
          if (typeof item.src !== 'string') die('El manifest tiene un icono inválido.');
          const iconUrl = new URL(item.src, url);
          if (iconUrl.origin !== url.origin) continue;
          const iconPath = decodeURIComponent(iconUrl.pathname);
          if (iconPath.split('/').includes('..') || !fs.existsSync(path.join(root, iconPath.replace(/^\/+/, '')))) {
            die('El manifest apunta a un icono que no existe: ' + item.src);
          }
        }
      }
    }
    if (!hasIcon || (needsManifest && !hasManifest)) die('Falta el favicon o manifest publicado en ' + pagePath + '.');
  }
  validateIconLinks(index, '/', true);
  const landingPath = path.join(root, 'inicio', 'index.html');
  const landing = readText(landingPath);
  if (!/<title>\s*SoftVentaWeb\s*<\/title>/i.test(landing)) die('El título SoftVentaWeb no está presente en la landing.');
  validateIconLinks(landing, '/inicio/', false);

  const workerPath = path.join(root, 'service-worker.js');
  let worker = readText(workerPath);
  const cacheMatch = /^const CACHE_NAME = '([^']+)';$/m.exec(worker);
  const prefixMatch = /^const CACHE_PREFIX = '([^']+)';$/m.exec(worker);
  if (!cacheMatch || !prefixMatch || prefixMatch[1] !== 'pos-pwa-shell-') die('Formato del service worker no reconocido.');
  const cacheName = cacheMatch[1];
  let workerChanged = 0;
  if (changedCode + htmlChanged > 0) {
    const newCacheName = 'pos-pwa-shell-invoice-' + packageSha.slice(0, 16);
    if (cacheName !== newCacheName) {
      worker = replaceUnique(worker, cacheMatch[0], "const CACHE_NAME = '" + newCacheName + "';", 'la versión de caché');
      workerChanged++;
    }
  }
  const precacheMatch = /^const PRECACHE_URLS = (.+);$/m.exec(worker);
  if (!precacheMatch) die('No se pudo leer la lista de precache publicada.');
  let precache;
  try { precache = JSON.parse(precacheMatch[1]); } catch { die('La lista de precache publicada no es JSON válido.'); }
  if (!Array.isArray(precache)) die('La lista de precache no es una lista.');
  for (const item of ['/index.html', '/app.js', '/api-client.js', '/connected-sales.js']) {
    if (!precache.includes(item)) die('El precache publicado no incluye ' + item + '.');
  }
  if (workerChanged) writeAtomic(workerPath, worker);

  const checks = [
    ['app.js', 'historyInvoiceSearch'],
    ['connected-sales.js', 'searchHistory'],
    ['api-client.js', "q ? '&q='"]
  ];
  for (const [name, needle] of checks) if (!readText(path.join(root, name)).includes(needle)) die('Falta la implementación de búsqueda en ' + name + '.');
  const totalChanged = changedCode + htmlChanged + workerChanged;
  process.stdout.write('FRONTEND_PATCH=' + (totalChanged ? 'CHANGED' : 'ALREADY_PRESENT') + '\n');
  process.stdout.write('FRONTEND_FILES_TOUCHED=' + [changedCode ? 'app.js,connected-sales.js,api-client.js' : '', htmlChanged ? 'index.html' : '', workerChanged ? 'service-worker.js' : ''].filter(Boolean).join(';') + '\n');
}
function patchBackend() {
  const changed = applyUnifiedPatch(patchFile);
  const files = ['backend/src/routes/sales.js', 'backend/src/services/sales.js'];
  for (const relative of files) {
    const file = path.join(root, ...relative.split('/'));
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (checked.status !== 0) die('Error de sintaxis en ' + relative + '.');
  }
  const route = readText(path.join(root, 'backend/src/routes/sales.js'));
  const service = readText(path.join(root, 'backend/src/services/sales.js'));
  if (!route.includes('v.text(req.query.q, 100)') || !service.includes('s.business_id = ?') ||
      !service.includes('c.business_id = s.business_id') || !service.includes('options.maxId')) {
    die('No se conservaron validación, aislamiento de negocio o paginación de búsqueda.');
  }
  process.stdout.write('BACKEND_PATCH=' + (changed ? 'CHANGED' : 'ALREADY_PRESENT') + '\n');
}
if (mode === 'frontend') patchFrontend();
else patchBackend();
