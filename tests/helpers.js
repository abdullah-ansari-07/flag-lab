'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { createLogger } = require('../src/utils/logger');
const { MockDockerDriver } = require('../src/mockDocker');

/** Fully wired app with in-memory DB, mock Docker and a controllable clock. */
function buildContext({ config = {}, dbPath = ':memory:' } = {}) {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flaglab-test-'));
  const cfg = loadConfig({
    flagPepper: 'test-pepper-'.repeat(5),
    dbPath,
    dockerDriver: 'mock',
    stagingDir,
    sessionTtlMinutes: 60,
    maxActiveSessions: 50,
    adminToken: 'test-admin-token',
    ...config,
  });

  let current = new Date('2026-09-20T10:00:00.000Z');
  const clock = () => new Date(current.getTime());
  const advanceMinutes = (m) => { current = new Date(current.getTime() + m * 60_000); };

  const logLines = [];
  const logger = createLogger({ sink: (l) => logLines.push(l) });
  const db = openDb(cfg.dbPath);
  const docker = new MockDockerDriver({ stagingDir });
  const { app, sessionService, flagService, authService } = createApp({ config: cfg, db, docker, logger, clock });

  const readFlags = async (sessionId) => ({
    user: await docker.readFile(sessionId, 'user.txt'),
    root: await docker.readFile(sessionId, 'root.txt'),
  });

  const listen = () =>
    new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => {
        resolve({ baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
      });
    });

  const dumpDb = () => {
    const out = [];
    for (const t of ['sessions', 'flags', 'flag_attempts']) out.push(JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()));
    return out.join('\n');
  };

  const dispose = () => {
    try { db.close(); } catch { /* already closed */ }
    fs.rmSync(stagingDir, { recursive: true, force: true });
  };

  return { cfg, db, docker, app, sessionService, flagService, authService, clock, advanceMinutes, logLines, readFlags, listen, dumpDb, dispose, stagingDir };
}

/** Tiny HTTP client with a cookie jar, so each instance behaves like one browser. */
function client(baseUrl) {
  let cookie = '';
  const request = async (method, url, body, headers = {}) => {
    const h = { ...headers };
    if (cookie) h.Cookie = cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(baseUrl + url, {
      method, headers: h,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie();
    if (setCookie.length) {
      const pair = setCookie[0].split(';')[0];
      cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON (e.g. HTML) */ }
    return { status: res.status, body: json, text, setCookie };
  };
  const register = (username, password = 'correct-horse-battery') => request('POST', '/api/auth/register', { username, password });
  return { request, register, get cookie() { return cookie; } };
}

module.exports = { buildContext, client };
