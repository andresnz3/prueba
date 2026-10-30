'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createHash, generateKeyPairSync, randomBytes, sign, verify } = require('node:crypto');
const { readConfig } = require('../../src/config/environment');
const { createDatabasePool } = require('../../src/config/database');
const { createAuthRepository } = require('../../src/repositories/auth');
const { createLocalLicenseService, codeNormalized, localBusinessDigest } = require('../../src/services/local-licenses');
const { localLicenseRoutes } = require('../../src/routes/local-license');
const { errorHandler } = require('../../src/middleware/errors');

const database = process.env.POS_INTEGRATION_DATABASE;
if (!/^pos_auth_test_[a-f0-9]{24}$/.test(database || '') || database === process.env.DB_NAME) throw new Error('Use isolated runner');

const makeConfig = () => ({
  enabled: true,
  pepper: randomBytes(32),
  keyId: 'integration-ephemeral',
  privateKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
});
const authAdmin = Object.freeze({ user_id: '1', username: 'andres', role: 'ADMIN', business_id: '1', isAdmin: true });
const b64url = bytes => Buffer.from(bytes).toString('base64url');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const publicJwk = key => {
  const value = key.export({ format: 'jwk' });
  return { kty: value.kty, crv: value.crv, x: value.x, y: value.y };
};
const publicKeyHash = value => sha256(JSON.stringify({ crv: value.crv, kty: value.kty, x: value.x, y: value.y }));
function verifyEnvelope(value, key) {
  const [body, signature, extra] = String(value).split('.');
  assert.equal(extra, undefined);
  assert.ok(verify('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}
function makeInstallation() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { pair, installationId: b64url(randomBytes(32)), publicKey: publicJwk(pair.publicKey) };
}
async function signedActivation(service, code, installation, ipAddress, localBusinessId = null) {
  const challenge = await service.public.challenge({ purpose: 'ACTIVATE', ipAddress });
  const normalized = codeNormalized(code);
  const fingerprint = publicKeyHash(installation.publicKey);
  const canonical = localBusinessId
    ? ['POS_LOCAL_LICENSE_ACTIVATE_V2', challenge.challengeId, challenge.challenge, normalized, installation.installationId, localBusinessId.trim().toLowerCase(), fingerprint].join('\n')
    : ['POS_LOCAL_LICENSE_ACTIVATE_V1', challenge.challengeId, challenge.challenge, normalized, installation.installationId, fingerprint].join('\n');
  const signature = sign('sha256', Buffer.from(canonical), { key: installation.pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return service.public.activate({ licenseCode: code, installationId: installation.installationId, ...(localBusinessId ? { localBusinessId } : {}), publicKey: installation.publicKey, challengeId: challenge.challengeId, challenge: challenge.challenge, signature }, ipAddress);
}
async function signedStatus(service, licenseId, installation, ipAddress, localBusinessId = null) {
  const challenge = await service.public.challenge({ purpose: 'STATUS', ipAddress });
  const canonical = localBusinessId
    ? ['POS_LOCAL_LICENSE_STATUS_V2', challenge.challengeId, challenge.challenge, licenseId, installation.installationId, localBusinessId.trim().toLowerCase()].join('\n')
    : ['POS_LOCAL_LICENSE_STATUS_V1', challenge.challengeId, challenge.challenge, licenseId, installation.installationId].join('\n');
  const signature = sign('sha256', Buffer.from(canonical), { key: installation.pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return service.public.status({ licenseId, installationId: installation.installationId, ...(localBusinessId ? { localBusinessId } : {}), challengeId: challenge.challengeId, challenge: challenge.challenge, signature }, ipAddress);
}
function expectPublicError(promise, publicCode) {
  return assert.rejects(promise, error => error.publicCode === publicCode);
}

test('license issuance, one-install activation, signed status, transfer and revocation are atomic and auditable', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 4 });
  t.after(() => pool.end());
  const repo = createAuthRepository(pool, { absoluteSeconds: 28800 });
  const signer = makeConfig();
  const serviceA = createLocalLicenseService(repo, signer, auth => auth?.isAdmin === true);
  const serviceB = createLocalLicenseService(repo, signer, auth => auth?.isAdmin === true);
  await expectPublicError(serviceA.admin.generate({ isAdmin: false }, { customerName: 'Falso' }), 'SYSTEM_ADMIN_REQUIRED');

  const issued = await serviceA.admin.generate(authAdmin, { customerName: 'Cliente ficticio', customerReference: 'TEST-19' });
  assert.match(issued.code, /^POSL-(?:[A-F0-9]{4}-){11}[A-F0-9]{4}$/);
  const [stored] = await pool.execute('SELECT code_hash,status FROM local_licenses WHERE id=?', [issued.license.id]);
  assert.equal(stored[0].status, 'PENDING');
  assert.match(stored[0].code_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(stored[0].code_hash, issued.code);
  assert.equal(JSON.stringify(await serviceA.admin.list(authAdmin)).includes(issued.code), false);

  const first = makeInstallation();
  const second = makeInstallation();
  const activation = await signedActivation(serviceA, issued.code, first, 'test-ip-activation-1');
  assert.equal(activation.licenseId, issued.license.id);
  assert.equal(activation.status, 'ACTIVE');
  const signedPermit = verifyEnvelope(activation.permit, signer.privateKey);
  assert.equal(signedPermit.permanent, true);
  assert.equal(signedPermit.installationHash, sha256('pos-local-installation-v1\0' + first.installationId));

  await expectPublicError(signedActivation(serviceB, issued.code, second, 'test-ip-activation-2'), 'LOCAL_LICENSE_UNAVAILABLE');
  const idempotent = await signedActivation(serviceB, issued.code, first, 'test-ip-activation-1');
  assert.equal(idempotent.licenseId, issued.license.id);
  assert.equal(verifyEnvelope(idempotent.permit, signer.privateKey).installationHash, signedPermit.installationHash);
  const status = await signedStatus(serviceA, issued.license.id, first, 'test-ip-status-1');
  assert.equal(status.status, 'ACTIVE');
  const signedStatusPayload = verifyEnvelope(status.signedStatus, signer.privateKey);
  assert.equal(signedStatusPayload.status, 'ACTIVE');

  const transfer = await serviceA.admin.transfer(authAdmin, issued.license.id);
  assert.deepEqual([transfer.status, transfer.transferCount], ['PENDING', 1]);
  assert.equal((await signedStatus(serviceB, issued.license.id, first, 'test-ip-status-2')).status, 'TRANSFERRED');
  const reactivated = await signedActivation(serviceB, issued.code, second, 'test-ip-activation-3');
  assert.equal(reactivated.status, 'ACTIVE');
  const revoked = await serviceA.admin.revoke(authAdmin, issued.license.id, 'Revocación administrativa justificada');
  assert.equal(revoked.status, 'REVOKED');
  assert.equal((await signedStatus(serviceB, issued.license.id, second, 'test-ip-status-3')).status, 'REVOKED');

  const [events] = await pool.execute('SELECT event_type,actor_username,reason,created_at FROM local_license_events WHERE license_id=? ORDER BY id', [issued.license.id]);
  assert.deepEqual(events.map(row => row.event_type), ['ISSUED', 'ACTIVATED', 'TRANSFERRED', 'ACTIVATED', 'REVOKED']);
  assert.ok(events.filter(row => row.actor_username).every(row => row.actor_username === 'andres'));
  const transferEvent = events.find(row => row.event_type === 'TRANSFERRED');
  assert.equal(transferEvent.reason, null);
  assert.equal(transferEvent.actor_username, 'andres');
  assert.ok(transferEvent.created_at instanceof Date || Number.isFinite(new Date(transferEvent.created_at).getTime()));
});

test('system admin counts distinct stable local businesses, not licensee names, and excludes pending or revoked licenses', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 4 });
  t.after(() => pool.end());
  const repo = createAuthRepository(pool, { absoluteSeconds: 28800 });
  const service = createLocalLicenseService(repo, makeConfig(), auth => auth?.isAdmin === true);
  const before = await service.admin.list(authAdmin);
  let ip = 0;
  const issueAndActivate = async (customerName, localBusinessId) => {
    const issued = await service.admin.generate(authAdmin, { customerName, customerReference: null });
    const install = makeInstallation();
    const result = await signedActivation(service, issued.code, install, 'test-count-' + (++ip), localBusinessId);
    assert.equal(result.status, 'ACTIVE');
    return issued;
  };

  await issueAndActivate('Cliente Duplicado', 'a0000000-0000-4000-8000-000000000001');
  await issueAndActivate('  CLIENTE DUPLICADO  ', 'b0000000-0000-4000-8000-000000000002');
  await issueAndActivate('Licencia adicional con nombre actualizado', 'a0000000-0000-4000-8000-000000000001');
  await issueAndActivate('Otra Empresa Ficticia', 'c0000000-0000-4000-8000-000000000003');
  await service.admin.generate(authAdmin, { customerName: 'Licencia Pendiente', customerReference: null });
  const revoked = await service.admin.generate(authAdmin, { customerName: 'Licencia Revocada', customerReference: null });
  await service.admin.revoke(authAdmin, revoked.license.id, 'Prueba de revocación administrativa');

  const all = await service.admin.list(authAdmin);
  assert.equal(all.activeLocalBusinessCount, before.activeLocalBusinessCount + 3);
  assert.equal(all.licenses.length, before.licenses.length + 6);
  assert.equal((await service.admin.list(authAdmin, 'PENDING')).activeLocalBusinessCount, before.activeLocalBusinessCount + 3);
  assert.equal((await service.admin.list(authAdmin, 'ACTIVE')).licenses.length, before.licenses.filter(license => license.status === 'ACTIVE').length + 4);
  await assert.rejects(service.admin.list({ isAdmin: false }), error => error.publicCode === 'SYSTEM_ADMIN_REQUIRED');
});

test('legacy active licenses remain valid and bind once a signed stable business identity is reported', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 4 });
  t.after(() => pool.end());
  const repo = createAuthRepository(pool, { absoluteSeconds: 28800 });
  const service = createLocalLicenseService(repo, makeConfig(), auth => auth?.isAdmin === true);
  const before = await service.admin.list(authAdmin);
  const issued = await service.admin.generate(authAdmin, { customerName: 'Licencia anterior ficticia', customerReference: null });
  const installation = makeInstallation();

  const activated = await signedActivation(service, issued.code, installation, 'test-legacy-activation');
  assert.equal(activated.status, 'ACTIVE');
  const [unbound] = await pool.execute('SELECT local_business_id_hash FROM local_licenses WHERE id=?', [issued.license.id]);
  assert.equal(unbound[0].local_business_id_hash, null);
  assert.equal((await service.admin.list(authAdmin)).activeLocalBusinessCount, before.activeLocalBusinessCount);

  await signedStatus(service, issued.license.id, installation, 'test-legacy-status', 'd0000000-0000-4000-8000-000000000004');
  const [boundRows] = await pool.execute('SELECT l.local_business_id_hash AS licenseHash,i.local_business_id_hash AS installationHash FROM local_licenses l JOIN local_license_installations i ON i.license_id=l.id AND i.installation_hash=l.active_installation_hash WHERE l.id=?', [issued.license.id]);
  assert.equal(boundRows[0].licenseHash, localBusinessDigest('d0000000-0000-4000-8000-000000000004'));
  assert.equal(boundRows[0].installationHash, boundRows[0].licenseHash);
  assert.equal((await service.admin.list(authAdmin)).activeLocalBusinessCount, before.activeLocalBusinessCount + 1);
  await expectPublicError(signedStatus(service, issued.license.id, installation, 'test-legacy-mismatch', 'e0000000-0000-4000-8000-000000000005'), 'LOCAL_LICENSE_UNAVAILABLE');
  assert.equal((await service.admin.list(authAdmin)).activeLocalBusinessCount, before.activeLocalBusinessCount + 1);
});

