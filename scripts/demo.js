#!/usr/bin/env node
'use strict';
/**
 * Runs the six demonstration scenarios from Problem Statement #3 and prints PASS/FAIL.
 * Two users (Alice and Bob) are registered, each starts their own lab, so the output also
 * shows that labs belong to the user who started them.
 *
 *   node scripts/demo.js          -> against a running server (BASE_URL, default http://localhost:3000)
 *                                    flags are read from the real containers with `docker exec`
 *   node scripts/demo.js --mock   -> self-contained: starts the app in-process with the mock
 *                                    Docker driver (no Docker needed)
 *
 * Set ADMIN_TOKEN (same value as the server's) to also print the audit trail at the end.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const MOCK = process.argv.includes('--mock');
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
};
const step = (title) => console.log(`\n== ${title}`);

async function setup() {
  if (!MOCK) {
    const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
    return {
      baseUrl,
      adminToken: process.env.ADMIN_TOKEN || '',
      readFlag: async (s, file) => (await execFileAsync('docker', ['exec', s.targetContainer, 'cat', `/root/${file}`])).stdout.trim(),
      containerExists: async (s) => execFileAsync('docker', ['inspect', s.targetContainer]).then(() => true, () => false),
      close: async () => {},
    };
  }
  const { loadConfig } = require('../src/config');
  const { openDb } = require('../src/db');
  const { createApp } = require('../src/app');
  const { createLogger } = require('../src/utils/logger');
  const { MockDockerDriver } = require('../src/mockDocker');
  const config = loadConfig({
    flagPepper: require('crypto').randomBytes(32).toString('hex'), dbPath: ':memory:', dockerDriver: 'mock', adminToken: 'demo-admin-token',
  });
  const docker = new MockDockerDriver({ stagingDir: config.stagingDir });
  const { app } = createApp({ config, db: openDb(':memory:'), docker, logger: createLogger({ silent: true }) });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    adminToken: 'demo-admin-token',
    readFlag: (s, file) => docker.readFile(s.sessionId, file),
    containerExists: async (s) => docker.has(s.sessionId),
    close: () => new Promise((r) => server.close(r)),
  };
}

async function main() {
  const env = await setup();
  // One client per user, each with its own cookie jar (like two separate browsers).
  const makeClient = () => {
    let cookie = '';
    return async (method, url, body) => {
      const headers = {};
      if (body) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(env.baseUrl + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.getSetCookie();
      if (sc.length) cookie = sc[0].split(';')[0];
      return { status: res.status, body: await res.json() };
    };
  };
  const suffix = Math.random().toString(36).slice(2, 8);
  const alice = makeClient();
  const bob = makeClient();
  const submit = (who, s, flagType, value) => who('POST', `/api/sessions/${s.sessionId}/flag`, { flagType, value });
  console.log(`Mode: ${MOCK ? 'mock Docker (in-process)' : 'real Docker'}  |  Server: ${env.baseUrl}`);

  step('Setup - two users sign up');
  const ra = await alice('POST', '/api/auth/register', { username: `alice_${suffix}`, password: 'demo-password-1' });
  const rb = await bob('POST', '/api/auth/register', { username: `bob_${suffix}`, password: 'demo-password-2' });
  check('Alice registered and signed in', ra.status === 201, ra.body.user && ra.body.user.username);
  check('Bob registered and signed in', rb.status === 201, rb.body.user && rb.body.user.username);
  check('sessions require a login', (await makeClient()('POST', '/api/sessions')).status === 401);

  step('Test 1 - two concurrent sessions (one per user) get different flags');
  const A = (await alice('POST', '/api/sessions')).body;
  const B = (await bob('POST', '/api/sessions')).body;
  console.log(`  Session A: ${A.sessionId}\n  Session B: ${B.sessionId}`);
  const fa = { user: await env.readFlag(A, 'user.txt'), root: await env.readFlag(A, 'root.txt') };
  const fb = { user: await env.readFlag(B, 'user.txt'), root: await env.readFlag(B, 'root.txt') };
  console.log(`  A /root/user.txt = ${fa.user}\n  A /root/root.txt = ${fa.root}`);
  console.log(`  B /root/user.txt = ${fb.user}\n  B /root/root.txt = ${fb.root}`);
  check('both sessions running', A.status === 'running' && B.status === 'running');
  check('user flags differ between sessions', fa.user !== fb.user);
  check('root flags differ between sessions', fa.root !== fb.root);
  check('create-session response contains no flag values', !JSON.stringify(A).includes(fa.root) && !JSON.stringify(A).includes(fa.user));

  step("Test 2 - Session A's correct flag, submitted to Session A");
  let r = await submit(alice, A, 'root', fa.root);
  check('accepted (200 success)', r.status === 200 && r.body.result === 'success', JSON.stringify(r.body));

  step("Test 3 - Session A's flag submitted to Session B (cross-session reuse)");
  r = await submit(bob, B, 'root', fa.root);
  check('rejected (403 incorrect)', r.status === 403 && r.body.result === 'incorrect', JSON.stringify(r.body));
  r = await submit(bob, B, 'user', fa.user);
  check('rejected for the user flag too', r.status === 403 && r.body.result === 'incorrect');
  r = await submit(bob, A, 'root', fa.root);
  check("Bob cannot submit to Alice's session at all (404)", r.status === 404, JSON.stringify(r.body));
  r = await bob('GET', `/api/sessions/${A.sessionId}`);
  check("Bob cannot even see Alice's session (404)", r.status === 404);
  r = await bob('DELETE', `/api/sessions/${A.sessionId}`);
  check("Bob cannot end Alice's session (404)", r.status === 404 && await env.containerExists(A));

  step('Test 4 - random incorrect flag');
  r = await submit(alice, A, 'user', 'LAB_USER{wrong-guess}');
  check('rejected (403 incorrect)', r.status === 403 && r.body.result === 'incorrect', JSON.stringify(r.body));

  step('Test 5 - replay of an already-solved flag');
  r = await submit(alice, A, 'root', fa.root);
  check('already_solved (409)', r.status === 409 && r.body.result === 'already_solved', JSON.stringify(r.body));

  step('Test 6 - terminate Session A, then submit its previously correct flag');
  r = await alice('DELETE', `/api/sessions/${A.sessionId}`);
  check('session terminated', r.status === 200 && r.body.status === 'terminated');
  check('target container removed', !(await env.containerExists(A)));
  check('other session untouched', await env.containerExists(B));
  r = await submit(alice, A, 'user', fa.user);
  check('expired (410 Gone)', r.status === 410 && r.body.result === 'expired', JSON.stringify(r.body));
  r = await submit(bob, B, 'root', fb.root);
  check("Session B's own flag still works", r.status === 200 && r.body.result === 'success');

  await bob('DELETE', `/api/sessions/${B.sessionId}`);

  if (env.adminToken) {
    step('Audit trail (flag_attempts, newest first; submissions are stored only as HMACs)');
    const res = await fetch(`${env.baseUrl}/api/admin/attempts?limit=50`, { headers: { Authorization: `Bearer ${env.adminToken}` } });
    if (res.ok) {
      for (const a of (await res.json()).attempts.reverse()) {
        const who = a.session_id === A.sessionId ? 'A' : a.session_id === B.sessionId ? 'B' : '?';
        console.log(`  ${a.timestamp}  session ${who}  user#${a.user_id}  ${String(a.flag_type).padEnd(4)}  ${a.result.padEnd(15)} ${a.submitted_hash.slice(0, 12)}...`);
      }
    } else console.log(`  (audit endpoint returned ${res.status}; check ADMIN_TOKEN)`);
  }

  await env.close();
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('demo failed:', err.message); process.exit(1); });
