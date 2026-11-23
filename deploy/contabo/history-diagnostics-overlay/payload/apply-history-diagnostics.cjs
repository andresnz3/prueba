'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const marker = 'SOFTVENTAWEB_HISTORY_DIAGNOSTICS_V1';
const allowedChanges = new Set(['api-client.js', 'app.js', 'connected-auth.js', 'connected-sales.js', 'service-worker.js']);
const packageSha = process.argv[4] || '';
const root = path.resolve(process.argv[3] || '');

function fail(message) { throw new Error(message); }
function count(source, needle) {
  if (!needle) return 0;
  let total = 0, offset = -1;
  while ((offset = source.indexOf(needle, offset + 1)) !== -1) total++;
  return total;
}
function replaceOnce(source, before, after, label) {
  const oldCount = count(source, before);
  if (oldCount !== 1) fail(`${label}: se esperaba una coincidencia exacta; encontradas=${oldCount}`);
  return source.replace(before, after);
}
function read(file) { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); }
function write(file, value) {
  const stat = fs.statSync(file);
  const temp = `${file}.history-diag-${process.pid}.tmp`;
  fs.writeFileSync(temp, value.replace(/\r\n/g, '\n'), { mode: stat.mode & 0o777 });
  fs.renameSync(temp, file);
}
function assertSyntax(source, filename) {
  try { new vm.Script(source, { filename }); }
  catch (error) { fail(`Sintaxis invalida en ${filename}: ${error.name}: ${error.message}`); }
}

function apiDiagnostics(source) {
  const hasMarker = source.includes(marker + ':api');
  if (!hasMarker) {
    const block = `  // ${marker}:api\n  const historyDiagnosticEndpoints = new Set(['/auth/me', '/auth/logout', '/admin/support-session/end', '/auth/modules/history/enter', '/reports/connected', '/sales', '/sales/orders/history']);\n  function historyApiDiagnostic(path, method, status, code, stage = 'request-failed') {\n    let enabled = false;\n    try { enabled = new URLSearchParams(globalThis.location?.search || '').get('diag') === 'history'; } catch { /* Diagnostics stay disabled for an invalid URL. */ }\n    const endpoint = String(path || '').split('?')[0];\n    if (!enabled || !historyDiagnosticEndpoints.has(endpoint)) return;\n    console[stage === 'response' ? 'info' : 'warn']('[SoftVentaWeb diagnostic] ' + JSON.stringify({ area: 'history-api', stage, method, endpoint, status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null, errorCode: /^[A-Z][A-Z0-9_]{0,63}$/.test(code || '') ? code : null }));\n  }\n`;
    source = replaceOnce(source, '  class PosApiClient {', block + '  class PosApiClient {', 'api-client insertion point');
  }
  if (!source.includes('function historyApiDiagnostic(') || !source.includes("get('diag') === 'history'")) fail('api-client contiene un diagnóstico parcial o no condicionado.');
  const networkBefore = "} catch { throw new ApiError('NETWORK_ERROR'); } finally { clearTimeout(timer); }";
  if (!source.includes("catch { historyApiDiagnostic(path, method, null, 'NETWORK_ERROR'); throw new ApiError('NETWORK_ERROR'); }")) {
    source = replaceOnce(source, networkBefore, "} catch { historyApiDiagnostic(path, method, null, 'NETWORK_ERROR'); throw new ApiError('NETWORK_ERROR'); } finally { clearTimeout(timer); }", 'api-client network error');
  }
  const jsonBefore = "try { data = await response.json(); } catch { throw new ApiError('INVALID_RESPONSE', response.status); }";
  if (!source.includes("catch { historyApiDiagnostic(path, method, response.status, 'INVALID_RESPONSE'); throw new ApiError('INVALID_RESPONSE', response.status); }")) {
    source = replaceOnce(source, jsonBefore, "try { data = await response.json(); } catch { historyApiDiagnostic(path, method, response.status, 'INVALID_RESPONSE'); throw new ApiError('INVALID_RESPONSE', response.status); }", 'api-client invalid JSON');
  }
  const codeLine = "        const code = typeof receivedCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(receivedCode) ? receivedCode : 'INTERNAL_ERROR';\n";
  if (!source.includes('historyApiDiagnostic(path, method, response.status, code);')) {
    source = replaceOnce(source, codeLine, codeLine + '        historyApiDiagnostic(path, method, response.status, code);\n', 'api-client HTTP error');
  }
  const successBefore = '      }\n      return data;\n    }\n    async csrf() {';
  if (!source.includes("historyApiDiagnostic(path, method, response.status, null, 'response');")) {
    source = replaceOnce(source, successBefore, "      }\n      historyApiDiagnostic(path, method, response.status, null, 'response');\n      return data;\n    }\n    async csrf() {", 'api-client successful response');
  }
  assertSyntax(source, 'api-client.js');
  return source;
}