test('an administratively transferred license can bind to the new local identity without counting twice', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 4 });
  t.after(() => pool.end());
  const repo = createAuthRepository(pool, { absoluteSeconds: 28800 });
  const service = createLocalLicenseService(repo, makeConfig(), auth => auth?.isAdmin === true);
  const before = await service.admin.list(authAdmin);
  const issued = await service.admin.generate(authAdmin, { customerName: 'Transferencia ficticia', customerReference: null });
  const first = makeInstallation();
  await signedActivation(service, issued.code, first, 'test-transfer-first', 'f0000000-0000-4000-8000-000000000006');
  assert.equal((await service.admin.list(authAdmin)).activeLocalBusinessCount, before.activeLocalBusinessCount + 1);

  await service.admin.transfer(authAdmin, issued.license.id);
  assert.equal((await service.admin.list(authAdmin)).activeLocalBusinessCount, before.activeLocalBusinessCount);
  const second = makeInstallation();
  await signedActivation(service, issued.code, second, 'test-transfer-second', '10000000-0000-4000-8000-000000000007');
  assert.equal((await service.admin.list(authAdmin)).activeLocalBusinessCount, before.activeLocalBusinessCount + 1);
  assert.equal((await signedStatus(service, issued.license.id, first, 'test-transfer-old-status')).status, 'TRANSFERRED');
  const [row] = await pool.execute('SELECT local_business_id_hash FROM local_licenses WHERE id=?', [issued.license.id]);
  assert.equal(row[0].local_business_id_hash, localBusinessDigest('10000000-0000-4000-8000-000000000007'));
});

