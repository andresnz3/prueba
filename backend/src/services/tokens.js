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
module.exports = { randomToken, hashToken, equal, loginCsrf, validLoginCsrf, sessionCsrf, cookies };
