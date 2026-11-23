'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mode = process.argv[2];
const root = path.resolve(process.argv[3] || '');
const patchFile = path.resolve(process.argv[4] || '');
const packageSha = process.argv[5] || '';
const iconsDir = process.argv[6] ? path.resolve(process.argv[6]) : '';
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
        die('Published base mismatch in ' + relative + ' (old=' + oldCount + ', new=' + newCount + ', context=' + oldRows[0].slice(0, 100) + ').');
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
const iconFiles = [
  'softventaweb-favicon-20261106-16.png',
  'softventaweb-favicon-20261106-32.png',
  'softventaweb-favicon-20261106-48.png',
  'softventaweb-favicon-20261106.svg',
  'softventaweb-touch-20261106-192.png',
  'softventaweb-pwa-20261106-512.png'
];
function installFaviconAssets() {
  if (!iconsDir) die('Missing favicon asset directory.');
  const iconDirectoryStat = fs.lstatSync(iconsDir);
  if (!iconDirectoryStat.isDirectory() || iconDirectoryStat.isSymbolicLink()) die('Missing favicon asset directory.');
  const destination = path.join(root, 'assets', 'pwa');
  const destinationStat = fs.lstatSync(destination);
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) die('Missing published PWA asset directory.');
  let changed = 0;
  for (const name of iconFiles) {
    const source = path.join(iconsDir, name);
    const target = path.join(destination, name);
    const sourceStat = fs.lstatSync(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) die('Missing allowlisted favicon asset: ' + name);
    let targetStat;
    try { targetStat = fs.lstatSync(target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (targetStat) {
      if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1 ||
          !fs.readFileSync(target).equals(fs.readFileSync(source))) {
        die('Versioned favicon path exists with different content: ' + name);
      }
    } else {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      changed++;
    }
    // The remote helper extracts the tar under umask 077 with --no-same-permissions.
    // That makes archive mode 0666 become 0600; the Nginx worker cannot read mode 0600.
    fs.chmodSync(target, 0o644);
    targetStat = fs.lstatSync(target);
    const targetMode = targetStat.mode & 0o777;
    const readableModeValid = process.platform === 'win32'
      ? (targetMode & 0o444) === 0o444
      : targetMode === 0o644;
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.nlink !== 1 ||
        !readableModeValid) {
      die('Allowlisted favicon is not a regular 0644-readable file: ' + name);
    }
  }
  return changed;
}
function withFaviconLinks(html, relative) {
  const titlePattern = relative === 'index.html'
    ? /<title>\s*SoftVentaWeb\s*<\/title>/i
    : /<title>\s*SoftVentaWeb[^<]*<\/title>/i;
  if (!titlePattern.test(html)) die('SoftVentaWeb title missing in ' + relative + '.');
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  if (!head || (html.match(/<head\b/gi) || []).length !== 1) die('Unique head not found in ' + relative + '.');
  const tags = [
    '<link rel="icon" href="/assets/pwa/softventaweb-favicon-20261106-16.png" type="image/png" sizes="16x16">',
    '<link rel="icon" href="/assets/pwa/softventaweb-favicon-20261106-32.png" type="image/png" sizes="32x32">',
    '<link rel="icon" href="/assets/pwa/softventaweb-favicon-20261106-48.png" type="image/png" sizes="48x48">',
    '<link rel="shortcut icon" href="/assets/pwa/softventaweb-favicon-20261106-32.png" type="image/png" sizes="32x32">',
    '<link rel="icon" href="/assets/pwa/softventaweb-favicon-20261106.svg" type="image/svg+xml" sizes="any">',
    '<link rel="apple-touch-icon" href="/assets/pwa/softventaweb-touch-20261106-192.png" sizes="192x192" type="image/png">'
  ];
  const withoutOldIcons = head[1].replace(/<link\b[^>]*>/gi, tag => {
    const rel = /\brel=["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase().split(/\s+/) || [];
    return rel.includes('icon') || rel.includes('shortcut') || rel.includes('apple-touch-icon') ? '' : tag;
  });
  const normalized = withoutOldIcons.replace(/[ \t\r\n]+$/g, '');
  const headStart = head[0].slice(0, head[0].indexOf('>') + 1);
  const nextHead = headStart + normalized + '\n    ' + tags.join('\n    ') + '\n</head>';
  return html.slice(0, head.index) + nextHead + html.slice(head.index + head[0].length);
}
function withManifestCacheBust(html) {
  let found = 0;
  const next = html.replace(/<link\b[^>]*>/gi, tag => {
    const rel = /\brel=["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase().split(/\s+/) || [];
    if (!rel.includes('manifest')) return tag;
    found++;
    if (!/\bhref=["'][^"']*["']/i.test(tag)) die('Manifest link has no href.');
    return tag.replace(/\bhref=(["'])[^"']*\1/i, 'href="/manifest.webmanifest?v=20261106"');
  });
  if (found !== 1) die('POS page must have one manifest link.');
  return next;
}
function updateManifest() {
  const file = path.join(root, 'manifest.webmanifest');
  let manifest;
  try { manifest = JSON.parse(readText(file)); } catch { die('PWA manifest is invalid JSON.'); }
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) die('PWA manifest name is missing.');
  if (!Array.isArray(manifest.icons)) die('PWA manifest has no icons.');
  let found192 = 0, found512 = 0;
  for (const icon of manifest.icons) {
    if (icon.sizes === '192x192') { icon.src = '/assets/pwa/softventaweb-touch-20261106-192.png'; found192++; }
    if (icon.sizes === '512x512') { icon.src = '/assets/pwa/softventaweb-pwa-20261106-512.png'; found512++; }
  }
  if (found192 !== 1 || found512 !== 1) die('Manifest must have unique 192x192 and 512x512 icons.');
  const output = JSON.stringify(manifest, null, 2) + '\n';
  if (output.replace(/\r\n/g, '\n') !== readText(file).replace(/\r\n/g, '\n')) writeAtomic(file, output);
}
function updateServiceWorker() {
  const file = path.join(root, 'service-worker.js');
  let worker = readText(file);
  const cacheMatch = /^const CACHE_NAME = '([^']+)';$/m.exec(worker);
  const prefixMatch = /^const CACHE_PREFIX = '([^']+)';$/m.exec(worker);
  const precacheMatch = /^const PRECACHE_URLS = (.+);$/m.exec(worker);
  if (!cacheMatch || !prefixMatch || prefixMatch[1] !== 'pos-pwa-shell-' || !precacheMatch) die('Unknown service-worker format.');
  let precache;
  try { precache = JSON.parse(precacheMatch[1]); } catch { die('Service-worker precache is invalid JSON.'); }
  if (!Array.isArray(precache)) die('Service-worker precache is not an array.');
  const required = iconFiles.map(name => '/assets/pwa/' + name).concat('/manifest.webmanifest?v=20261106');
  const nextPrecache = [...new Set([...precache, ...required])].sort();
  const nextPrecacheLine = 'const PRECACHE_URLS = ' + JSON.stringify(nextPrecache) + ';';
  if (precacheMatch[0] !== nextPrecacheLine) worker = replaceUnique(worker, precacheMatch[0], nextPrecacheLine, 'precache list');
  const nextCacheName = "const CACHE_NAME = 'pos-pwa-shell-billing-favicon-" + packageSha.slice(0, 16) + "';";
  if (cacheMatch[0] !== nextCacheName) worker = replaceUnique(worker, cacheMatch[0], nextCacheName, 'service-worker cache version');
  if (worker !== readText(file)) writeAtomic(file, worker);
}
function patchFavicon() {
  const copied = installFaviconAssets();
  let changedPages = 0;
  for (const relative of ['index.html', 'inicio/index.html']) {
    const file = path.join(root, ...relative.split('/'));
    const original = readText(file);
    let next = withFaviconLinks(original, relative);
    if (relative === 'index.html') next = withManifestCacheBust(next);
    if (next.replace(/\r\n/g, '\n') !== original.replace(/\r\n/g, '\n')) { writeAtomic(file, next); changedPages++; }
  }
  updateManifest();
  updateServiceWorker();
  const index = readText(path.join(root, 'index.html'));
  if (!index.includes('rel="manifest"')) die('POS page does not link the PWA manifest.');
  for (const name of iconFiles) if (!fs.existsSync(path.join(root, 'assets', 'pwa', name))) die('Favicon asset missing after installation: ' + name);
  return { copied, changedPages };
}
function patchFrontend() {
  const changedCode = applyUnifiedPatch(patchFile);
  const appPath = path.join(root, 'app.js');
  const appText = readText(appPath).replace(/\r\n/g, '\n');
  const searchFilter = 'if (!matchesSearch(v)) return;';
  const filterMarker = '            const medioPago = mediosPagoVenta[obtenerMedioPagoVenta(v)] || "Efectivo";';
  const listenerToken = "document.getElementById('historyInvoiceSearch')?.addEventListener('input'";
  const listenerMarker = 'function actualizarTablaAuditoria()';
  const insertBeforeUnique = (text, marker, insertion, token, label) => {
    const tokenCount = countOccurrences(text, token);
    if (tokenCount === 1) return text;
    if (tokenCount !== 0 || countOccurrences(text, marker) !== 1) die('Missing unique insertion point for ' + label + '.');
    const at = text.indexOf(marker);
    return text.slice(0, at) + insertion + text.slice(at);
  };
  let appNext = insertBeforeUnique(appText, filterMarker, '            ' + searchFilter + '\n', searchFilter, 'el filtro del historial');
  appNext = insertBeforeUnique(appNext, listenerMarker,
    "document.getElementById('historyInvoiceSearch')?.addEventListener('input', () => {\n    if (connectedMode) window.PosSales?.searchHistory();\n    else actualizarTablaHistorial();\n});\n\n",
    listenerToken, 'history search event');
  const appChanged = appNext !== appText;
  if (appChanged) writeAtomic(appPath, appNext);
  const connectedPath = path.join(root, 'connected-sales.js');
  const connectedText = readText(connectedPath).replace(/\r\n/g, '\n');
  const replaceOnce = (source, oldText, newText, label) => {
    const oldCount = countOccurrences(source, oldText), newCount = countOccurrences(source, newText);
    if (oldCount === 1 && newCount === 0) return source.replace(oldText, newText);
    if (oldCount === 0 && newCount === 1) return source;
    die('Published connected sales context differs at ' + label + '.');
  };
  const insertAfterUnique = (source, marker, insertion, token, label) => {
    const tokenCount = countOccurrences(source, token);
    if (tokenCount === 1) return source;
    if (tokenCount !== 0 || countOccurrences(source, marker) !== 1) die('Missing unique insertion point for ' + label + '.');
    const at = source.indexOf(marker) + marker.length;
    return source.slice(0, at) + insertion + source.slice(at);
  };
  let connectedNext = replaceOnce(connectedText,
    'historyLoadFlight = null, historyLoadDirty = false;',
    'historyLoadFlight = null, historyLoadDirty = false, historySearchRequest = 0, historySearchTimer = null;',
    'history search state');
  const mappedMarker = "const credit = sale.paymentMethod === 'CREDIT';";
  const mappedToken = "const rawDetail = typeof sale.detail === 'string' ? sale.detail : '';";
  const mappedInsert = "\n    " + mappedToken + "\n    const historyMarker = sale.isHistorical && rawDetail.startsWith('Factura local:') ? rawDetail.indexOf(' ' + '\\u00b7' + ' ') : -1;\n    let customerDetail = rawDetail;\n    if (sale.isHistorical && rawDetail.startsWith('Factura local:')) customerDetail = historyMarker < 0 ? '' : rawDetail.slice(historyMarker + 3);";
  connectedNext = insertAfterUnique(connectedNext, mappedMarker, mappedInsert, mappedToken, 'mapped sale detail');
  connectedNext = replaceOnce(connectedNext, "detalle: sale.detail || '-', metodo:", "detalle: sale.detail || '-', detalleCliente: customerDetail, metodo:", 'mapped sale detail field');
  connectedNext = replaceOnce(connectedNext, 'async function pages(method)', "async function pages(method, query = '')", 'sales pagination query');
  connectedNext = replaceOnce(connectedNext, 'client[method](offset, maxId)', 'client[method](offset, maxId, query)', 'sales API query forwarding');
  const historyLoadMarker = 'window.PosRuntime.setSales(rows);';
  const historyLoadToken = 'if (historySearchQuery()) await applyHistorySearch(historySearchQuery());';
  connectedNext = insertAfterUnique(connectedNext, historyLoadMarker,
    '\n    clearTimeout(historySearchTimer);\n    if (historySearchQuery()) await applyHistorySearch(historySearchQuery());\n    else window.PosRuntime.clearSalesSearchResults();',
    historyLoadToken, 'history search refresh');
  const connectedChanged = connectedNext !== connectedText;
  if (connectedChanged) writeAtomic(connectedPath, connectedNext);
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
  if (!/<title>\s*SoftVentaWeb[^<]*<\/title>/i.test(landing)) die('SoftVentaWeb title missing in landing.');
  validateIconLinks(landing, '/inicio/', false);

  const workerPath = path.join(root, 'service-worker.js');
  let worker = readText(workerPath);
  const cacheMatch = /^const CACHE_NAME = '([^']+)';$/m.exec(worker);
  const prefixMatch = /^const CACHE_PREFIX = '([^']+)';$/m.exec(worker);
  if (!cacheMatch || !prefixMatch || prefixMatch[1] !== 'pos-pwa-shell-') die('Formato del service worker no reconocido.');
  const cacheName = cacheMatch[1];
  let workerChanged = 0;
  if (changedCode + htmlChanged > 0) {
    const newCacheName = 'pos-pwa-shell-billing-favicon-' + packageSha.slice(0, 16);
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
  for (const name of ['app.js', 'connected-sales.js', 'api-client.js']) {
    const checked = spawnSync(process.execPath, ['--check', path.join(root, name)], { encoding: 'utf8' });
    if (checked.status !== 0) die('Frontend JavaScript syntax failed in ' + name + '.');
  }
  for (const [name, needle] of checks) if (!readText(path.join(root, name)).includes(needle)) die('Falta la implementación de búsqueda en ' + name + '.');
  const totalChanged = changedCode + Number(appChanged) + Number(connectedChanged) + htmlChanged + workerChanged;
  process.stdout.write('FRONTEND_PATCH=' + (totalChanged ? 'CHANGED' : 'ALREADY_PRESENT') + '\n');
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
function frontFileState(name) {
  const file = path.join(root, ...name.split('/'));
  try {
    const stat = fs.lstatSync(file);
    const regular = stat.isFile() && !stat.isSymbolicLink();
    return { kind: regular ? 'file' : 'other', mode: stat.mode & 0o777, data: regular ? fs.readFileSync(file) : null };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function frontFileChanged(before, name) {
  const after = frontFileState(name);
  if (before === null || after === null) return before !== after;
  return before.kind !== after.kind || before.mode !== after.mode ||
    (before.data !== null && after.data !== null && !before.data.equals(after.data));
}
if (mode === 'frontend') {
  const trackedFrontendFiles = ['app.js', 'connected-sales.js', 'api-client.js', 'index.html', 'inicio/index.html',
    'manifest.webmanifest', 'service-worker.js', ...iconFiles.map(name => 'assets/pwa/' + name)];
  const before = new Map(trackedFrontendFiles.map(name => [name, frontFileState(name)]));
  const favicon = patchFavicon();
  patchFrontend();
  const changedFiles = trackedFrontendFiles.filter(name => frontFileChanged(before.get(name), name));
  process.stdout.write('FRONTEND_FILES_TOUCHED=' + changedFiles.join(';') + '\n');
  process.stdout.write('FAVICON_ASSETS=' + (favicon.copied ? 'COPIED' : 'ALREADY_PRESENT') + '\n');
  process.stdout.write('FAVICON_PAGES=' + (favicon.changedPages ? 'UPDATED' : 'ALREADY_PRESENT') + '\n');
} else patchBackend();
