'use strict';
const { HttpError } = require('../utils/errors');

/**
 * Ownership gate. A session that does not exist and a session that belongs to
 * someone else produce the same 404, so IDs cannot be probed.
 */
function assertOwner(sessionService, req) {
  const owner = sessionService.ownerOf(req.params.sessionId);
  if (owner === undefined || owner !== req.user.id) {
    throw new HttpError(404, 'not_found', 'session not found');
  }
}

module.exports = { assertOwner };
