'use strict';
const express = require('express');
const { assertOwner } = require('./owned');

/** Every route here runs behind requireAuth, and every :sessionId route behind assertOwner. */
function sessionsRouter({ sessionService, config }) {
  const router = express.Router();
  const guard = (fn) => async (req, res, next) => {
    try {
      if (req.params.sessionId) assertOwner(sessionService, req);
      await fn(req, res);
    } catch (err) { next(err); }
  };

  // My labs, newest first.
  router.get('/', guard(async (req, res) => {
    res.json({ sessions: sessionService.listSessions(req.user.id) });
  }));

  // Start a lab: generates flags, provisions the target, returns NO flag values.
  router.post('/', guard(async (req, res) => {
    res.status(201).json(await sessionService.createSession({ userId: req.user.id }));
  }));

  // Status and progress (never flag values or hashes).
  router.get('/:sessionId', guard(async (req, res) => {
    res.json(sessionService.getSession(req.params.sessionId));
  }));

  // My submission history for this lab.
  router.get('/:sessionId/attempts', guard(async (req, res) => {
    res.json({ attempts: sessionService.attemptHistory(req.params.sessionId) });
  }));

  // Teardown: invalidates flags, removes the container, keeps the audit trail.
  router.delete('/:sessionId', guard(async (req, res) => {
    res.json(await sessionService.terminate(req.params.sessionId));
  }));

  // DEMO MODE ONLY: reads the flags back from the container so a presenter can compare sessions.
  router.get('/:sessionId/reveal', guard(async (req, res) => {
    if (!config.demoMode) return res.status(404).json({ error: 'not_found' });
    res.set('Cache-Control', 'no-store');
    res.json(await sessionService.revealFlags(req.params.sessionId));
  }));

  return router;
}

module.exports = { sessionsRouter };
