'use strict';
const path = require('path');
const express = require('express');
const { FlagService } = require('./flagService');
const { SessionService } = require('./sessionService');
const { sessionsRouter } = require('./routes/sessions');
const { flagsRouter } = require('./routes/flags');
const { adminRouter } = require('./routes/admin');
const { authRouter } = require('./routes/auth');
const { AuthService } = require('./authService');
const { attachUser, requireAuth, sameOrigin } = require('./middleware/auth');

/** Wires services + routes. Everything is injected so tests can swap Docker, DB and clock. */
function createApp({ config, db, docker, logger, clock = () => new Date() }) {
  const flagService = new FlagService({ db, pepper: config.flagPepper, clock, logger });
  const sessionService = new SessionService({ db, flagService, docker, config, logger, clock });
  const authService = new AuthService({ db, clock, loginTtlHours: config.loginTtlHours, logger });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4kb' })); // submissions are tiny; refuse anything big

  app.use(sameOrigin);
  app.use(attachUser(authService));

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  // Public: lets the UI know whether demo mode is on and how long labs last.
  app.get('/api/meta', (req, res) => res.json({ demoMode: config.demoMode, sessionTtlMinutes: config.sessionTtlMinutes }));
  app.use('/api/auth', authRouter({ authService, config }));
  app.use('/api/sessions', requireAuth, sessionsRouter({ sessionService, config }));
  app.use('/api/sessions', requireAuth, flagsRouter({ sessionService, flagService }));
  app.use('/api/admin', adminRouter({ flagService, config }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if (err.status && err.code) return res.status(err.status).json({ error: err.code, message: err.message });
    logger.error('unhandled_error', { error: err.message });
    res.status(500).json({ error: 'internal_error' });
  });

  return { app, flagService, sessionService, authService };
}

module.exports = { createApp };