test('simultaneous installs yield one winner and failed attempts remain rate limited across backend instances', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 4 });
  t.after(() => pool.end());
  const repo = createAuthRepository(pool, { absoluteSeconds: 28800 });
  const signer = makeConfig();
  const a = createLocalLicenseService(repo, signer, () => true);
  const b = createLocalLicenseService(repo, signer, () => true);
  const issued = await a.admin.generate(authAdmin, { customerName: 'Concurrencia ficticia', customerReference: null });
  const installs = [makeInstallation(), makeInstallation()];
  const outcomes = await Promise.allSettled(installs.map((installation, index) => signedActivation(index ? a : b, issued.code, installation, 'test-ip-parallel-' + index)));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected' && result.reason.publicCode === 'LOCAL_LICENSE_UNAVAILABLE').length, 1);
  const [licenseRows] = await pool.execute('SELECT status,active_installation_hash FROM local_licenses WHERE id=?', [issued.license.id]);
  assert.equal(licenseRows[0].status, 'ACTIVE');
  const [activeInstalls] = await pool.execute("SELECT COUNT(*) AS count FROM local_license_installations WHERE license_id=? AND state='ACTIVE'", [issued.license.id]);
  assert.equal(Number(activeInstalls[0].count), 1);

  const attacker = makeInstallation();
  let limited;
  const guessed = 'POSL-' + ('0'.repeat(48)).match(/.{4}/g).join('-');
  for (let index = 0; index < 9; index += 1) {
    try { await signedActivation(index % 2 ? a : b, guessed, attacker, 'test-ip-bruteforce'); }
    catch (error) { limited = error; }
  }
  assert.equal(limited?.publicCode, 'LOCAL_LICENSE_RATE_LIMITED');
  assert.ok(limited.retryAfter > 0);
  const [counters] = await pool.execute('SELECT MAX(attempts) AS attempts FROM local_license_rate_limits');
  assert.ok(Number(counters[0].attempts) >= 8);
});

