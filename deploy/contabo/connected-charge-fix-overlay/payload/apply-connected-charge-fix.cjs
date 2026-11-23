'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILES = ['app.js', 'connected-sales.js', 'api-client.js', 'service-worker.js'];
const BASE_SHA256 = Object.freeze({
  'app.js': '5197bb68bd0fb47a255d1f777b7da29e81d6974dc3425f0073e13faf8614c91e',
  'connected-sales.js': 'b2f2b76f22aee4c68a74406926fc17202c52d40e58f373f3dd19190b6efa6384',
  'api-client.js': '1d5771a412b16caf938c36eb27818a5568b7cec6f3522689c979737bf2de4535',
  'service-worker.js': '4b6e7b4d0398d39548928dc0c06ff0702969ab506f60d22a97187f6f1f9f8525'
});
const HISTORY_MARKERS = ['SOFTVENTAWEB_HISTORY_DIAGNOSTICS_V1', '[SoftVentaWeb diagnostic]', 'diag=history', 'historyDiagnostic('];
const BASE_CACHE_NAME = "const CACHE_NAME = 'pos-pwa-shell-diag-f2150b94025e1a82';";
const appMethod = "    clearSaleDetail(value) { const input = document.getElementById('saleDetailInput'); if (input && input.value.trim() === String(value ?? '').trim()) input.value = ''; },";
const helperAnchor = '  // These explicit schema rejections roll back the transaction and never commit money.';
const paymentAnchor = '      if (value.payment) {';
const saleOrderCheck = "      if (value.sale && value.order && (value.kind !== 'SALE' || value.sale.status !== 'COMPLETED' || value.order.businessId !== this.#effectiveBusinessId() || !/^[1-9]\\d*$/.test(value.order.id || '') || value.order.status !== 'COMPLETED' || value.order.saleId !== value.sale.id)) throw new ApiError('INVALID_RESPONSE');\n";
const oldCharge = "async chargeOrder(id,data) { return this.#salesResult(await this.#write('/cash/orders/'+encodeURIComponent(id)+'/charge','POST',data)); }";
const newCharge = "async chargeOrder(id,data) { const value=this.#salesResult(await this.#write('/cash/orders/'+encodeURIComponent(id)+'/charge','POST',data)); if(value?.kind!=='SALE'||value.sale?.status!=='COMPLETED'||!value.order||value.order.id!==String(id)||value.order.businessId!==this.#effectiveBusinessId()||value.order.status!=='COMPLETED'||value.order.saleId!==value.sale.id) throw new ApiError('INVALID_RESPONSE'); return value; }";

function fail(message) { throw new Error(message); }
function count(text, token) { return text.split(token).length - 1; }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function verifyPublishedBaseline(files) {
  for (const name of FILES) {
    const actual = sha256(files.get(name));
    if (actual !== BASE_SHA256[name]) fail(`${name}: SHA-256 de imagen activa inesperado; esperado=${BASE_SHA256[name]} actual=${actual}`);
  }
}
function requireOnce(text, token, label) {
  const found = count(text, token);
  if (found !== 1) fail(`${label}: se esperaba una coincidencia exacta; encontradas=${found}`);
}
function newlineOf(text) { return text.includes('\r\n') ? '\r\n' : '\n'; }
function withNewline(text, newline) { return text.replace(/\r?\n/g, newline); }
function historySignature(sources) {
  const result = {};
  for (const [name, text] of sources) result[name] = text.split(/\r?\n/).filter(line => HISTORY_MARKERS.some(marker => line.includes(marker))).join('\n');
  return JSON.stringify(result);
}
function replaceRange(text, startToken, endToken, replacement, label) {
  requireOnce(text, startToken, `${label} inicio`);
  requireOnce(text, endToken, `${label} fin`);
  const start = text.indexOf(startToken), end = text.indexOf(endToken, start + startToken.length);
  if (end <= start) fail(`${label}: límites fuera de orden`);
  const newline = newlineOf(text);
  return text.slice(0, start) + withNewline(replacement, newline) + text.slice(end);
}
function transformApp(source) {
  const runtimeStart = source.indexOf('window.PosRuntime = Object.freeze({');
  const runtimeEnd = source.indexOf('\n});', runtimeStart);
  if (runtimeStart < 0 || runtimeEnd < 0) fail('app.js: no se reconoció la definición publicada de PosRuntime.');
  if (source.slice(runtimeStart, runtimeEnd).includes('clearSaleDetail(')) fail('app.js: clearSaleDetail ya existe dentro de PosRuntime; base inesperada.');
  const marker = '    // SOFTVENTAWEB_HISTORY_DIAGNOSTICS_V1:runtime';
  requireOnce(source, marker, 'app.js / marcador de diagnósticos publicado');
  const newline = newlineOf(source);
  return source.replace(marker, appMethod + newline + marker);
}

