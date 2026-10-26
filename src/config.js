'use strict';
const os = require('os');
const path = require('path');
require('dotenv').config();

function toInt(raw, fallback, name, min = 1) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min} (got "${raw}")`);
  return n;
}

/**
 * Reads configuration from the environment. `overrides` (camelCase keys) win
 * over the environment, which keeps tests hermetic.
 */
function loadConfig(overrides = {}) {
  const env = process.env;
  const cfg = {
    port: toInt(env.PORT, 3000, 'PORT', 0),
    flagPepper: env.FLAG_PEPPER,
    sessionTtlMinutes: toInt(env.SESSION_TTL_MINUTES, 60, 'SESSION_TTL_MINUTES'),
    dbPath: env.DB_PATH || path.join(process.cwd(), 'data', 'flags.db'),
    dockerDriver: env.DOCKER_DRIVER || 'docker', // 'docker' | 'mock'
    dockerBin: env.DOCKER_BIN || 'docker',
    targetImage: env.TARGET_IMAGE || 'flag-lab-target:latest',
    stagingDir: env.STAGING_DIR || path.join(os.tmpdir(), 'flaglab-staging'),
    maxActiveSessions: toInt(env.MAX_ACTIVE_SESSIONS, 50, 'MAX_ACTIVE_SESSIONS'),
    sweepIntervalSeconds: toInt(env.SWEEP_INTERVAL_SECONDS, 30, 'SWEEP_INTERVAL_SECONDS'),
    adminToken: env.ADMIN_TOKEN || '',
    demoMode: /^(1|true|yes)$/i.test(env.DEMO_MODE || ''),
    cookieSecure: /^(1|true|yes)$/i.test(env.COOKIE_SECURE || ''),
    loginTtlHours: toInt(env.LOGIN_TTL_HOURS, 8, 'LOGIN_TTL_HOURS'),
    ...overrides,
  };

  if (typeof cfg.flagPepper !== 'string' || cfg.flagPepper.length < 32 || cfg.flagPepper.startsWith('change-me')) {
    throw new Error(
      'FLAG_PEPPER is missing or too weak. It must be a random secret of at least 32 characters.\n' +
        'Generate one with:  npm run init-env   (or: openssl rand -hex 32)'
    );
  }
  if (!['docker', 'mock'].includes(cfg.dockerDriver)) {
    throw new Error(`DOCKER_DRIVER must be "docker" or "mock" (got "${cfg.dockerDriver}")`);
  }
  return Object.freeze(cfg);
}

module.exports = { loadConfig };
