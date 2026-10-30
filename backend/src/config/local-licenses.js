'use strict';

const { createPrivateKey } = require('node:crypto');

function readLocalLicenseConfig(env = process.env) {
  const pepper = typeof env.LOCAL_LICENSE_CODE_PEPPER === 'string' ? env.LOCAL_LICENSE_CODE_PEPPER.trim() : '';
  const keyId = typeof env.LOCAL_LICENSE_SIGNING_KEY_ID === 'string' ? env.LOCAL_LICENSE_SIGNING_KEY_ID.trim() : '';
  const privatePem = typeof env.LOCAL_LICENSE_SIGNING_PRIVATE_KEY === 'string' ? env.LOCAL_LICENSE_SIGNING_PRIVATE_KEY.replace(/\\n/g, '\n').trim() : '';
  if (!pepper && !keyId && !privatePem) return Object.freeze({ enabled: false });
  if (!/^[a-fA-F0-9]{64,128}$/.test(pepper) || !/^[A-Za-z0-9_.-]{1,40}$/.test(keyId) || !privatePem) return Object.freeze({ enabled: false });
  try {
    const privateKey = createPrivateKey(privatePem);
    const curve = privateKey.asymmetricKeyDetails?.namedCurve;
    if (privateKey.asymmetricKeyType !== 'ec' || !['prime256v1', 'P-256'].includes(curve)) return Object.freeze({ enabled: false });
    return Object.freeze({ enabled: true, pepper: Buffer.from(pepper, 'hex'), keyId, privateKey });
  } catch {
    return Object.freeze({ enabled: false });
  }
}

module.exports = { readLocalLicenseConfig };