function authDiagnosticBlock() {
  return `  // ${marker}:auth\n  function historySessionDiagnostic(stage, failure = null) {\n    let enabled = false;\n    try { enabled = new URLSearchParams(window.location.search).get('diag') === 'history'; } catch { /* Diagnostics stay disabled for an invalid URL. */ }\n    if (!enabled) return;\n    let runtimeBusinessId = null;\n    try { runtimeBusinessId = window.PosRuntime?.salesInput?.().businessId || null; } catch { /* No user or sale data is logged. */ }\n    const stack = typeof failure?.stack === 'string' ? failure.stack : '';\n    const location = stack.split(/\\r?\\n/).map(frame => {\n      const match = /(?:^|[/\\\\])((?:connected-sales|connected-auth|api-client|app)\\.js)(?:\\?[^:\\s)]*)?:(\\d+):\\d+/.exec(frame);\n      return match ? match[1] + ':' + match[2] : null;\n    }).find(Boolean) || null;\n    const record = { area: 'history-session', stage, ownerBusinessId: ownerBusinessId || null, effectiveBusinessId: effectiveBusinessId() || null, runtimeBusinessId, businessContextMatches: Boolean(effectiveBusinessId() && effectiveBusinessId() === runtimeBusinessId), role: identity?.role || null, supportSession: Boolean(supportContext), supportBusinessId: supportContext?.businessId || null, supportExpired: supportContext ? Date.parse(supportContext.expiresAt) <= Date.now() : null, sessionVerifiedSecondsAgo: lastSessionVerifiedAt ? Math.floor((Date.now() - lastSessionVerifiedAt) / 1000) : null };\n    if (failure) { record.errorCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code || '') ? failure.code : failure.message === 'Negocio incorrecto' ? 'BUSINESS_SCOPE_MISMATCH' : 'JAVASCRIPT_EXCEPTION'; record.status = Number.isInteger(failure.status) && failure.status >= 100 && failure.status <= 599 ? failure.status : null; record.errorName = /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(failure.name || '') ? failure.name : 'Error'; record.location = location; }\n    console[failure ? 'warn' : 'info']('[SoftVentaWeb diagnostic] ' + JSON.stringify(record));\n  }\n`;
}
function authDiagnostics(source) {
  if (!source.includes(marker + ':auth')) source = replaceOnce(source, '  async function navigate(view) {\n', authDiagnosticBlock() + '  async function navigate(view) {\n', 'connected-auth navigate declaration');
  if (!source.includes("get('diag') === 'history'") || !source.includes('if (!enabled) return;')) fail('connected-auth no limita los diagnósticos a diag=history.');
  const start = '  async function navigate(view) {\n';
  const end = '\n  async function login() {\n';
  if (count(source, start) !== 1 || count(source, end) !== 1) fail('connected-auth navigate/login boundaries are not unique.');
  const startAt = source.indexOf(start), endAt = source.indexOf(end, startAt + start.length);
  if (endAt < 0) fail('connected-auth login boundary does not follow navigate.');
  let region = source.slice(startAt, endAt);
  const hooks = [
    ['    if (busy || !identity) return;\n', "    if (busy || !identity) return;\n    if (view === 'historyView') historySessionDiagnostic('history-navigation-start');\n", 'connected-auth history navigation start'],
    ['      acceptVerifiedSession(await api.enter(views[view]), version);\n', "      acceptVerifiedSession(await api.enter(views[view]), version);\n      if (view === 'historyView') historySessionDiagnostic('history-authorized');\n", 'connected-auth history authorization success'],
    ["      if (failure.code === 'STALE_REQUEST') return;\n", "      if (failure.code === 'STALE_REQUEST') return;\n      if (view === 'historyView') historySessionDiagnostic('history-navigation-failed', failure);\n", 'connected-auth history navigation failure']
  ];
  for (const [before, after, label] of hooks) if (!region.includes(after.trim())) region = replaceOnce(region, before, after, label);
  source = source.slice(0, startAt) + region + source.slice(endAt);
  assertSyntax(source, 'connected-auth.js');
  return source;
}

