'use strict';

const {
  createHash, createHmac, randomBytes, sign, verify, createPublicKey, timingSafeEqual
} = require('node:crypto');
const { httpError } = require('../middleware/errors');

const b64url = value => Buffer.from(value).toString('base64url');
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const codeNormalized = value => {
  if (typeof value !== 'string' || value.length > 80) return '';
  const normalized = value.trim().toUpperCase().replace(/^POSL-/, '').replace(/[-\s]/g, '');
  return /^[A-F0-9]{48}$/.test(normalized) ? normalized : '';
};
const codeDisplay = bytes => 'POSL-' + bytes.toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
const installIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const challengeIdValid = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const signatureValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{86}$/.test(value);
const safeString = (value, max) => typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
const LEGACY_LOCAL_BUSINESS_ID = '00000000-0000-0000-0000-000000000000';
const hasControlCharacters = value => Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const localBusinessIdNormalized = value => {
  if (typeof value !== 'string' || value.length > 112 || hasControlCharacters(value)) return '';
  const normalized = value.trim().toLowerCase();
  return normalized && normalized.length <= 112 && normalized !== LEGACY_LOCAL_BUSINESS_ID && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized) ? normalized : '';
};
const localBusinessDigest = value => hash('pos-local-business-v1\0' + value);