const helpers = `  function clearConfirmedSaleDetail(detail) {
    const input = el('saleDetailInput'), expected = String(detail ?? '').trim();
    if (!input || input.value.trim() !== expected) return;
    try {
      if (typeof window.PosRuntime?.clearSaleDetail === 'function') {
        window.PosRuntime.clearSaleDetail(detail);
        if (input.value.trim() !== expected) return;
      }
    } catch { /* The server has confirmed the sale; use the same-value fallback below. */ }
    if (input.value.trim() === expected) input.value = '';
  }
  const isConfirmedSale = result => result?.kind === 'SALE' && result.sale?.status === 'COMPLETED';
  function lockConfirmedSaleCheckout() {
    activeOrderId = null; quote = quoteInput = null;
    el('connectedCheckoutModal')?.classList.add('hidden');
  }
  async function completeCommittedResult(result, recovered = false) {
    const confirmedSale = isConfirmedSale(result);
    if (confirmedSale) lockConfirmedSaleCheckout();
    try { await completed(result, recovered); }
    catch {
      if (confirmedSale) {
        lockConfirmedSaleCheckout();
        clearConfirmedSaleDetail(result.sale.detail);
        try { window.PosRuntime.clearCart(); } catch { /* The server result remains authoritative. */ }
        await Promise.allSettled([load('cajaView'), loadHistory({ refresh: true })]);
        document.dispatchEvent(new Event('connected:report-data-changed'));
        showAlert('Cobro confirmado para la factura #' + result.sale.invoiceNumber + '. No se pudo actualizar el comprobante; consulta el Historial. No vuelvas a cobrar esta orden.');
        return;
      }
      showAlert('El servidor confirmo la operacion, pero la pantalla no termino de actualizarse. Comprueba su estado antes de volver a intentarlo.');
    }
  }
`;

const performFunction = `  async function performWithMarker(kind, data, action) {
    if (busy) return;
    if (pending()) { showPending(); showAlert('Comprueba la operacion pendiente antes de iniciar otra.'); return; }
    busy = true; const marker = { key: crypto.randomUUID(), kind }; const storage = scope();
    data.operationKey = marker.key;
    try { localStorage.setItem(storage, JSON.stringify(marker)); } catch { busy = false; showAlert('No se pudo guardar la referencia del cobro. Habilita el almacenamiento del navegador antes de cobrar. No se envio la operacion.'); return; }
    showPending();
    try {
      let result;
      try { result = await api(client => action(client, data)); }
      catch (error) {
        if (!uncertain(error)) { try { localStorage.removeItem(storage); } catch { /* Keep the operation blocked if storage cannot be updated. */ } }
        if (error.code === 'STALE_REQUEST') return;
        if (kind === 'ORDER_CHARGE' && error.code === 'ORDER_NOT_PENDING') {
          activeOrderId = null; quote = quoteInput = null;
          el('connectedCheckoutModal').classList.add('hidden');
          const refreshResults = await Promise.allSettled([load('cajaView'), loadHistory({ refresh: true })]);
          const refreshed = refreshResults.every(value => value.status === 'fulfilled');
          showAlert(refreshed
            ? 'La orden ya no esta pendiente. Caja e Historial se actualizaron; verifica si quedo cobrada o cancelada antes de continuar.'
            : 'La orden ya no esta pendiente y no se pudo completar la actualizacion de Caja e Historial. Verifica su estado antes de intentar otro cobro.');
          showPending();
          return;
        }
        if (uncertain(error)) {
          for (const id of ['connectedCheckoutModal','anularVentaModal','cierreCajaModal','purchaseModal','paymentInvoiceModal','statementModal','cancelConnectedPurchaseModal']) el(id).classList.add('hidden');
          notice('Resultado desconocido. Comprueba esta operacion antes de intentar cobrar nuevamente; podria estar confirmada.');
        }
        if (error.code === 'INVALID_SESSION') window.PosConnected.handleError(error);
        else {
          const safeMessage = window.PosMessages.fromError(error, 'No se pudo completar la operacion. Revisa su estado antes de volver a intentarlo.');
          if (['CASH_INVALID', 'CASH_INSUFFICIENT'].includes(error.code)) window.PosValidation.field('connectedCashReceived', safeMessage);
          showAlert(safeMessage + (uncertain(error) ? ' Comprueba el estado de la operacion antes de cobrar nuevamente.' : ''));
        }
        showPending();
        return;
      }
      if (isConfirmedSale(result)) lockConfirmedSaleCheckout();
      let markerRemoved = false;
      try { localStorage.removeItem(storage); markerRemoved = true; } catch { /* Keep the idempotency key available for recovery. */ }
      if (markerRemoved) notice(); else showPending();
      await completeCommittedResult(result);
    } finally { busy = false; }
  }
`;

