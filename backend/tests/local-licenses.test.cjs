'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const { readLocalLicenseConfig } = require('../src/config/local-licenses');
const { codeDisplay, codeNormalized, installationDigest, localBusinessIdNormalized, localBusinessDigest } = require('../src/services/local-licenses');

test('local license secrets remain disabled unless all server-only settings are valid', () => {
  assert.deepEqual(readLocalLicenseConfig({}), { enabled: false });
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const configured = readLocalLicenseConfig({
    LOCAL_LICENSE_CODE_PEPPER: randomBytes(32).toString('hex'),
    LOCAL_LICENSE_SIGNING_KEY_ID: 'unit-test-key',
    LOCAL_LICENSE_SIGNING_PRIVATE_KEY: key
  });
  assert.equal(configured.enabled, true);
  assert.equal(configured.privateKey.asymmetricKeyType, 'ec');
  assert.equal(readLocalLicenseConfig({
    LOCAL_LICENSE_CODE_PEPPER: 'not-a-secret',
    LOCAL_LICENSE_SIGNING_KEY_ID: 'unit-test-key',
    LOCAL_LICENSE_SIGNING_PRIVATE_KEY: key
  }).enabled, false);
});

test('license codes contain 192 random bits in a normalized printable format', () => {
  const code = codeDisplay(randomBytes(24));
  assert.match(code, /^POSL-(?:[A-F0-9]{4}-){11}[A-F0-9]{4}$/);
  assert.equal(codeNormalized(code), code.replace('POSL-', '').replaceAll('-', ''));
  assert.equal(codeNormalized('0'.repeat(48)), '0'.repeat(48));
  assert.equal(codeNormalized('invalid'), '');
  assert.equal(installationDigest('test-installation').length, 64);
  assert.equal(localBusinessIdNormalized(' A0000000-0000-4000-8000-000000000001 '), 'a0000000-0000-4000-8000-000000000001');
  assert.equal(localBusinessIdNormalized('biz-abc'), '');
  assert.equal(localBusinessIdNormalized('00000000-0000-0000-0000-000000000000'), '');
  assert.equal(localBusinessIdNormalized('bad\nid'), '');
  assert.equal(localBusinessDigest('a0000000-0000-4000-8000-000000000001'), localBusinessDigest('a0000000-0000-4000-8000-000000000001'));
  assert.notEqual(localBusinessDigest('a0000000-0000-4000-8000-000000000001'), localBusinessDigest('b0000000-0000-4000-8000-000000000002'));
});
