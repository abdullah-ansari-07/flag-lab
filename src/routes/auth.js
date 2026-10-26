'use strict';
const express = require('express');
const { COOKIE_NAME, cookieOptions } = require('../middleware/auth');
const { HttpError } = require('../utils/errors');

function authRouter({ authService, config }) {
  const router = express.Router();
  const opts = cookieOptions(config);

  const startSession = async (res, username, password, ip, status) => {
    const { token, expiresAt, user } = await authService.login(username, password, ip);
    res.cookie(COOKIE_NAME, token, { ...opts, maxAge: config.loginTtlHours * 3600_000 });
    res.status(status).json({ user, expiresAt });
  };

  // Registering also signs the new user in.
  router.post('/register', async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      await authService.register(username, password);
      await startSession(res, username, password, req.ip, 201);
    } catch (err) { next(err); }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      await startSession(res, username, password, req.ip, 200);
    } catch (err) { next(err); }
  });

  router.post('/logout', (req, res) => {
    authService.logout(req.authToken);
    res.clearCookie(COOKIE_NAME, opts);
    res.json({ ok: true });
  });

  router.get('/me', (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'unauthenticated', 'sign in to continue'));
    res.json({ user: req.user });
  });

  return router;
}

module.exports = { authRouter };
