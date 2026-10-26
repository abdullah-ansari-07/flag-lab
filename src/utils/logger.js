'use strict';

/**
 * Minimal structured logger. Callers only ever pass identifiers and result
 * codes -- never flag values -- and tests assert that no plaintext flag shows
 * up in anything written through here.
 */
function createLogger({ silent = false, sink = (line) => console.log(line) } = {}) {
  const write = (level, event, fields) => {
    if (silent) return;
    sink(JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }));
  };
  return {
    info: (event, fields = {}) => write('info', event, fields),
    warn: (event, fields = {}) => write('warn', event, fields),
    error: (event, fields = {}) => write('error', event, fields),
  };
}

module.exports = { createLogger };