function salesDiagnosticBlock() {
  return `  // ${marker}:sales\n  function historyDiagnosticsEnabled() {\n    try { return new URLSearchParams(window.location.search).get('diag') === 'history'; }\n    catch { return false; }\n  }\n  const historyErrorStages = new WeakMap();\n  function historyDiagnostic(stage, error) {\n    if (!historyDiagnosticsEnabled()) return;\n    const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : error?.message === 'Negocio incorrecto' ? 'BUSINESS_SCOPE_MISMATCH' : 'JAVASCRIPT_EXCEPTION';\n    const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null;\n    const errorName = /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error?.name || '') ? error.name : 'Error';\n    const stack = typeof error?.stack === 'string' ? error.stack : '';\n    const location = stack.split(/\\r?\\n/).map(frame => {\n      const match = /(?:^|[/\\\\])((?:connected-sales|connected-auth|api-client|app)\\.js)(?:\\?[^:\\s)]*)?:(\\d+):\\d+/.exec(frame);\n      return match ? match[1] + ':' + match[2] : null;\n    }).find(Boolean) || null;\n    console.warn('[SoftVentaWeb diagnostic] ' + JSON.stringify({ area: 'history', stage, code, status, errorName, location }));\n  }\n  function diagnoseHistoryRequest(stage, request) {\n    return Promise.resolve(request).catch(error => {\n      if (error && (typeof error === 'object' || typeof error === 'function')) historyErrorStages.set(error, stage);\n      throw error;\n    });\n  }\n`;
}
function addStageTracking(source) {
  const start = '  async function loadHistoryOnce() {\n';
  const end = '\n  async function loadHistory({ refresh = false } = {}) {\n';
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  if (startAt < 0 || endAt < 0 || count(source, start) !== 1 || count(source, end) !== 1) fail('No se identificó una única loadHistoryOnce() seguida por loadHistory({ refresh }).');
  let functionText = source.slice(startAt + start.length, endAt);
  if (!functionText.endsWith('\n  }')) fail('El cierre de loadHistoryOnce() no coincide con la estructura publicada.');
  let body = functionText.slice(0, -'\n  }'.length);
  if (body.includes("stage = 'map-sales'")) return source;
  if (!body.startsWith('    const range = ')) fail('No coincide la entrada esperada de loadHistoryOnce.');
  const requestLine = "    const [salesPage, historicalOrders] = await Promise.all([pages('sales'), api(client => client.historicalOrders())]);";
  const requestBlock = "    const [salesPage, historicalOrders] = await Promise.all([\n      diagnoseHistoryRequest('sales-list', pages('sales')),\n      diagnoseHistoryRequest('historical-orders', api(client => client.historicalOrders()))\n    ]);";
  if (body.includes(requestLine)) body = replaceOnce(body, requestLine, requestBlock, 'history request phases');
  else if (!body.includes("diagnoseHistoryRequest('sales-list'")) fail('No coincide la carga concurrente de ventas y órdenes.');
  const stageMarkers = [
    ['    const rows = salesPage.map(mappedSale).reverse();', "    stage = 'map-sales';\n    const rows = salesPage.map(mappedSale).reverse();", 'history map stage'],
    ['    historySales = rows;', "    stage = 'store-sales';\n    historySales = rows;", 'history store stage'],
    ['    window.PosRuntime.setSales(rows);', "    stage = 'publish-sales-runtime';\n    window.PosRuntime.setSales(rows);", 'history publish stage'],
    ['    clearTimeout(historySearchTimer);', "    stage = 'history-search';\n    clearTimeout(historySearchTimer);", 'history search stage'],
    ["    const historicalOrdersBody = el('historicalOrdersTableBody');", "    stage = 'render-historical-orders';\n    const historicalOrdersBody = el('historicalOrdersTableBody');", 'history orders render stage'],
    ['    await refreshHistorySummary(rows, reportRequest);', "    stage = 'connected-report';\n    await refreshHistorySummary(rows, reportRequest);", 'history report stage']
  ];
  for (const [before, after, label] of stageMarkers) if (!body.includes(after)) body = replaceOnce(body, before, after, label);
  body = "    let stage = 'history-range';\n    try {\n" + body + "\n    } catch (error) {\n      historyDiagnostic(historyErrorStages.get(error) || stage, error);\n      throw error;\n    }";
  return source.slice(0, startAt + start.length) + body + '\n  }' + source.slice(endAt);
}
function salesDiagnostics(source) {
  if (!source.includes(marker + ':sales')) {
    source = replaceOnce(source, '  async function loadHistoryOnce() {\n', salesDiagnosticBlock() + '  async function loadHistoryOnce() {\n', 'connected-sales loadHistoryOnce declaration');
  }
  if (!source.includes("get('diag') === 'history'")) fail('connected-sales no limita diagnósticos a diag=history.');
  source = addStageTracking(source);
  const reportCatch = "    } catch (error) {\n      if (request !== historySummaryRequest) return;\n";
  if (!source.includes("historyDiagnostic('connected-report', error);")) source = replaceOnce(source, reportCatch, reportCatch + "      historyDiagnostic('connected-report', error);\n", 'history report diagnostic');
  assertSyntax(source, 'connected-sales.js');
  return source;
}
function serviceWorkerDiagnostics(source, sha) {
  if (!source.includes('const CACHE_PREFIX = \'pos-pwa-shell-\';')) fail('El service worker no conserva el prefijo de caché esperado.');
  const next = `const CACHE_NAME = 'pos-pwa-shell-diag-${sha.slice(0, 16)}';`;
  const current = /^const CACHE_NAME = 'pos-pwa-shell-[a-z0-9-]+';$/m;
  const matches = source.match(current) || [];
  if (matches.length !== 1) fail('No se encontró una única revisión CACHE_NAME en service-worker.js.');
  source = source.replace(current, next);
  assertSyntax(source, 'service-worker.js');
  return source;
}

