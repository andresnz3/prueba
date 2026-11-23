'use strict';
const { randomBytes, createHash, createHmac, timingSafeEqual } = require('node:crypto');
const randomToken = () => randomBytes(32).toString('base64url');
const hashToken = value => createHash('sha256').update(value).digest('hex');
const sign = (secret, value) => createHmac('sha256', secret).update(value).digest('base64url');
function equal(a, b) { return typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function loginCsrf(secret, now = Date.now()) { const body = randomToken() + '.' + now; return body + '.' + sign(secret, 'login:' + body); }
function validLoginCsrf(secret, value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 200) return false;
  const parts = value.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]{43}$/.test(parts[0]) || !/^\d{13}$/.test(parts[1])) return false;
  const age = now - Number(parts[1]);
  return age >= 0 && age <= 600000 && equal(parts[2], sign(secret, 'login:' + parts[0] + '.' + parts[1]));
}
const sessionCsrf = (secret, tokenHash) => sign(secret, 'session:' + tokenHash);
function createSupportToken(secret, auth, businessId, supportSession, expiresAt) {
  const expiration = expiresAt instanceof Date ? expiresAt.getTime() : Number(expiresAt);
  if (!Number.isSafeInteger(expiration) || expiration <= Date.now()) throw new TypeError('Invalid support-session expiration');
  const body = [auth.session_id, auth.user_id, auth.business_id, businessId, supportSession.session_id, supportSession.token_hash, expiration].map(String).join('.');
  return body + '.' + sign(secret, 'support:' + body);
}
function verifySupportToken(secret, value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 256) return null;
  const parts = value.split('.');
  if (parts.length !== 8 || parts.slice(0, 5).some(part => !/^[1-9]\d{0,19}$/.test(part)) || !/^[a-f0-9]{64}$/.test(parts[5]) || !/^\d{13}$/.test(parts[6]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[7])) return null;
  const body = parts.slice(0, 7).join('.');
  const expiresAt = Number(parts[6]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 15 * 60 * 1000 + 5000 || !equal(parts[7], sign(secret, 'support:' + body))) return null;
  return { ownerSessionId: parts[0], ownerUserId: parts[1], ownerBusinessId: parts[2], businessId: parts[3], supportSessionId: parts[4], supportTokenHash: parts[5], expiresAt };
}
function cookies(req) {
  const result = Object.create(null);
  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('='); if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (Object.hasOwn(result, name)) return Object.create(null);
    try { result[name] = decodeURIComponent(part.slice(index + 1).trim()); } catch { return Object.create(null); }
  }
  return result;
}
module.exports = { randomToken, hashToken, equal, loginCsrf, validLoginCsrf, sessionCsrf, createSupportToken, verifySupportToken, cookies };