test('license middleware is scoped to its own endpoints and checks configured browser origins', async t => {
  const config = readConfig();
  const pool = createDatabasePool({ ...config.database, database, connectionLimit: 2 });
  t.after(() => pool.end());
  const repo = createAuthRepository(pool, { absoluteSeconds: 28800 });
  const app = express();
  const signer = makeConfig();
  const service = createLocalLicenseService(repo, signer, () => true);
  app.use(express.json());
  app.use('/api', localLicenseRoutes({ repo }, signer, ['http://pos-test.invalid']));
  app.get('/api/ordinary', (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const ordinary = await fetch(origin + '/api/ordinary');
  assert.equal(ordinary.status, 200);
  assert.deepEqual(await ordinary.json(), { ok: true });
  const denied = await fetch(origin + '/api/local-license/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-POS-License-Request': '1', Origin: 'http://wrong.invalid' }, body: JSON.stringify({ purpose: 'ACTIVATE' }) });
  assert.equal(denied.status, 403);
  const allowed = await fetch(origin + '/api/local-license/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-POS-License-Request': '1', Origin: 'http://pos-test.invalid' }, body: JSON.stringify({ purpose: 'ACTIVATE' }) });
  assert.equal(allowed.status, 200);
  const payload = await allowed.json();
  assert.match(payload.challengeId, /^[a-f0-9]{32}$/);
  assert.match(payload.challenge, /^[A-Za-z0-9_-]{43}$/);

  const beforeCount = (await service.admin.list(authAdmin)).activeLocalBusinessCount;
  const issued = await service.admin.generate(authAdmin, { customerName: 'Ruta v2 ficticia', customerReference: null });
  const installation = makeInstallation();
  const localBusinessId = '20000000-0000-4000-8000-000000000008';
  const post = async (path, body) => fetch(origin + '/api/local-license/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-POS-License-Request': '1', Origin: 'http://pos-test.invalid' },
    body: JSON.stringify(body)
  });
  const activationChallengeResponse = await post('challenge', { purpose: 'ACTIVATE' });
  const activationChallenge = await activationChallengeResponse.json();
  const activationMessage = ['POS_LOCAL_LICENSE_ACTIVATE_V2', activationChallenge.challengeId, activationChallenge.challenge, codeNormalized(issued.code), installation.installationId, localBusinessId, publicKeyHash(installation.publicKey)].join('\n');
  const activationSignature = sign('sha256', Buffer.from(activationMessage), { key: installation.pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const activationResponse = await post('activate', {
    licenseCode: issued.code, installationId: installation.installationId, localBusinessId, publicKey: installation.publicKey,
    challengeId: activationChallenge.challengeId, challenge: activationChallenge.challenge, signature: activationSignature
  });
  assert.equal(activationResponse.status, 200);
  const activated = await activationResponse.json();
  assert.equal(activated.status, 'ACTIVE');

  const statusChallengeResponse = await post('challenge', { purpose: 'STATUS' });
  const statusChallenge = await statusChallengeResponse.json();
  const statusMessage = ['POS_LOCAL_LICENSE_STATUS_V2', statusChallenge.challengeId, statusChallenge.challenge, activated.licenseId, installation.installationId, localBusinessId].join('\n');
  const statusSignature = sign('sha256', Buffer.from(statusMessage), { key: installation.pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const statusResponse = await post('status', {
    licenseId: activated.licenseId, installationId: installation.installationId, localBusinessId,
    challengeId: statusChallenge.challengeId, challenge: statusChallenge.challenge, signature: statusSignature
  });
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).status, 'ACTIVE');
  assert.equal((await service.admin.list(authAdmin)).activeLocalBusinessCount, beforeCount + 1);
});