const runtimeSearchMethods = [
  "    setSalesSearchResults(values) { if (!connectedMode || !Array.isArray(values) || values.some(value => value.businessId !== CONNECTED_EFFECTIVE_BUSINESS_ID)) throw new Error('Negocio incorrecto'); const cache = new Map(salesHistory.map(value => [String(value.id), value])); values.forEach(value => cache.set(String(value.id), value)); salesHistory = [...cache.values()]; historySearchIds = new Set(values.map(value => String(value.id))); actualizarTablaHistorial(); },",
  "    clearSalesSearchResults() { if (!connectedMode) throw new Error('Modo conectado requerido'); historySearchIds = null; actualizarTablaHistorial(); },"
];
function appHistoryRuntime(source) {
  const methodSignatures = ['    setSalesSearchResults(values) {', '    clearSalesSearchResults() {'];
  const signatureCounts = methodSignatures.map(signature => count(source, signature));
  if (signatureCounts.some(Boolean)) {
    if (signatureCounts.some(value => value !== 1) || runtimeSearchMethods.some(method => count(source, method) !== 1)) {
      fail('app.js contiene una implementaciÃ³n parcial o distinta del runtime de bÃºsqueda de historial.');
    }
    return source;
  }
  if (!source.includes('let historySearchIds = null;') ||
      !source.includes('CONNECTED_EFFECTIVE_BUSINESS_ID') ||
      !source.includes('function actualizarTablaHistorial')) {
    fail('app.js no contiene el contexto vigente para filtrar historial por negocio.');
  }
  const insertion = `    // ${marker}:runtime\n${runtimeSearchMethods.join('\n')}\n`;
  source = replaceOnce(source, '    publishSale(value) {', insertion + '    publishSale(value) {', 'app.js history runtime insertion point');
  if (runtimeSearchMethods.some(method => count(source, method) !== 1)) fail('app.js no conservÃ³ Ãºnicos los mÃ©todos del runtime de historial.');
  assertSyntax(source, 'app.js');
  return source;
}