const recoverFunction = `  async function recover() {
    if (busy) return;
    const marker = pending(); if (!marker) { notice(); return; }
    busy = true; const storage = scope();
    try {
      // Locking resolver commits a tombstone if absent, rejecting any delayed request.
      const result = await api(client => financialKinds.includes(marker.kind) ? client.resolveFinancialOperation(marker.key, marker.kind) : client.resolveOperation(marker.key));
      let markerRemoved = false;
      try { localStorage.removeItem(storage); markerRemoved = true; } catch { /* Preserve the key for another safe reconciliation. */ }
      if (markerRemoved) notice(); else showPending();
      await completeCommittedResult(result, true);
    } catch (error) { window.PosConnected.handleError(error); showPending(); }
    finally { busy = false; }
  }
`;

function transformConnectedSales(source) {
  const oldClear = 'window.PosRuntime.clearSaleDetail(result.sale.detail);';
  requireOnce(source, oldClear, 'connected-sales.js / limpieza del detalle');
  source = source.replace(oldClear, 'clearConfirmedSaleDetail(result.sale.detail);');
  requireOnce(source, helperAnchor, 'connected-sales.js / anclaje de helpers del cobro');
  source = source.replace(helperAnchor, withNewline(helpers, newlineOf(source)) + helperAnchor);
  source = replaceRange(source, '  async function performWithMarker(kind, data, action) {', '  async function recover() {', performFunction, 'connected-sales.js / performWithMarker');
  source = replaceRange(source, '  async function recover() {', '  function cartData(', recoverFunction, 'connected-sales.js / recover');
  return source;
}

function transformApiClient(source) {
  requireOnce(source, paymentAnchor, 'api-client.js / validacion de pagos');
  source = source.replace(paymentAnchor, withNewline(saleOrderCheck, newlineOf(source)) + paymentAnchor);
  requireOnce(source, oldCharge, 'api-client.js / chargeOrder');
  return source.replace(oldCharge, newCharge);
}

function transformServiceWorker(source, packageSha) {
  requireOnce(source, BASE_CACHE_NAME, 'service-worker.js / CACHE_NAME publicado');
  if (!/^[a-f0-9]{64}$/.test(packageSha)) fail('SHA-256 de paquete invalido.');
  const next = `const CACHE_NAME = 'pos-pwa-shell-chargefix-${packageSha.slice(0, 16)}';`;
  return source.replace(BASE_CACHE_NAME, next);
}

