'use strict';
const express = require('express');

function flagsRouter({ sessionService, flagService }) {
  const router = express.Router();

  // Validation is always scoped to the session in the URL AND to its owner.
  router.post('/:sessionId/flag', async (req, res, next) => {
    try {
      const { flagType, value } = req.body || {};
      const args = { sessionId: req.params.sessionId, flagType, value, sourceIp: req.ip, userId: req.user.id };
      const owner = sessionService.ownerOf(args.sessionId);
      // Not yours (or not real): refuse, but still record the attempt in the audit trail.
      const out = owner === req.user.id ? await sessionService.submitFlag(args) : flagService.reject(args);
      res.status(out.httpStatus).json(out.body);
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { flagsRouter };