function allFiles(directory, relative = '') {
  const result = new Map();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail('La web raíz contiene un enlace simbólico no permitido: ' + rel);
    if (entry.isDirectory()) for (const [name, hash] of allFiles(full, rel)) result.set(name, hash);
    else if (entry.isFile()) result.set(rel, require('node:crypto').createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
  }
  return result;
}
function transform(files, sha) {
  files.set('api-client.js', apiDiagnostics(files.get('api-client.js')));
  files.set('app.js', appHistoryRuntime(files.get('app.js')));
  files.set('connected-auth.js', authDiagnostics(files.get('connected-auth.js')));
  files.set('connected-sales.js', salesDiagnostics(files.get('connected-sales.js')));
  files.set('service-worker.js', serviceWorkerDiagnostics(files.get('service-worker.js'), sha));
  return files;
}

function fixtureSources() {
  return {
    'api-client.js': `  class PosApiClient {
    async #request(path, method = 'GET') {
      let response;
      try { response = await fetch(path); } catch { throw new ApiError('NETWORK_ERROR'); } finally { clearTimeout(timer); }
      let data;
      if (response.status !== 204) {
        try { data = await response.json(); } catch { throw new ApiError('INVALID_RESPONSE', response.status); }
      }
      if (!response.ok) {
        const receivedCode = data?.error?.code;
        const code = typeof receivedCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(receivedCode) ? receivedCode : 'INTERNAL_ERROR';
        const error = new ApiError(code, response.status);
        throw error;
      }
      return data;
    }
    async csrf() {}
  }`,
    'connected-auth.js': `  let identity = null, ownerBusinessId = null, supportContext = null, activeView = null, grant = null;\n  let generation = 0, lastSessionVerifiedAt = 0;\n  const effectiveBusinessId = () => supportContext?.businessId || ownerBusinessId;\n  async function navigate(view) {\n    if (busy || !identity) return;\n    const previous = activeView; const version = generation;\n    try {\n      if (previous && previous !== view && grant) { grant = null; }\n      acceptVerifiedSession(await api.enter(views[view]), version);\n      await withVerifiedLoadScope(version, async () => { await Promise.all([window.PosSales.load(view)]); });\n    } catch (failure) {\n      if (failure.code === 'STALE_REQUEST') return;\n      error(failure);\n    } finally { busy = false; }\n  }\n  async function login() {\n  }`,
    'app.js': `let connectedMode = true;\nlet CONNECTED_EFFECTIVE_BUSINESS_ID = '3';\nlet salesHistory = [{ id: 'old', businessId: '3' }];\nlet historySearchIds = null;\nhistorySearchIds = new Set(['old']);\nlet renderCount = 0;\nfunction actualizarTablaHistorial() { renderCount++; }\nwindow.PosRuntime = Object.freeze({\n    setSales(values) { if (!connectedMode || values.some(value => value.businessId !== CONNECTED_EFFECTIVE_BUSINESS_ID)) throw new Error('Negocio incorrecto'); salesHistory = values; actualizarTablaHistorial(); },\n    publishSale(value) { if (!connectedMode || value.businessId !== CONNECTED_EFFECTIVE_BUSINESS_ID) throw new Error('Negocio incorrecto'); },\n});`,
    'connected-sales.js': `  async function refreshHistorySummary() {\n    try {\n      return;\n    } catch (error) {\n      if (request !== historySummaryRequest) return;\n      return;\n    }\n  }\n  async function loadHistoryOnce() {\n    const range = window.PosPeriodFilters?.range('history') || { from: '', until: '' };\n    const reportRequest = null;\n    const [salesPage, historicalOrders] = await Promise.all([pages('sales'), api(client => client.historicalOrders())]);\n    const rows = salesPage.map(mappedSale).reverse();\n    historySales = rows;\n    window.PosRuntime.setSales(rows);\n    clearTimeout(historySearchTimer);\n    if (historySearchQuery()) await applyHistorySearch(historySearchQuery());\n    else window.PosRuntime.clearSalesSearchResults();\n    const historicalOrdersBody = el('historicalOrdersTableBody');\n    if (historicalOrdersBody) {}\n    await refreshHistorySummary(rows, reportRequest);\n  }\n  async function loadHistory({ refresh = false } = {}) {\n  }`,
    'service-worker.js': `const CACHE_NAME = 'pos-pwa-shell-4d30cabed2bd0996';\nconst CACHE_PREFIX = 'pos-pwa-shell-';\nself.addEventListener('install', event => {});`
  };
}
function selfTest() {
  const sha = 'a'.repeat(64);
  const fixtures = fixtureSources();
  const authSource = fixtures['connected-auth.js'];
  const salesSource = fixtures['connected-sales.js'];
  const appSource = fixtures['app.js'];
  if (count(authSource, '  const moduleLoadStates = new Map();\n') !== 0 || count(authSource, '  async function navigate(view) {\n') !== 1) fail('SelfTest: debe reproducir el fallo publicado moduleLoadStates=0 y el anclaje único navigate(view).');
  if (count(salesSource, '  const navigationIsCurrent = navigation => !navigation || window.PosConnected.isNavigationCurrent(navigation);\n') !== 0 || count(salesSource, '  async function loadHistoryOnce() {\n') !== 1 || count(salesSource, '  async function loadHistory({ refresh = false } = {}) {\n') !== 1) fail('SelfTest: las firmas del historial no reproducen el código publicado.');
  const files = new Map(Object.entries(fixtures).map(([name, text]) => [name, text.replace(/\\n/g, '\n')]));
  const initial = new Map([...files].map(([name, text]) => [name, require('node:crypto').createHash('sha256').update(text).digest('hex')]));
  const beforeRuntime = {
    window: {}, CONNECTED_EFFECTIVE_BUSINESS_ID: '3', connectedMode: true,
    salesHistory: [{ id: 'old', businessId: '3' }], historySearchIds: new Set(['old']), renderCount: 0,
    actualizarTablaHistorial() { this.renderCount++; }
  };
  vm.runInNewContext(appSource, beforeRuntime, { filename: 'published-app.js' });
  let reproduced = false;
  try { vm.runInNewContext('window.PosRuntime.clearSalesSearchResults()', beforeRuntime); }
  catch (error) { reproduced = error?.name === 'TypeError'; }
  if (!reproduced) fail('SelfTest: no reprodujo el TypeError publicado en clearSalesSearchResults ausente.');
  transform(files, sha);
  if (!files.get('api-client.js').includes("stage === 'response' ? 'info' : 'warn'")) fail('SelfTest: falta el estado HTTP de respuestas exitosas.');
  if (!files.get('connected-auth.js').includes("get('diag') === 'history'")) fail('SelfTest: falta el gate de autenticación.');
  if (files.get('connected-auth.js').includes('moduleLoadStates')) fail('SelfTest: el fixture debe reproducir la ausencia del antiguo anclaje moduleLoadStates.');
  if (!files.get('connected-sales.js').includes("stage = 'publish-sales-runtime'")) fail('SelfTest: falta la fase de publicación.');
  if (!files.get('connected-sales.js').includes("diagnoseHistoryRequest('sales-list', pages('sales'))")) fail('SelfTest: el fixture debe reproducir el contrato publicado loadHistoryOnce() sin navigation.');
  if (!files.get('connected-sales.js').includes("error?.message === 'Negocio incorrecto' ? 'BUSINESS_SCOPE_MISMATCH'")) fail('SelfTest: falta el código diagnóstico de aislamiento.');
  if (count(files.get('app.js'), runtimeSearchMethods[0]) !== 1 || count(files.get('app.js'), runtimeSearchMethods[1]) !== 1) fail('SelfTest: app.js no recibió exactamente los dos métodos de búsqueda protegidos por negocio.');
  for (const [device, viewport] of [['desktop', { width: 1365, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
    const runtime = {
      window: {}, CONNECTED_EFFECTIVE_BUSINESS_ID: '3', connectedMode: true,
      salesHistory: [{ id: 'old', businessId: '3' }], historySearchIds: new Set(['old']),
      innerWidth: viewport.width, innerHeight: viewport.height
    };
    vm.runInNewContext(files.get('app.js'), runtime, { filename: `candidate-app-${device}.js` });
    vm.runInNewContext('window.PosRuntime.clearSalesSearchResults()', runtime);
    if (!vm.runInNewContext('historySearchIds === null && renderCount === 1', runtime)) fail(`SelfTest: la carga de historial vacía falló en fixture ${device}.`);
    vm.runInNewContext("window.PosRuntime.setSalesSearchResults([{ id: 'match', businessId: '3' }])", runtime);
    if (!vm.runInNewContext("historySearchIds instanceof Set && historySearchIds.has('match')", runtime)) fail(`SelfTest: la búsqueda de historial falló en fixture ${device}.`);
    let crossBusinessRejected = false;
    try { vm.runInNewContext("window.PosRuntime.setSalesSearchResults([{ id: 'foreign', businessId: '1' }])", runtime); }
    catch (error) { crossBusinessRejected = error?.message === 'Negocio incorrecto'; }
    if (!crossBusinessRejected) fail(`SelfTest: el fixture ${device} no rechazó resultados de otro negocio.`);
    process.stdout.write(`HISTORY_RUNTIME_REGRESSION_${device.toUpperCase()}=PASS\n`);
  }
  if (!files.get('service-worker.js').includes(`pos-pwa-shell-diag-${sha.slice(0,16)}`) || !files.get('service-worker.js').includes("const CACHE_PREFIX = 'pos-pwa-shell-';")) fail('SelfTest: actualización de cache no conserva el prefijo.');
  const changed = [...files].filter(([name, text]) => require('node:crypto').createHash('sha256').update(text).digest('hex') !== initial.get(name)).map(([name]) => name);
  if (changed.some(name => !allowedChanges.has(name)) || changed.length !== 5) fail('SelfTest: el overlay no está limitado a los cinco recursos allowlist.');
  const again = transform(new Map(files), sha);
  if ([...again].some(([name, text]) => text !== files.get(name))) fail('SelfTest: la aplicación repetida no es idempotente.');
  process.stdout.write('PUBLISHED_CLEAR_SEARCH_TYPEERROR_REGRESSION=PASS\nAUTH_ANCHOR_ZERO_MATCH_REGRESSION=PASS\nPUBLISHED_HISTORY_SIGNATURE_REGRESSION=PASS\nDIAGNOSTIC_TRANSFORM_SELFTEST=PASS\nDIAGNOSTIC_QUERY_GATE=PASS\nBUSINESS_ISOLATION_GUARD=PASS\nOVERLAY_ALLOWLIST=PASS\nSERVICE_WORKER_REVISION=PASS\n');
}

const mode = process.argv[2];
if (mode === '--self-test') selfTest();
else if (mode === '--apply') {
  if (!/^[a-f0-9]{64}$/.test(packageSha) || !root || !fs.statSync(root).isDirectory()) fail('Argumentos de overlay inválidos.');
  const before = allFiles(root);
  const texts = new Map();
  for (const name of allowedChanges) {
    if (!before.has(name)) fail('Falta recurso allowlist: ' + name);
    texts.set(name, read(path.join(root, name)));
  }
  transform(texts, packageSha);
  for (const [name, value] of texts) write(path.join(root, name), value);
  const after = allFiles(root);
  if (before.size !== after.size || [...before.keys()].some(name => !after.has(name))) fail('El overlay agregó o eliminó recursos.');
  const changed = [...before].filter(([name, hash]) => after.get(name) !== hash).map(([name]) => name).sort();
  if (changed.some(name => !allowedChanges.has(name))) fail('Cambió un recurso fuera del allowlist: ' + changed.filter(name => !allowedChanges.has(name)).join(', '));
  process.stdout.write(`HISTORY_DIAGNOSTIC_FILES=${changed.length ? changed.join(',') : 'ALREADY_PRESENT'}\n`);
} else fail('Uso: --self-test o --apply <webroot> <package-sha256>.');