function createLocalLicenseService(repo, config = {}, isSystemAdmin = () => false) {
  const enabled = config.enabled === true && Buffer.isBuffer(config.pepper) && config.pepper.length >= 32 && config.privateKey && config.keyId;
  const unavailable = () => { if (!enabled) throw httpError(503, 'LOCAL_LICENSE_NOT_CONFIGURED'); };
  const admin = auth => { if (!isSystemAdmin(auth)) throw httpError(403, 'SYSTEM_ADMIN_REQUIRED'); };
  const codeDigest = normalized => createHmac('sha256', config.pepper).update('pos-local-license-code-v1\0' + normalized).digest('hex');
  const rateDigest = (purpose, value) => createHmac('sha256', config.pepper).update('pos-local-license-rate-v1\0' + purpose + '\0' + value).digest('hex');
  const installationDigest = value => hash('pos-local-installation-v1\0' + value);

  function envelope(payload) {
    const body = b64url(JSON.stringify({ ...payload, keyId: config.keyId }));
    const signature = sign('sha256', Buffer.from(body), { key: config.privateKey, dsaEncoding: 'ieee-p1363' });
    return body + '.' + b64url(signature);
  }

  function parsePublicKey(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.kty !== 'EC' || value.crv !== 'P-256' ||
        !/^[A-Za-z0-9_-]{43}$/.test(value.x || '') || !/^[A-Za-z0-9_-]{43}$/.test(value.y || '') || Object.hasOwn(value, 'd')) {
      throw httpError(400, 'LOCAL_LICENSE_INVALID_REQUEST');
    }
    try { return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: value.x, y: value.y }, format: 'jwk' }); }
    catch { throw httpError(400, 'LOCAL_LICENSE_INVALID_REQUEST'); }
  }

  function publicKeyJson(key) {
    const jwk = key.export({ format: 'jwk' });
    return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  }

  function publicKeyHash(key) {
    const jwk = publicKeyJson(key);
    return hash(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
  }

  function verifyClientSignature(key, message, encodedSignature) {
    if (!signatureValid(encodedSignature)) return false;
    try { return verify('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(encodedSignature, 'base64url')); }
    catch { return false; }
  }

  async function consumeBucket(db, bucket, maximum, windowSeconds) {
    const bucketHash = rateDigest('attempts', bucket);
    await repo.rows(db, 'INSERT IGNORE INTO local_license_rate_limits (bucket_hash,attempts,window_started_at,updated_at) VALUES (?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [bucketHash]);
    const [row] = await repo.rows(db, 'SELECT attempts,window_started_at,(TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(3),DATE_ADD(window_started_at,INTERVAL ? SECOND))) AS retryAfter FROM local_license_rate_limits WHERE bucket_hash=? FOR UPDATE', [windowSeconds, bucketHash]);
    if (!row) throw httpError(503, 'LOCAL_LICENSE_UNAVAILABLE');
    if (Number(row.retryAfter) <= 0) {
      await repo.rows(db, 'UPDATE local_license_rate_limits SET attempts=1,window_started_at=UTC_TIMESTAMP(3),updated_at=UTC_TIMESTAMP(3) WHERE bucket_hash=?', [bucketHash]);
      return;
    }
    if (Number(row.attempts) >= maximum) throw Object.assign(httpError(429, 'LOCAL_LICENSE_RATE_LIMITED'), { retryAfter: Math.max(1, Number(row.retryAfter)) });
    await repo.rows(db, 'UPDATE local_license_rate_limits SET attempts=attempts+1,updated_at=UTC_TIMESTAMP(3) WHERE bucket_hash=?', [bucketHash]);
  }

  async function cleanRateData(db) {
    await repo.rows(db, 'DELETE FROM local_license_rate_limits WHERE updated_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY) LIMIT 100', []);
    await repo.rows(db, 'DELETE FROM local_license_challenges WHERE expires_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY) LIMIT 100', []);
  }

  async function commitRateLimits(entries) {
    // Keep counters committed even when the later activation/status transaction
    // rejects an invalid code or signature.
    for (const [bucket, maximum, windowSeconds] of entries) {
      await repo.transaction(db => consumeBucket(db, bucket, maximum, windowSeconds));
    }
  }

  async function challenge({ purpose, ipAddress }) {
    unavailable();
    if (!['ACTIVATE', 'STATUS'].includes(purpose)) throw httpError(400, 'LOCAL_LICENSE_INVALID_REQUEST');
    const challengeId = randomBytes(16).toString('hex');
    const challengeValue = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await repo.transaction(async db => {
      await cleanRateData(db);
      const ipLimit = purpose === 'ACTIVATE' ? 15 : 120;
      await consumeBucket(db, 'challenge:' + purpose + ':ip:' + String(ipAddress || 'unknown').slice(0, 64), ipLimit, 900);
      await repo.rows(db, 'INSERT INTO local_license_challenges (challenge_id,challenge_hash,purpose,expires_at) VALUES (?,?,?,?)', [challengeId, hash(challengeValue), purpose, expiresAt]);
    });
    return { challengeId, challenge: challengeValue, expiresAt: expiresAt.toISOString() };
  }

  async function consumeChallenge(db, id, value, purpose) {
    if (!challengeIdValid(id) || typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw httpError(400, 'LOCAL_LICENSE_UNAVAILABLE');
    const [row] = await repo.rows(db, 'SELECT challenge_hash,purpose,expires_at,used_at FROM local_license_challenges WHERE challenge_id=? FOR UPDATE', [id]);
    const supplied = Buffer.from(hash(value), 'hex');
    const expected = row ? Buffer.from(row.challenge_hash, 'hex') : Buffer.alloc(32);
    const matches = timingSafeEqual(supplied, expected);
    if (!row || !matches || row.purpose !== purpose || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) throw httpError(400, 'LOCAL_LICENSE_UNAVAILABLE');
    await repo.rows(db, 'UPDATE local_license_challenges SET used_at=UTC_TIMESTAMP(3) WHERE challenge_id=? AND used_at IS NULL', [id]);
  }

  async function generate(auth, { customerName, customerReference }) {
    admin(auth); unavailable();
    const name = safeString(customerName, 160);
    const reference = customerReference == null ? null : safeString(customerReference, 120);
    if (name.length < 2 || (customerReference != null && !reference)) throw httpError(400, 'LOCAL_LICENSE_INVALID_CUSTOMER');
    const code = codeDisplay(randomBytes(24));
    const digest = codeDigest(codeNormalized(code));
    const license = await repo.transaction(async db => {
      const result = await repo.rows(db, 'INSERT INTO local_licenses (code_hash,customer_name,customer_reference,status,issued_by_user_id,issued_by_username,created_at) VALUES (?,?,?,\'PENDING\',?,?,UTC_TIMESTAMP(3))', [digest, name, reference, String(auth.user_id), auth.username]);
      const id = String(result.insertId);
      await repo.rows(db, 'INSERT INTO local_license_events (license_id,event_type,actor_user_id,actor_username,details,created_at) VALUES (?,\'ISSUED\',?,?,?,UTC_TIMESTAMP(3))', [id, String(auth.user_id), auth.username, JSON.stringify({ customerReference: reference })]);
      return { id, customerName: name, customerReference: reference, status: 'PENDING' };
    });
    return { license, code };
  }

  async function list(auth, requestedStatus = '') {
    admin(auth);
    if (requestedStatus && !['PENDING', 'ACTIVE', 'REVOKED'].includes(requestedStatus)) throw httpError(400, 'LOCAL_LICENSE_INVALID_REQUEST');
    const values = requestedStatus ? [requestedStatus] : [];
    const rows = await repo.rows(repo.pool, 'SELECT id,customer_name AS customerName,customer_reference AS customerReference,status,created_at AS createdAt,activated_at AS activatedAt,revoked_at AS revokedAt,transfer_count AS transferCount FROM local_licenses ' + (requestedStatus ? 'WHERE status=? ' : '') + 'ORDER BY id DESC LIMIT 200', values);
    const [summary] = await repo.rows(repo.pool, "SELECT COUNT(DISTINCT l.local_business_id_hash) AS activeBusinessCount FROM local_licenses l JOIN local_license_installations i ON i.license_id=l.id AND i.installation_hash=l.active_installation_hash AND i.local_business_id_hash=l.local_business_id_hash WHERE l.status='ACTIVE' AND l.activated_at IS NOT NULL AND l.revoked_at IS NULL AND l.active_installation_hash IS NOT NULL AND l.local_business_id_hash IS NOT NULL AND i.state='ACTIVE'", []);
    return {
      licenses: rows.map(row => ({ ...row, id: String(row.id), transferCount: Number(row.transferCount), createdAt: new Date(row.createdAt).toISOString(), activatedAt: row.activatedAt ? new Date(row.activatedAt).toISOString() : null, revokedAt: row.revokedAt ? new Date(row.revokedAt).toISOString() : null })),
      activeLocalBusinessCount: Number(summary?.activeBusinessCount || 0)
    };
  }

  async function revoke(auth, licenseId, reason) {
    admin(auth);
    const note = safeString(reason, 500);
    if (!/^\d{1,19}$/.test(String(licenseId)) || note.length < 10) throw httpError(400, 'LOCAL_LICENSE_REASON_REQUIRED');
    return repo.transaction(async db => {
      const [license] = await repo.rows(db, 'SELECT id,status,active_installation_hash FROM local_licenses WHERE id=? FOR UPDATE', [licenseId]);
      if (!license) throw httpError(404, 'LOCAL_LICENSE_NOT_FOUND');
      if (license.status === 'REVOKED') return { id: String(license.id), status: 'REVOKED' };
      if (license.active_installation_hash) await repo.rows(db, 'UPDATE local_license_installations SET state=\'REVOKED\',ended_at=UTC_TIMESTAMP(3) WHERE license_id=? AND installation_hash=? AND state=\'ACTIVE\'', [license.id, license.active_installation_hash]);
      await repo.rows(db, 'UPDATE local_licenses SET status=\'REVOKED\',revoked_at=UTC_TIMESTAMP(3),revoked_by_user_id=?,revocation_reason=? WHERE id=?', [String(auth.user_id), note, license.id]);
      await repo.rows(db, 'INSERT INTO local_license_events (license_id,event_type,actor_user_id,actor_username,reason,details,created_at) VALUES (?,\'REVOKED\',?,?,?,?,UTC_TIMESTAMP(3))', [license.id, String(auth.user_id), auth.username, note, JSON.stringify({ installationHash: license.active_installation_hash })]);
      return { id: String(license.id), status: 'REVOKED' };
    });
  }

  async function transfer(auth, licenseId, reason) {
    admin(auth);
    const note = reason == null ? null : (safeString(reason, 500) || null);
    if (!/^\d{1,19}$/.test(String(licenseId))) throw httpError(400, 'LOCAL_LICENSE_INVALID_REQUEST');
    return repo.transaction(async db => {
      const [license] = await repo.rows(db, 'SELECT id,status,active_installation_hash,local_business_id_hash,transfer_count FROM local_licenses WHERE id=? FOR UPDATE', [licenseId]);
      if (!license) throw httpError(404, 'LOCAL_LICENSE_NOT_FOUND');
      if (license.status !== 'ACTIVE' || !license.active_installation_hash) throw httpError(409, 'LOCAL_LICENSE_TRANSFER_UNAVAILABLE');
      const oldHash = license.active_installation_hash;
      await repo.rows(db, 'UPDATE local_license_installations SET state=\'TRANSFERRED\',ended_at=UTC_TIMESTAMP(3) WHERE license_id=? AND installation_hash=? AND state=\'ACTIVE\'', [license.id, oldHash]);
      await repo.rows(db, 'UPDATE local_licenses SET status=\'PENDING\',active_installation_hash=NULL,active_public_key=NULL,transfer_count=transfer_count+1 WHERE id=?', [license.id]);
      await repo.rows(db, 'INSERT INTO local_license_events (license_id,event_type,actor_user_id,actor_username,reason,details,created_at) VALUES (?,\'TRANSFERRED\',?,?,?,?,UTC_TIMESTAMP(3))', [license.id, String(auth.user_id), auth.username, note, JSON.stringify({ previousInstallationHash: oldHash, previousBusinessIdentityHash: license.local_business_id_hash || null })]);
      return { id: String(license.id), status: 'PENDING', transferCount: Number(license.transfer_count) + 1 };
    });
  }

  async function activate(input, ipAddress) {
    unavailable();
    const normalizedCode = codeNormalized(input?.licenseCode);
    const installationId = input?.installationId;
    const hasBusinessId = Object.hasOwn(input || {}, 'localBusinessId');
    const businessId = hasBusinessId ? localBusinessIdNormalized(input.localBusinessId) : '';
    const businessHash = businessId ? localBusinessDigest(businessId) : null;
    const publicKey = parsePublicKey(input?.publicKey);
    const installHash = installIdValid(installationId) ? installationDigest(installationId) : hash('invalid-installation');
    const pubHash = publicKeyHash(publicKey);
    const requestValid = Boolean(normalizedCode && installIdValid(installationId) && (!hasBusinessId || businessId) && challengeIdValid(input?.challengeId) && typeof input?.challenge === 'string' && signatureValid(input?.signature));
    const suppliedDigest = codeDigest(normalizedCode || safeString(input?.licenseCode, 80).toUpperCase());
    await commitRateLimits([
      ['ip:' + String(ipAddress || 'unknown').slice(0, 64), 15, 900],
      ['code:' + suppliedDigest, 8, 900]
    ]);
    return repo.transaction(async db => {
      if (!requestValid) throw httpError(400, 'LOCAL_LICENSE_UNAVAILABLE');
      await consumeChallenge(db, input.challengeId, input.challenge, 'ACTIVATE');
      const canonical = hasBusinessId
        ? ['POS_LOCAL_LICENSE_ACTIVATE_V2', input.challengeId, input.challenge, normalizedCode, installationId, businessId, pubHash].join('\n')
        : ['POS_LOCAL_LICENSE_ACTIVATE_V1', input.challengeId, input.challenge, normalizedCode, installationId, pubHash].join('\n');
      if (!verifyClientSignature(publicKey, canonical, input.signature)) throw httpError(400, 'LOCAL_LICENSE_UNAVAILABLE');
      const [license] = await repo.rows(db, 'SELECT id,status,active_installation_hash,active_public_key,local_business_id_hash,transfer_count FROM local_licenses WHERE code_hash=? FOR UPDATE', [suppliedDigest]);
      if (!license || license.status === 'REVOKED') throw httpError(400, 'LOCAL_LICENSE_UNAVAILABLE');
      const currentHash = license.active_installation_hash;
      const [knownInstallation] = await repo.rows(db, 'SELECT state,local_business_id_hash FROM local_license_installations WHERE license_id=? AND installation_hash=? FOR UPDATE', [license.id, installHash]);
      if (license.status === 'ACTIVE') {
        let storedHash = '';
        if (license.active_public_key) {
          try { storedHash = publicKeyHash(parsePublicKey(typeof license.active_public_key === 'string' ? JSON.parse(license.active_public_key) : license.active_public_key)); } catch { storedHash = ''; }
        }
        if (currentHash !== installHash || storedHash !== pubHash || !knownInstallation || knownInstallation.state !== 'ACTIVE') throw httpError(400, 'LOCAL_LICENSE_UNAVAILABLE');
        const knownHashes = [license.local_business_id_hash, knownInstallation.local_business_id_hash].filter(Boolean);
        if (new Set(knownHashes).size > 1 || (businessHash && knownHashes.length && knownHashes[0] !== businessHash)) throw httpError(400, 'LOCAL_LICENSE_UNAVAILABLE');
        const boundHash = knownHashes[0] || businessHash;
        let newlyBound = false;
        if (boundHash) {
          if (!license.local_business_id_hash) {
            await repo.rows(db, 'UPDATE local_licenses SET local_business_id_hash=? WHERE id=? AND local_business_id_hash IS NULL', [boundHash, license.id]);
            newlyBound = true;
          }
          if (!knownInstallation.local_business_id_hash) {
            await repo.rows(db, 'UPDATE local_license_installations SET local_business_id_hash=? WHERE license_id=? AND installation_hash=? AND local_business_id_hash IS NULL', [boundHash, license.id, installHash]);
            newlyBound = true;
          }
        }
        if (newlyBound) await repo.rows(db, 'INSERT INTO local_license_events (license_id,event_type,details,created_at) VALUES (?,\'STATUS_CHECKED\',?,UTC_TIMESTAMP(3))', [license.id, JSON.stringify({ businessIdentityBound: true, source: 'activation' })]);
      } else {
        const allowIdentityRebind = Number(license.transfer_count) > 0;
        if (businessHash && license.local_business_id_hash && license.local_business_id_hash !== businessHash && !allowIdentityRebind) throw httpError(400, 'LOCAL_LICENSE_UNAVAILABLE');
        if (businessHash && knownInstallation?.local_business_id_hash && knownInstallation.local_business_id_hash !== businessHash && !allowIdentityRebind) throw httpError(400, 'LOCAL_LICENSE_UNAVAILABLE');
        const boundHash = allowIdentityRebind && businessHash ? businessHash : (businessHash || license.local_business_id_hash || knownInstallation?.local_business_id_hash || null);
        await repo.rows(db, 'UPDATE local_licenses SET status=\'ACTIVE\',active_installation_hash=?,active_public_key=?,local_business_id_hash=?,activated_at=UTC_TIMESTAMP(3) WHERE id=? AND status=\'PENDING\'', [installHash, JSON.stringify(publicKeyJson(publicKey)), boundHash, license.id]);
        await repo.rows(db, 'INSERT INTO local_license_installations (license_id,installation_hash,local_business_id_hash,public_key,public_key_hash,state,activated_at,last_seen_at) VALUES (?,?,?,?,?,\'ACTIVE\',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE local_business_id_hash=VALUES(local_business_id_hash),public_key=VALUES(public_key),public_key_hash=VALUES(public_key_hash),state=\'ACTIVE\',activated_at=UTC_TIMESTAMP(3),last_seen_at=UTC_TIMESTAMP(3),ended_at=NULL', [license.id, installHash, boundHash, JSON.stringify(publicKeyJson(publicKey)), pubHash]);
        await repo.rows(db, 'INSERT INTO local_license_events (license_id,event_type,details,created_at) VALUES (?,\'ACTIVATED\',?,UTC_TIMESTAMP(3))', [license.id, JSON.stringify({ installationHash: installHash, businessIdentityBound: Boolean(boundHash), businessIdentityRebound: Boolean(allowIdentityRebind && license.local_business_id_hash && businessHash && license.local_business_id_hash !== businessHash) })]);
      }
      const permit = envelope({ type: 'POS_LOCAL_LICENSE', version: 1, licenseId: String(license.id), installationHash: installHash, issuedAt: new Date().toISOString(), permanent: true });
      return { permit, licenseId: String(license.id), status: 'ACTIVE' };
    });
  }

  async function status(input, ipAddress) {
    unavailable();
    const installationId = input?.installationId;
    const licenseId = String(input?.licenseId || '');
    const hasBusinessId = Object.hasOwn(input || {}, 'localBusinessId');
    const businessId = hasBusinessId ? localBusinessIdNormalized(input.localBusinessId) : '';
    const businessHash = businessId ? localBusinessDigest(businessId) : null;
    const requestValid = /^[1-9]\d{0,19}$/.test(licenseId) && installIdValid(installationId) && (!hasBusinessId || businessId) && challengeIdValid(input?.challengeId) && typeof input?.challenge === 'string' && signatureValid(input?.signature);
    const installHash = installIdValid(installationId) ? installationDigest(installationId) : hash('invalid-installation');
    await commitRateLimits([
      ['ip:' + String(ipAddress || 'unknown').slice(0, 64), 120, 900],
      ['installation:' + installHash, 60, 900]
    ]);
    return repo.transaction(async db => {
      if (!requestValid) throw httpError(400, 'LOCAL_LICENSE_UNAVAILABLE');
      await consumeChallenge(db, input.challengeId, input.challenge, 'STATUS');
      const [license] = await repo.rows(db, 'SELECT id,status,active_installation_hash,local_business_id_hash FROM local_licenses WHERE id=? FOR UPDATE', [licenseId]);
      const [installation] = await repo.rows(db, 'SELECT public_key,state,local_business_id_hash FROM local_license_installations WHERE license_id=? AND installation_hash=? FOR UPDATE', [licenseId, installHash]);
      if (!license || !installation) throw httpError(400, 'LOCAL_LICENSE_UNAVAILABLE');
      let publicKey;
      try { publicKey = parsePublicKey(typeof installation.public_key === 'string' ? JSON.parse(installation.public_key) : installation.public_key); }
      catch { throw httpError(503, 'LOCAL_LICENSE_UNAVAILABLE'); }
      const canonical = hasBusinessId
        ? ['POS_LOCAL_LICENSE_STATUS_V2', input.challengeId, input.challenge, licenseId, installationId, businessId].join('\n')
        : ['POS_LOCAL_LICENSE_STATUS_V1', input.challengeId, input.challenge, licenseId, installationId].join('\n');
      if (!verifyClientSignature(publicKey, canonical, input.signature)) throw httpError(400, 'LOCAL_LICENSE_UNAVAILABLE');
      let currentStatus = 'ACTIVE';
      if (license.status === 'REVOKED' || installation.state === 'REVOKED') currentStatus = 'REVOKED';
      else if (license.status !== 'ACTIVE' || license.active_installation_hash !== installHash || installation.state !== 'ACTIVE') currentStatus = 'TRANSFERRED';
      const knownHashes = [license.local_business_id_hash, installation.local_business_id_hash].filter(Boolean);
      if (currentStatus === 'ACTIVE' && (new Set(knownHashes).size > 1 || (businessHash && knownHashes.length && knownHashes[0] !== businessHash))) throw httpError(400, 'LOCAL_LICENSE_UNAVAILABLE');
      const boundHash = currentStatus === 'ACTIVE' ? (knownHashes[0] || businessHash) : null;
      let newlyBound = false;
      if (boundHash) {
        if (!license.local_business_id_hash) {
          await repo.rows(db, 'UPDATE local_licenses SET local_business_id_hash=? WHERE id=? AND local_business_id_hash IS NULL', [boundHash, licenseId]);
          newlyBound = true;
        }
        if (!installation.local_business_id_hash) {
          await repo.rows(db, 'UPDATE local_license_installations SET local_business_id_hash=? WHERE license_id=? AND installation_hash=? AND local_business_id_hash IS NULL', [boundHash, licenseId, installHash]);
          newlyBound = true;
        }
      }
      await repo.rows(db, 'UPDATE local_license_installations SET last_seen_at=UTC_TIMESTAMP(3) WHERE license_id=? AND installation_hash=?', [licenseId, installHash]);
      if (newlyBound) await repo.rows(db, 'INSERT INTO local_license_events (license_id,event_type,details,created_at) VALUES (?,\'STATUS_CHECKED\',?,UTC_TIMESTAMP(3))', [licenseId, JSON.stringify({ status: currentStatus, businessIdentityBound: true })]);
      const signedStatus = envelope({ type: 'POS_LOCAL_LICENSE_STATUS', version: 1, licenseId, installationHash: installHash, status: currentStatus, checkedAt: new Date().toISOString() });
      return { signedStatus, status: currentStatus };
    });
  }

  return Object.freeze({ enabled, admin: Object.freeze({ generate, list, revoke, transfer }), public: Object.freeze({ challenge, activate, status }) });
}

module.exports = { createLocalLicenseService, codeNormalized, codeDisplay, installationDigest: value => hash('pos-local-installation-v1\0' + value), localBusinessIdNormalized, localBusinessDigest };
