'use strict';
const { HttpError } = require('../utils/errors');

const COOKIE_NAME = 'flaglab_session';

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const cookieOptions = (config) => ({
  httpOnly: true,            // JavaScript on the page cannot read the token (limits XSS impact)
  sameSite: 'strict',        // browsers do not send it on cross-site requests (CSRF defence)
  secure: config.cookieSecure,
  path: '/',
});

/** Sets req.user when a valid login cookie is present. Never rejects by itself. */
function attachUser(authService) {
  return (req, res, next) => {
    try {
      const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
      req.authToken = token;
      req.user = token ? authService.authenticate(token) : null;
    } catch {
      req.user = null;
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'unauthenticated', 'sign in to continue'));
  next();
}

/**
 * Defence in depth on top of SameSite=Strict: a state-changing request from a
 * browser carries an Origin header; if it does not match this host, refuse it.
 * Non-browser clients (curl, the demo script) send no Origin and pass.
 */
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.get('host'); } catch { ok = false; }
    if (!ok) return next(new HttpError(403, 'cross_origin', 'cross-origin requests are not allowed'));
  }
  next();
}

module.exports = { COOKIE_NAME, parseCookies, cookieOptions, attachUser, requireAuth, sameOrigin };
