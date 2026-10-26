'use strict';
// Real-Docker integration tests. Skipped automatically when Docker is unavailable.
// Run with:  npm run test:integration
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../../src/config');
const { openDb } = require('../../src/db');
const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/utils/logger');
const { DockerDriver } = require('../../src/dockerService');

const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const IMAGE = 'flag-lab-target:itest';
const sh = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const exists = (name) => spawnSync('docker', ['inspect', name], { stdio: 'ignore' }).status === 0;

test('real Docker: per-session flags are injected, validated and cleaned up', { skip: !dockerOk && 'Docker is not available' }, async (t) => {
  sh('build', '-t', IMAGE, path.join(__dirname, '..', '..', 'target'));

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flaglab-itest-'));
  const config = loadConfig({
    flagPepper: 'integration-pepper-'.repeat(3), dbPath: ':memory:', stagingDir, targetImage: IMAGE,
  });
  const logger = createLogger({ silent: true });
  const db = openDb(':memory:');
  const docker = new DockerDriver({ image: IMAGE, stagingDir, logger });
  await docker.preflight();
  const { sessionService } = createApp({ config, db, docker, logger });
  const created = [];
  t.after(async () => {
    for (const s of created) await sessionService.terminate(s).catch(() => {});
    fs.rmSync(stagingDir, { recursive: true, force: true });
  });

  // The image itself must be flag-free.
  const imageFs = sh('run', '--rm', '--entrypoint', 'sh', IMAGE, '-c', 'ls -A /root');
  assert.equal(imageFs, '', 'image must not contain baked-in flag files');

  const a = await sessionService.createSession(); created.push(a.sessionId);
  const b = await sessionService.createSession(); created.push(b.sessionId);
  const read = (s, f) => sh('exec', a.sessionId === s ? a.targetContainer : b.targetContainer, 'cat', `/root/${f}`);

  const fa = { user: read(a.sessionId, 'user.txt'), root: read(a.sessionId, 'root.txt') };
  const fb = { user: read(b.sessionId, 'user.txt'), root: read(b.sessionId, 'root.txt') };
  assert.match(fa.root, /^LAB_ROOT\{[0-9a-f]{32}\}$/);
  assert.notEqual(fa.root, fb.root);
  assert.notEqual(fa.user, fb.user);

  // Flags must not be visible through `docker inspect` (that is why we avoid env vars).
  assert.ok(!sh('inspect', a.targetContainer).includes(fa.root.slice(10, -1)));
  // Staging copy on the host is gone.
  assert.deepEqual(fs.readdirSync(stagingDir), []);

  assert.equal((await sessionService.submitFlag({ sessionId: a.sessionId, flagType: 'root', value: fa.root })).body.result, 'success');
  assert.equal((await sessionService.submitFlag({ sessionId: b.sessionId, flagType: 'root', value: fa.root })).body.result, 'incorrect');
  assert.equal((await sessionService.submitFlag({ sessionId: a.sessionId, flagType: 'root', value: fa.root })).body.result, 'already_solved');

  await sessionService.terminate(a.sessionId);
  assert.equal(exists(a.targetContainer), false, 'container must be removed on teardown');
  assert.equal(exists(b.targetContainer), true, 'other sessions must be unaffected');
  assert.equal((await sessionService.submitFlag({ sessionId: a.sessionId, flagType: 'user', value: fa.user })).httpStatus, 410);
});
