'use strict';
function readAuthConfig(env = process.env) {
  const secret = env.CSRF_SECRET;
  if (typeof secret !== 'string' || !/^[a-fA-F0-9]{64,128}$/.test(secret)) throw new Error('Configuracion invalida: CSRF_SECRET');
  const production = env.NODE_ENV === 'production';
  const sameSite = (env.COOKIE_SAME_SITE || 'lax').toLowerCase();
  if (!['lax', 'strict', 'none'].includes(sameSite) || (sameSite === 'none' && !production)) throw new Error('Configuracion invalida: COOKIE_SAME_SITE');
  function seconds(key, fallback, min, max) {
    const raw = env[key] === undefined ? String(fallback) : env[key];
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error('Configuracion invalida: ' + key);
    return Number(raw);
  }
  const sessionSeconds = seconds('SESSION_TTL_SECONDS', 1800, 60, 86400);
  const absoluteSeconds = seconds('SESSION_MAX_SECONDS', 28800, 60, 604800);
  if (absoluteSeconds < sessionSeconds) throw new Error('SESSION_MAX_SECONDS debe superar SESSION_TTL_SECONDS');
  const rateMax = seconds('AUTH_RATE_MAX', 10, 3, 100);
  return { secret, production, sameSite, sessionSeconds, absoluteSeconds,
    grantSeconds: seconds('AUTHORIZATION_TTL_SECONDS', 300, 30, 900),
    supportCookieName: production ? '__Host-pos_support_session' : 'pos_support_session',
    rateWindowSeconds: seconds('AUTH_RATE_WINDOW_SECONDS', 900, 60, 3600),
    rateMax,
    loginRateMax: seconds('AUTH_LOGIN_IP_MAX', rateMax * 5, 10, 1000),
    reauthRateWindowSeconds: seconds('AUTH_REAUTH_WINDOW_SECONDS', 900, 60, 3600),
    reauthSessionRateMax: seconds('AUTH_REAUTH_SESSION_MAX', 10, 3, 100),
    reauthUserRateMax: seconds('AUTH_REAUTH_USER_MAX', 50, 10, 1000),
    reauthIpRateMax: seconds('AUTH_REAUTH_IP_MAX', 100, 10, 1000),
    cookieName: production ? '__Host-pos_session' : 'pos_session',
    preCookieName: production ? '__Host-pos_login_csrf' : 'pos_login_csrf' };
}
module.exports = { readAuthConfig };
