'use strict';
const argon2 = require('argon2');
const { randomBytes } = require('node:crypto');
const options = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const hashPassword = password => argon2.hash(password, options);
async function verifyPassword(hash, password) {
  if (typeof hash !== 'string' || !hash.startsWith('$argon2id$')) return false;
  try { return await argon2.verify(hash, password); } catch { return false; }
}
let dummy;
async function verifyOrDummy(hash, password) {
  dummy ||= hashPassword(randomBytes(32).toString('hex'));
  return verifyPassword(hash || await dummy, password);
}
module.exports = { hashPassword, verifyPassword, verifyOrDummy };