function filesUnder(root) {
  const files = new Map();
  function walk(directory, relative = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const full = path.join(directory, entry.name), name = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) fail(`No se aceptan symlinks en la raiz web: ${name}`);
      if (stat.isDirectory()) walk(full, name);
      else if (stat.isFile()) files.set(name, fs.readFileSync(full));
      else fail(`Tipo de recurso web no permitido: ${name}`);
    }
  }
  walk(root);
  return files;
}
function diagnosticsSnapshot(files) {
  return historySignature(FILES.map(name => [name, files.get(name).toString('utf8')]));
}
function section(text, startToken, endToken, label) {
  requireOnce(text, startToken, `${label} inicio`);
  requireOnce(text, endToken, `${label} fin`);
  const start = text.indexOf(startToken), end = text.indexOf(endToken, start + startToken.length);
  if (end <= start) fail(`${label}: limites fuera de orden`);
  return text.slice(start, end);
}
function printHunk(label, before, after) {
  process.stdout.write(`@@ ${label} @@\n`);
  if (before) process.stdout.write(before.replace(/\r?\n/g, '\n').split('\n').filter(Boolean).map(line => `-${line}\n`).join(''));
  if (after) process.stdout.write(after.replace(/\r?\n/g, '\n').split('\n').filter(Boolean).map(line => `+${line}\n`).join(''));
}
function apply(root, packageSha) {
  const resolved = path.resolve(root), beforeTree = filesUnder(resolved);
  for (const name of FILES) if (!beforeTree.has(name)) fail(`Falta el archivo activo: ${name}`);
  verifyPublishedBaseline(beforeTree);
  const beforeDiagnostics = diagnosticsSnapshot(beforeTree);
  const transforms = new Map([
    ['app.js', transformApp],
    ['connected-sales.js', transformConnectedSales],
    ['api-client.js', transformApiClient],
    ['service-worker.js', text => transformServiceWorker(text, packageSha)]
  ]);
  const beforeContents = new Map(FILES.map(name => [name, beforeTree.get(name).toString('utf8')]));
  const afterContents = new Map();
  for (const name of FILES) {
    const original = beforeContents.get(name), transformed = transforms.get(name)(original);
    if (transformed === original) fail(`${name}: la transformacion no produjo cambios.`);
    afterContents.set(name, transformed);
  }
  const afterDiagnostics = diagnosticsSnapshot(new Map([...beforeTree, ...[...afterContents].map(([name, text]) => [name, Buffer.from(text, 'utf8')])]));
  if (JSON.stringify(afterDiagnostics) !== JSON.stringify(beforeDiagnostics)) {
    for (const name of FILES) if (afterDiagnostics[name] !== beforeDiagnostics[name]) process.stderr.write(`HISTORY_DIAGNOSTIC_DIFF=${name}\nBEFORE=${JSON.stringify(beforeDiagnostics[name])}\nAFTER=${JSON.stringify(afterDiagnostics[name])}\n`);
    fail('Los diagnosticos del historial cambiaron.');
  }
  for (const [name, text] of afterContents) fs.writeFileSync(path.join(resolved, name), text, 'utf8');
  const afterTree = filesUnder(resolved);
  const changed = [...new Set([...beforeTree.keys(), ...afterTree.keys()])].filter(name => !beforeTree.has(name) || !afterTree.has(name) || !beforeTree.get(name).equals(afterTree.get(name)));
  if (changed.length !== FILES.length || FILES.some(name => !changed.includes(name))) fail(`Overlay fuera del allowlist: ${changed.join(',')}`);
  for (const name of FILES) {
    const original = beforeContents.get(name), transformed = afterContents.get(name);
    process.stdout.write(`--- ${name} (active -> candidate) ---\n`);
    if (name === 'connected-sales.js') {
      printHunk('confirmed detail clearing', 'window.PosRuntime.clearSaleDetail(result.sale.detail);', 'clearConfirmedSaleDetail(result.sale.detail);');
      printHunk('post-response operation guard', section(original, '  async function performWithMarker(kind, data, action) {', '  async function recover() {', 'performWithMarker'), section(transformed, '  async function performWithMarker(kind, data, action) {', '  async function recover() {', 'performWithMarker'));
      printHunk('idempotent recovery handler', section(original, '  async function recover() {', '  function cartData(', 'recover'), section(transformed, '  async function recover() {', '  function cartData(', 'recover'));
      printHunk('confirmed completion fallback', helperAnchor, helpers + helperAnchor);
    } else if (name === 'app.js') printHunk('PosRuntime definition', '    // SOFTVENTAWEB_HISTORY_DIAGNOSTICS_V1:runtime', `${appMethod}\n    // SOFTVENTAWEB_HISTORY_DIAGNOSTICS_V1:runtime`);
    else if (name === 'api-client.js') {
      const paymentLine = '      if (value.payment) {';
      printHunk('sale/order response linkage', paymentLine, `${saleOrderCheck.trimEnd()}\n${paymentLine}`);
      printHunk('chargeOrder response contract', oldCharge, newCharge);
    } else printHunk('service-worker cache revision', BASE_CACHE_NAME, `const CACHE_NAME = 'pos-pwa-shell-chargefix-${packageSha.slice(0, 16)}';`);
    process.stdout.write(`SHA256_ACTIVE=${sha256(beforeTree.get(name))}\nSHA256_CANDIDATE=${sha256(afterTree.get(name))}\n`);
    if (!original.length || !transformed.length) fail(`${name}: diff vacio inesperado.`);
  }
  process.stdout.write('HISTORY_DIAGNOSTICS_BYTE_SIGNATURE=UNCHANGED\nWEB_TREE_ALLOWLIST=PASS\n');
}

