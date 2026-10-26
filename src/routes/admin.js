'use strict';
const express = require('express');
const { safeEqualStrings } = require('../utils/crypto');

/**
 * Read-only audit trail. Disabled (404) unless ADMIN_TOKEN is configured, so a
 * default deployment exposes no attempt history. Auth/roles for learners are
 * out of scope for this problem statement; this is only a minimal gate.
 */
function adminRouter({ flagService, config }) {
  const router = express.Router();

  router.get('/attempts', (req, res) => {
    if (!config.adminToken) return res.status(404).json({ error: 'not_found' });
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!m || !safeEqualStrings(m[1], config.adminToken)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    res.json({ attempts: flagService.getAttempts(sessionId, req.query.limit) });
  });

  return router;
}

module.exports = { adminRouter };
