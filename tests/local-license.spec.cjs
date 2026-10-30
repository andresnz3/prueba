'use strict';
/* global localDB */

const { test, expect } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const { createHash, generateKeyPairSync, randomBytes, sign, verify, createPublicKey } = require('node:crypto');

const serverKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const keyId = 'browser-test-ephemeral';
const serverPublicJwk = serverKeys.publicKey.export({ format: 'jwk' });
const installJwk = value => ({ kty: value.kty, crv: value.crv, x: value.x, y: value.y });
const b64url = value => Buffer.from(value).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const canonicalCode = value => value.trim().toUpperCase().replace(/^POSL-/, '').replace(/[-\s]/g, '');
const corsHeaders = origin => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-POS-License-Request',
  'Access-Control-Max-Age': '600',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8'
});
function envelope(payload) {
  const body = b64url(Buffer.from(JSON.stringify({ ...payload, keyId })));
  return body + '.' + sign('sha256', Buffer.from(body), { key: serverKeys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
}
function signedClientPayload(request, purpose, publicKeyJwk = request?.publicKey) {
  if (!request || !publicKeyJwk || typeof publicKeyJwk !== 'object') return false;
  const publicKey = createPublicKey({ key: publicKeyJwk, format: 'jwk' });
  const message = purpose === 'ACTIVATE'
    ? ['POS_LOCAL_LICENSE_ACTIVATE_V2', request.challengeId, request.challenge, canonicalCode(request.licenseCode), request.installationId, request.localBusinessId, hash(JSON.stringify({ crv: publicKeyJwk.crv, kty: publicKeyJwk.kty, x: publicKeyJwk.x, y: publicKeyJwk.y }))].join('\n')
    : ['POS_LOCAL_LICENSE_STATUS_V2', request.challengeId, request.challenge, request.licenseId, request.installationId, request.localBusinessId].join('\n');
  return verify('sha256', Buffer.from(message), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(request.signature, 'base64url'));
}
function signedWithLegacyDomain(request, purpose) {
  if (!request?.publicKey || typeof request.publicKey !== 'object') return false;
  const publicKey = createPublicKey({ key: request.publicKey, format: 'jwk' });
  const message = purpose === 'ACTIVATE'
    ? ['POS_LOCAL_LICENSE_ACTIVATE_V1', request.challengeId, request.challenge, canonicalCode(request.licenseCode), request.installationId, hash(JSON.stringify({ crv: request.publicKey.crv, kty: request.publicKey.kty, x: request.publicKey.x, y: request.publicKey.y }))].join('\n')
    : ['POS_LOCAL_LICENSE_STATUS_V1', request.challengeId, request.challenge, request.licenseId, request.installationId].join('\n');
  return verify('sha256', Buffer.from(message), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(request.signature, 'base64url'));
}

async function resetToNewInstall(page) {
  await page.goto('/');
  await page.evaluate(async () => {
    await localDB.transaction('rw', localDB.tables, async () => {
      for (const table of localDB.tables) await table.clear();
    });
    const request = indexedDB.open('POS_LocalLicenseState');
    const database = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('authorization', 'readwrite');
      transaction.objectStore('authorization').clear();
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    await window.PosLocalAuth.load(localDB);
    await window.PosLocalLicense.load();
  });
  await page.reload();
}

async function installLicenseApi(page, { status = 'ACTIVE' } = {}) {
  const origin = process.env.POS_LOCAL_TEST_ORIGIN || 'http://127.0.0.1:5501';
  await page.addInitScript(({ id, jwk }) => { window.POS_LOCAL_LICENSE_PUBLIC_KEYS = { [id]: jwk }; }, { id: keyId, jwk: installJwk(serverPublicJwk) });
  const challenges = new Map();
  const requests = [];
  let currentStatus = status;
  let registeredPublicKey = null;
  page.on('request', request => {
    if (request.url().includes('/api/local-license/')) {
      try { requests.push({ path: new URL(request.url()).pathname, method: request.method(), body: request.postDataJSON() }); }
      catch { requests.push({ path: new URL(request.url()).pathname, method: request.method(), body: null }); }
    }
  });
  await page.route('http://127.0.0.1:3000/api/local-license/**', async route => {
    const request = route.request();
    const headers = corsHeaders(origin);
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const path = new URL(request.url()).pathname;
    const body = request.postDataJSON();
    if (path.endsWith('/challenge')) {
      const challengeId = randomBytes(16).toString('hex');
      const challenge = b64url(randomBytes(32));
      const record = { challengeId, challenge, purpose: body.purpose };
      challenges.set(challengeId, record);
      return route.fulfill({ status: 200, headers, body: JSON.stringify({ ...record, expiresAt: new Date(Date.now() + 300000).toISOString() }) });
    }
    if (path.endsWith('/activate')) {
      expect(Object.keys(body || {})).toContain('publicKey');
      requests.activationDiagnostics = { signatureValid: signedClientPayload(body, 'ACTIVATE'), legacySignatureValid: signedWithLegacyDomain(body, 'ACTIVATE'), businessIdValid: typeof body.localBusinessId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.localBusinessId), challengeValid: challenges.get(body.challengeId)?.purpose === 'ACTIVATE' };
      if (!requests.activationDiagnostics.signatureValid || !requests.activationDiagnostics.challengeValid) return route.fulfill({ status: 400, headers, body: JSON.stringify({ error: { code: 'LOCAL_LICENSE_UNAVAILABLE' } }) });
      registeredPublicKey = body.publicKey;
      const installationHash = hash('pos-local-installation-v1\0' + body.installationId);
      const permit = envelope({ type: 'POS_LOCAL_LICENSE', version: 1, licenseId: '51001', installationHash, issuedAt: new Date().toISOString(), permanent: true });
      return route.fulfill({ status: 200, headers, body: JSON.stringify({ permit, licenseId: '51001', status: 'ACTIVE' }) });
    }
    if (path.endsWith('/status')) {
      if (!signedClientPayload(body, 'STATUS', registeredPublicKey) || challenges.get(body.challengeId)?.purpose !== 'STATUS') return route.fulfill({ status: 400, headers, body: JSON.stringify({ error: { code: 'LOCAL_LICENSE_UNAVAILABLE' } }) });
      const signedStatus = envelope({ type: 'POS_LOCAL_LICENSE_STATUS', version: 1, licenseId: body.licenseId, installationHash: hash('pos-local-installation-v1\0' + body.installationId), status: currentStatus, checkedAt: new Date().toISOString() });
      return route.fulfill({ status: 200, headers, body: JSON.stringify({ signedStatus, status: currentStatus }) });
    }
    return route.fulfill({ status: 404, headers, body: JSON.stringify({ error: { code: 'NOT_FOUND' } }) });
  });
  requests.setStatus = nextStatus => { currentStatus = nextStatus; };
  return requests;
}

test('la instalación nueva activa con una firma verificable antes de configurar al propietario y no transmite datos comerciales', async ({ page }) => {
  const requests = await installLicenseApi(page);
  await resetToNewInstall(page);
  await expect(page.locator('#localLicenseGate')).toBeVisible();
  await expect(page.locator('#localOwnerSetupForm')).toBeHidden();
  await expect(page.locator('#loginForm')).toBeHidden();

  const code = 'POSL-' + '1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF'.match(/.{4}/g).join('-');
  await page.locator('#localLicenseCode').fill(code);
  await page.locator('#localLicenseSubmit').click();
  await expect.poll(() => requests.activationDiagnostics).toEqual({ signatureValid: true, legacySignatureValid: false, businessIdValid: true, challengeValid: true });
  await expect(page.locator('#localOwnerSetupForm')).toBeVisible();
  await expect(page.locator('#localLicenseGate')).toBeHidden();
  await page.locator('#localOwnerUsername').fill('duena');
  await page.locator('#localOwnerPassword').fill('Prueba-Licencia-Local-2026!');
  await page.locator('#localOwnerPasswordConfirm').fill('Prueba-Licencia-Local-2026!');
  await page.locator('#localOwnerSetupSubmit').click();
  await expect(page.locator('#app')).toBeVisible();

  const submitted = requests.filter(request => request.method === 'POST' && request.body);
  expect(submitted.length).toBeGreaterThanOrEqual(3);
  for (const request of submitted) {
    expect(Object.keys(request.body).some(key => key !== 'localBusinessId' && /sale|product|inventory|customer|supplier|purchase|cash|expense|debt|payment|invoice|business/i.test(key))).toBe(false);
  }
  const activation = submitted.find(request => request.path.endsWith('/activate'));
  expect(Object.keys(activation.body).sort()).toEqual(['challenge', 'challengeId', 'installationId', 'licenseCode', 'localBusinessId', 'publicKey', 'signature'].sort());
  expect(activation.body.localBusinessId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(activation.body.localBusinessId).not.toBe('00000000-0000-0000-0000-000000000000');
  const local = await page.evaluate(async () => {
    const license = await new Promise((resolve, reject) => {
      const request = indexedDB.open('POS_LocalLicenseState');
      request.onsuccess = () => { const db = request.result; const tx = db.transaction('authorization', 'readonly'); const get = tx.objectStore('authorization').get('current'); get.onsuccess = () => { resolve(get.result); db.close(); }; get.onerror = () => reject(get.error); };
      request.onerror = () => reject(request.error);
    });
    return { permit: license.permit, localBusinessId: license.localBusinessId, privateKeyExtractable: license.privateKey.extractable, owner: await localDB.localAuth.get('owner'), schemaVersion: localDB.verno };
  });
  expect(local.schemaVersion).toBe(11);
  expect(local.owner).toBeTruthy();
  expect(local.permit).toContain('.');
  expect(local.localBusinessId).toBe(activation.body.localBusinessId);
  expect(local.privateKeyExtractable).toBe(false);

  await page.evaluate(() => {
    const config = JSON.parse(localStorage.getItem('posSystemConfig') || '{}');
    config.name = 'Negocio ficticio con nombre actualizado';
    localStorage.setItem('posSystemConfig', JSON.stringify(config));
  });
  await page.reload();
  const statusAfterRename = requests.filter(request => request.path.endsWith('/status')).at(-1);
  expect(statusAfterRename?.body.localBusinessId).toBe(local.localBusinessId);
});

test('la recuperación por licencia prepara el JSON y espera una segunda acción para descargarlo', async ({ page }) => {
  const requests = await installLicenseApi(page);
  await resetToNewInstall(page);
  const code = 'POSL-' + 'A1B2C3D4E5F60718293A4B5C6D7E8F90123456789ABCDEF0'.match(/.{4}/g).join('-');
  await page.locator('#localLicenseCode').fill(code);
  await page.locator('#localLicenseSubmit').click();
  await expect(page.locator('#localOwnerSetupForm')).toBeVisible();
  await page.locator('#localOwnerUsername').fill('duena');
  await page.locator('#localOwnerPassword').fill('Prueba-Licencia-Local-2026!');
  await page.locator('#localOwnerPasswordConfirm').fill('Prueba-Licencia-Local-2026!');
  await page.locator('#localOwnerSetupSubmit').click();
  await expect(page.locator('#app')).toBeVisible();

  const original = await page.evaluate(async () => {
    localStorage.setItem('posSystemConfig', JSON.stringify({ localBusinessId: 'license-recovery-fixture', name: 'Negocio ficticio', currency: 'C$' }));
    await localDB.products.put({ id: 'license-recovery-product', business_id: 'license-recovery-fixture', name: 'Producto de prueba', barcode: 'QA-001', category: 'General', cost: '5.25', retailPrice: '8.50', stock: '3', password: 'fixture-secret-not-exported' });
    return { owner: await localDB.localAuth.get('owner'), products: await localDB.products.toArray(), sales: await localDB.sales.toArray() };
  });
  requests.setStatus('REVOKED');
  await page.evaluate(() => window.PosLocalLicense.checkStatus());
  await page.reload();
  await expect(page.locator('#localLicenseRecoveryActions')).toBeVisible();
  await expect(page.locator('#localLicenseExportBtn')).toBeVisible();
  await expect(page.locator('#localLicenseExportDownloadBtn')).toBeHidden();

  let downloadCount = 0;
  page.on('download', () => { downloadCount += 1; });
  await page.locator('#localLicenseExportBtn').click();
  await expect(page.locator('#localLicenseExportDownloadBtn')).toBeVisible();
  await expect(page.locator('#localLicenseExportBtn')).toBeHidden();
  await expect(page.locator('#localLicenseMessage')).toContainText('La copia está lista');
  expect(downloadCount).toBe(0);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#localLicenseExportDownloadBtn').click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(exported.version).toBe(2);
  expect(exported.data.products).toContainEqual(expect.objectContaining({ id: 'license-recovery-product', cost: '5.25', retailPrice: '8.50' }));
  expect(JSON.stringify(exported)).not.toContain('fixture-secret-not-exported');
  expect(JSON.stringify(exported)).not.toContain('Prueba-Licencia-Local-2026!');
  const after = await page.evaluate(async () => ({ owner: await localDB.localAuth.get('owner'), products: await localDB.products.toArray(), sales: await localDB.sales.toArray() }));
  expect(after).toEqual(original);
});

test('la autorización permanente sigue válida si el servidor no responde temporalmente', async ({ page }) => {
  await installLicenseApi(page);
  await resetToNewInstall(page);
  const code = 'POSL-' + 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789'.match(/.{4}/g).join('-');
  await page.locator('#localLicenseCode').fill(code);
  await page.locator('#localLicenseSubmit').click();
  await expect(page.locator('#localOwnerSetupForm')).toBeVisible();
  const state = await page.evaluate(async () => {
    const originalFetch = window.fetch;
    window.fetch = async () => { throw new Error('offline fixture'); };
    try { return await window.PosLocalLicense.load(); }
    finally { window.fetch = originalFetch; }
  });
  expect(state).toBe('ACTIVE');
  await expect(page.locator('#localOwnerSetupForm')).toBeVisible();
});

test('una instalación anterior conserva sus datos y puede continuar sin una autorización nueva inmediata', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#localLicenseGate')).toBeHidden();
  await expect(page.locator('#localLicenseLegacyPrompt')).toBeVisible();
  await expect(page.locator('#loginForm')).toBeVisible();
  const before = await page.evaluate(async () => ({
    owner: await localDB.localAuth.get('owner'),
    products: await localDB.products.count(),
    sales: await localDB.sales.count()
  }));
  expect(before.owner).toBeTruthy();
  await page.locator('#localLicenseLegacyActivateBtn').click();
  await expect(page.locator('#localLicenseGate')).toBeVisible();
  await page.locator('#localLicenseContinueLegacyBtn').click();
  await expect(page.locator('#loginForm')).toBeVisible();
  const after = await page.evaluate(async () => ({ owner: await localDB.localAuth.get('owner'), products: await localDB.products.count(), sales: await localDB.sales.count() }));
  expect(after).toEqual(before);
});