function fixtureFiles() {
  const app = `window.PosRuntime = Object.freeze({\n    salesInput() {},\n    setSales(values) { return values; },\n    // SOFTVENTAWEB_HISTORY_DIAGNOSTICS_V1:runtime\n    setSalesSearchResults(values) { return values; },\n    clearSalesSearchResults() {},\n    publishSale(value) { return value; }\n});\nwindow.PosRuntime.clearSaleDetail(input.detail);\n`;
  const connected = `async function completed(result, recovered = false) {\n  if (result.kind === 'SALE') {\n    window.PosRuntime.clearSaleDetail(result.sale.detail);\n  }\n}\n  // These explicit schema rejections roll back the transaction and never commit money.\n  async function performWithMarker(kind, data, action) { return action(data); }\n  async function recover() { return true; }\n  function cartData() { return {}; }\n`;
  const api = `#salesResult(value) {\n      if (value.payment) { const payment = value.payment; }\n      return value;\n    }\n    async chargeOrder(id,data) { return this.#salesResult(await this.#write('/cash/orders/'+encodeURIComponent(id)+'/charge','POST',data)); }\n    async cancelOrder(id,data) { return value; }\n`;
  const sw = `${BASE_CACHE_NAME}\nconst CACHE_PREFIX = 'pos-pwa-shell-';\nself.addEventListener('install', event => {});\n`;
  return new Map([['app.js', app], ['connected-sales.js', connected], ['api-client.js', api], ['service-worker.js', sw]]);
}
function selfTest() {
  const packageSha = 'a'.repeat(64), input = fixtureFiles();
  const beforeDiagnostics = diagnosticsSnapshot(new Map([...input].map(([name, text]) => [name, Buffer.from(text)])));
  const output = new Map([
    ['app.js', transformApp(input.get('app.js'))],
    ['connected-sales.js', transformConnectedSales(input.get('connected-sales.js'))],
    ['api-client.js', transformApiClient(input.get('api-client.js'))],
    ['service-worker.js', transformServiceWorker(input.get('service-worker.js'), packageSha)]
  ]);
  if (!output.get('app.js').includes(appMethod) || !output.get('connected-sales.js').includes('clearConfirmedSaleDetail(result.sale.detail);') || output.get('connected-sales.js').includes('window.PosRuntime.clearSaleDetail(result.sale.detail);')) fail('SelfTest: no se protegieron los puntos de cobro esperados.');
  for (const token of ['completeCommittedResult', 'ORDER_NOT_PENDING', 'resolveOperation(marker.key)', 'localStorage.removeItem(storage)']) if (!output.get('connected-sales.js').includes(token)) fail(`SelfTest: falta proteccion de cobro ${token}.`);
  for (const token of ["value.order.id!==String(id)", "value.order.saleId!==value.sale.id", "value.order.status!=='COMPLETED'"]) if (!output.get('api-client.js').includes(token)) fail(`SelfTest: falta validacion ${token}.`);
  if (!output.get('service-worker.js').includes(`pos-pwa-shell-chargefix-${packageSha.slice(0, 16)}`) || output.get('service-worker.js').includes(BASE_CACHE_NAME)) fail('SelfTest: no se invalidó el cache de forma versionada.');
  if (JSON.stringify(diagnosticsSnapshot(new Map([...output].map(([name, text]) => [name, Buffer.from(text)])))) !== JSON.stringify(beforeDiagnostics)) fail('SelfTest: se alteraron los diagnosticos del historial.');
  let duplicateRejected = false;
  try { transformApp(input.get('app.js') + '    // SOFTVENTAWEB_HISTORY_DIAGNOSTICS_V1:runtime\n'); } catch (error) { duplicateRejected = String(error.message).includes('coincidencia exacta'); }
  if (!duplicateRejected) fail('SelfTest: no rechazó un anclaje duplicado.');
  let baselineRejected = false;
  try { verifyPublishedBaseline(new Map([...input].map(([name, text]) => [name, Buffer.from(text)]))); } catch (error) { baselineRejected = String(error.message).includes('SHA-256 de imagen activa inesperado'); }
  if (!baselineRejected) fail('SelfTest: active image outside the verified baseline was not rejected.');
  let missingRejected = false;
  try { transformApiClient(input.get('api-client.js').replace("async chargeOrder(id,data) { return this.#salesResult(await this.#write('/cash/orders/'+encodeURIComponent(id)+'/charge','POST',data)); }", '')); } catch (error) { missingRejected = String(error.message).includes('coincidencia exacta'); }
  if (!missingRejected) fail('SelfTest: no rechazó un punto de inserción ausente.');
  process.stdout.write('SELFTEST=PASS\nPUBLISHED_BASE_SHA256=PINNED\nEXACT_ANCHORS_UNIQUE=PASS\nDUPLICATE_OR_MISSING_ANCHOR_REJECTED=PASS\nUNEXPECTED_ACTIVE_IMAGE_REJECTED=PASS\nHISTORY_DIAGNOSTICS_UNCHANGED=PASS\nSALE_AND_ORDER_VALIDATION=PASS\nSW_CACHE_REVISION=PASS\n');
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--self-test') selfTest();
else if (args.length === 3 && args[0] === '--apply' && /^[a-f0-9]{64}$/.test(args[2])) apply(args[1], args[2]);
else fail('Uso: --self-test | --apply <web-root> <package-sha256>');
