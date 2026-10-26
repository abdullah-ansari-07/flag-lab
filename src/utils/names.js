'use strict';

/** Deterministic container name for a session's target (ID is validated upstream). */
function containerNameFor(sessionId) {
  return `flaglab-target-${sessionId}`;
}

module.exports = { containerNameFor };
