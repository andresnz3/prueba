/* global __ENV */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';
import exec from 'k6/execution';

const fixture = JSON.parse(open(__ENV.FIXTURES_PATH || '/fixtures/fixtures.json'));
const baseUrl = __ENV.BASE_URL || 'http://frontend';
const vus = Number(__ENV.LOAD_VUS || 5);
const duration = __ENV.LOAD_DURATION || '2m';
const burst = __ENV.LOAD_MODE === 'burst';
const forbiddenExpected = new Counter('expected_role_forbidden');
const busyControlled = new Counter('controlled_pool_busy');
const successfulLogins = new Counter('successful_logins');
const unexpectedFailure = new Rate('unexpected_failure_rate');
const unexpectedResponses = new Counter('unexpected_responses');
const loggedUnexpected = new Set();

export const options = {
  vus,
  duration,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: {
    unexpected_failure_rate: [{ threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '5s' }],
    ...(!burst ? { controlled_pool_busy: [{ threshold: 'count==0' }] } : {})
  }
};

let localIteration = 0;
let firstIteration = true;
function request(path, account, method = 'GET', body = undefined, expectedStatus = undefined) {
  const jar = http.cookieJar();
  const cookieName = 'pos_session';
  jar.set(baseUrl, cookieName, account.token, { path: '/' });
  const options = { jar, headers: { 'X-CSRF-Token': account.csrf, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, tags: { endpoint: path.split('?')[0] }, ...(expectedStatus ? { responseCallback: http.expectedStatuses(expectedStatus) } : {}) };
  return method === 'POST' ? http.post(baseUrl + path, JSON.stringify(body || {}), options) : http.get(baseUrl + path, options);
}

function login(account) {
  const jar = http.cookieJar();
  const csrfResponse = http.get(baseUrl + '/api/auth/csrf', { jar, tags: { endpoint: '/api/auth/csrf' } });
  if (!observe(csrfResponse, account)) return false;
  let loginCsrf;
  try { loginCsrf = csrfResponse.json()?.csrfToken; } catch { /* Count a malformed response below. */ }
  if (typeof loginCsrf !== 'string' || !loginCsrf) { unexpectedFailure.add(true); return false; }
  const response = http.post(baseUrl + '/api/auth/login', JSON.stringify({ username: account.username, password: fixture.password }), {
    jar,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': loginCsrf },
    tags: { endpoint: '/api/auth/login' }
  });
  if (!observe(response, account)) return false;
  let payload;
  try { payload = response.json(); } catch { /* Count a malformed response below. */ }
  const sessionToken = response.cookies?.pos_session?.[0]?.value;
  if (typeof sessionToken !== 'string' || typeof payload?.csrfToken !== 'string') { unexpectedFailure.add(true); return false; }
  account.token = sessionToken;
  account.csrf = payload.csrfToken;
  successfulLogins.add(1);
  return true;
}

function observe(response, account, expected403 = false) {
  let payload;
  try { payload = response.json(); } catch { payload = {}; }
  if (response.status === 403 && expected403 && payload?.error?.code === 'MODULE_FORBIDDEN') {
    forbiddenExpected.add(1);
    unexpectedFailure.add(false);
    return true;
  }
  if (response.status === 503 && payload?.error?.code === 'DATABASE_BUSY') {
    busyControlled.add(1);
    unexpectedFailure.add(false);
    if (burst) sleep(0.5 + Math.random() * 0.5);
    return false;
  }
  const okay = response.status >= 200 && response.status < 300;
  unexpectedFailure.add(!okay);
  if (!okay) {
    const endpoint = String(response.url).replace(/^.*\/api/, '/api').split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id');
    const code = String(payload?.error?.code || 'none');
    unexpectedResponses.add(1, { endpoint, status: String(response.status), code });
    const diagnosticKey = `${endpoint}|${response.status}|${code}`;
    if (!loggedUnexpected.has(diagnosticKey)) {
      loggedUnexpected.add(diagnosticKey);
      console.error('LOAD_UNEXPECTED ' + JSON.stringify({ endpoint, status: response.status, code }));
    }
    if (burst) sleep(0.5 + Math.random() * 0.5);
  }
  return check(response, { ['status success for ' + account.role]: () => okay });
}

export default function () {
  if (!burst && firstIteration) {
    firstIteration = false;
    sleep(Math.random() * 5);
  }
  try {
    runIteration();
  } finally {
    if (!burst) sleep(1 + Math.random() * 2);
  }
}

function runIteration() {
  const userIndex = (exec.vu.idInTest - 1) % 100;
  const tenant = userIndex % 10;
  const seat = Math.floor(userIndex / 10);
  const account = fixture.accounts[tenant * 10 + seat];
  const business = fixture.businesses[tenant];
  if (!account.token && !login(account)) return;
  const identity = request('/api/auth/me', account);
  if (!observe(identity, account)) return;
  let identityPayload;
  try { identityPayload = identity.json(); } catch { /* Count an identity mismatch below. */ }
  const identityMatches = identityPayload?.user?.username === account.username && String(identityPayload.user.businessId) === String(business.businessId);
  unexpectedFailure.add(!identityMatches);
  if (!check(identity, { 'login belongs to the assigned business': () => identityMatches })) return;
  if (!observe(request('/api/catalog/products?limit=20&search=Load', account), account)) return;
  if (account.role === 'ADMIN') {
    if (!observe(request('/api/clients?limit=10', account), account)) return;
  } else {
    const restrictedClients = request('/api/clients?limit=10', account, 'GET', undefined, 403);
    if (!observe(restrictedClients, account, true)) return;
    if (!observe(request('/api/sales/clients?limit=10', account), account)) return;
  }
  if (!observe(request('/api/sales/next-invoice', account), account)) return;
  if (account.role === 'ADMIN') {
    if (!observe(request('/api/suppliers?limit=10', account), account)) return;
    if (!observe(request('/api/reports/connected', account), account)) return;
    const otherBusiness = fixture.businesses[(tenant + 1) % fixture.businesses.length];
    const crossTenantRead = request('/api/products/' + otherBusiness.productId, account, 'GET', undefined, 404);
    let crossTenantPayload;
    try { crossTenantPayload = crossTenantRead.json(); } catch { crossTenantPayload = {}; }
    if (crossTenantRead.status === 503 && crossTenantPayload?.error?.code === 'DATABASE_BUSY') {
      busyControlled.add(1);
      unexpectedFailure.add(false);
      if (burst) sleep(0.5 + Math.random() * 0.5);
      else return;
    } else {
      const isolated = crossTenantRead.status === 404 && crossTenantPayload?.error?.code === 'PRODUCT_NOT_FOUND';
      unexpectedFailure.add(!isolated);
      if (!check(crossTenantRead, { 'other business product remains hidden': () => isolated })) return;
    }
  } else if (!observe(request('/api/sales', account, 'GET', undefined, 403), account, true)) return;
  if (!observe(request('/api/cash/current', account), account)) return;

  const saleInput = { items: [{ productId: business.productId, quantity: '1' }], priceType: 'RETAIL', discountPercent: '0', paymentMethod: 'CASH' };
  const quote = request('/api/sales/quote', account, 'POST', saleInput);
  if (!observe(quote, account)) return;
  let quoteBody;
  try { quoteBody = quote.json(); } catch { return; }
  const quoteToken = quoteBody?.quote?.quoteToken;
  if (typeof quoteToken !== 'string') { unexpectedFailure.add(true); return; }
  localIteration += 1;
  const operationKey = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 3) | 8).toString(16);
  });
  const saleBody = { ...saleInput, quoteToken, operationKey, cashReceived: '1.00', detail: 'Carga ficticia' };
  const sale = request('/api/sales', account, 'POST', saleBody);
  if (!observe(sale, account)) return;
  if (localIteration % 20 === 0) {
    const replay = request('/api/sales', account, 'POST', saleBody);
    let firstId;
    let replayId;
    let replayPayload;
    try { firstId = sale.json()?.sale?.id; replayPayload = replay.json(); replayId = replayPayload?.sale?.id; } catch { /* Count a malformed response below. */ }
    if (replay.status === 503 && replayPayload?.error?.code === 'DATABASE_BUSY') {
      busyControlled.add(1);
      unexpectedFailure.add(false);
      if (burst) sleep(0.5 + Math.random() * 0.5);
    } else {
      const replayOkay = replay.status === 201 && firstId === replayId;
      if (!replayOkay) unexpectedFailure.add(true);
      else unexpectedFailure.add(false);
      check(replay, { 'idempotent replay returns original sale': () => replayOkay });
    }
  }
}
