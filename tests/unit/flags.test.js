'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildContext } = require('../helpers');

const submit = (ctx, sessionId, flagType, value) => ctx.sessionService.submitFlag({ sessionId, flagType, value, sourceIp: '127.0.0.1' });
const attempts = (ctx, sessionId) => ctx.flagService.getAttempts(sessionId).map((a) => a.result).reverse();

test('session creation: active session, hashed flags stored, no plaintext in the result', async (t) => {
  const ctx = buildContext(); t.after(ctx.dispose);
  const s = await ctx.sessionService.createSession();
  assert.match(s.sessionId, /^sess_[0-9a-f]{32}$/);
  assert.equal(s.status, 'running');
  assert.ok(ctx.docker.has(s.sessionId));
  const flags = await ctx.readFlags(s.sessionId);
  assert.ok(!JSON.stringify(s).includes(flags.user) && !JSON.stringify(s).includes(flags.root));
  const rows = ctx.db.prepare('SELECT * FROM flags WHERE session_id = ?').all(s.sessionId);
  assert.deepEqual(rows.map((r) => r.flag_type).sort(), ['root', 'user']);
  for (const r of rows) assert.match(r.flag_hash, /^[0-9a-f]{64}$/);
});

test('two simultaneous sessions get different flags, and so do 25 sessions', async (t) => {
  const ctx = buildContext(); t.after(ctx.dispose);
  const [a, b] = await Promise.all([ctx.sessionService.createSession(), ctx.sessionService.createSession()]);
  const fa = await ctx.readFlags(a.sessionId);
  const fb = await ctx.readFlags(b.sessionId);
  assert.notEqual(fa.user, fb.user);
  assert.notEqual(fa.root, fb.root);
  assert.notEqual(fa.user, fa.root);

  const all = new Set([fa.user, fa.root, fb.user, fb.root]);
  for (let i = 0; i < 25; i++) {
    const s = await ctx.sessionService.createSession();
    const f = await ctx.readFlags(s.sessionId);
    all.add(f.user); all.add(f.root);
  }
  assert.equal(all.size, 54);
});

test('correct flag is accepted; completing both flags reports allFlagsSolved', async (t) => {
  const ctx = buildContext(); t.after(ctx.dispose);
  const s = await ctx.sessionService.createSession();
  const f = await ctx.readFlags(s.sessionId);
  const r1 = await submit(ctx, s.sessionId, 'user', f.user);
  assert.equal(r1.httpStatus, 200);
  assert.equal(r1.body.result, 'success');
  assert.equal(r1.body.allFlagsSolved, false);
  const r2 = await submit(ctx, s.sessionId, 'root', f.root);
  assert.equal(r2.body.result, 'success');
  assert.equal(r2.body.allFlagsSolved, true);
});

test('incorrect flags are rejected, including right value under the wrong type', async (t) => {
  const ctx = buildContext(); t.after(ctx.dispose);
  const s = await ctx.sessionService.createSession();
  const f = await ctx.readFlags(s.sessionId);
  assert.equal((await submit(ctx, s.sessionId, 'root', 'LAB_ROOT{00000000000000000000000000000000}')).body.result, 'incorrect');
  assert.equal((await submit(ctx, s.sessionId, 'root', f.user)).body.result, 'incorrect'); // type confusion
  assert.equal((await submit(ctx, s.sessionId, 'root', f.root.toLowerCase().replace('lab_root', 'LAB_ROOT ') )).httpStatus, 403);
  assert.deepEqual(attempts(ctx, s.sessionId), ['incorrect', 'incorrect', 'incorrect']);
});

test('cross-session reuse: Session A\'s flag is rejected by Session B and does not change B', async (t) => {
  const ctx = buildContext(); t.after(ctx.dispose);
  const a = await ctx.sessionService.createSession();
  const b = await ctx.sessionService.createSession();
  const fa = await ctx.readFlags(a.sessionId);
  const fb = await ctx.readFlags(b.sessionId);
  for (const type of ['user', 'root']) {
    const r = await submit(ctx, b.sessionId, type, fa[type]);
    assert.equal(r.httpStatus, 403);
    assert.equal(r.body.result, 'incorrect');
  }
  assert.deepEqual(ctx.sessionService.getSession(b.sessionId).flags.map((x) => x.solved), [false, false]);
  // B's own flag still works, A's flag still works for A.
  assert.equal((await submit(ctx, b.sessionId, 'root', fb.root)).body.result, 'success');
  assert.equal((await submit(ctx, a.sessionId, 'root', fa.root)).body.result, 'success');
});

test('replay: a solved flag cannot be solved twice', async (t) => {
  const ctx = buildContext(); t.after(ctx.dispose);
  const s = await ctx.sessionService.createSession();
  const f = await ctx.readFlags(s.sessionId);
  await submit(ctx, s.sessionId, 'root', f.root);
  const solvedAt = ctx.db.prepare("SELECT solved_at FROM flags WHERE session_id=? AND flag_type='root'").get(s.sessionId).solved_at;
  ctx.advanceMinutes(5);
  const again = await submit(ctx, s.sessionId, 'root', f.root);
  assert.equal(again.httpStatus, 409);
  assert.equal(again.body.result, 'already_solved');
  assert.equal(ctx.db.prepare("SELECT solved_at FROM flags WHERE session_id=? AND flag_type='root'").get(s.sessionId).solved_at, solvedAt);
  assert.deepEqual(attempts(ctx, s.sessionId), ['success', 'already_solved']);
});

test('concurrent identical submissions: exactly one success', async (t) => {
  const ctx = buildContext(); t.after(ctx.dispose);
  const s = await ctx.sessionService.createSession();
  const f = await ctx.readFlags(s.sessionId);
  const results = await Promise.all(Array.from({ length: 10 }, () => submit(ctx, s.sessionId, 'root', f.root)));
  assert.equal(results.filter((r) => r.body.result === 'success').length, 1);
  assert.equal(results.filter((r) => r.body.result === 'already_solved').length, 9);
});

test('session expiry: late submission gets 410, container and flags are cleaned up', async (t) => {
  const ctx = buildContext({ config: { sessionTtlMinutes: 30 } }); t.after(ctx.dispose);
  const s = await ctx.sessionService.createSession();
  const f = await ctx.readFlags(s.sessionId);
  ctx.advanceMinutes(31);
  const r = await submit(ctx, s.sessionId, 'root', f.root); // the CORRECT flag, but too late
  assert.equal(r.httpStatus, 410);
  assert.deepEqual(r.body, { result: 'expired' });
  assert.equal(ctx.sessionService.getSession(s.sessionId).status, 'expired');
  assert.equal(ctx.docker.has(s.sessionId), false);
  for (const row of ctx.db.prepare('SELECT * FROM flags WHERE session_id = ?').all(s.sessionId)) {
    assert.equal(row.status, 'expired');
    assert.equal(row.flag_hash, ''); // hash purged, not just flagged
    assert.ok(row.expired_at);
  }
});

test('expiry is enforced from the clock even if the sweeper has not run', async (t) => {
  const ctx = buildContext({ config: { sessionTtlMinutes: 1 } }); t.after(ctx.dispose);
  const s = await ctx.sessionService.createSession();
  const f = await ctx.readFlags(s.sessionId);
  ctx.advanceMinutes(2);
  // Bypass SessionService (and its lazy teardown) to hit the validator directly.
  const r = ctx.flagService.validate({ sessionId: s.sessionId, flagType: 'root', value: f.root, sourceIp: '::1' });
  assert.equal(r.httpStatus, 410);
});

test('sweeper expires overdue sessions and removes their containers', async (t) => {
  const ctx = buildContext({ config: { sessionTtlMinutes: 10 } }); t.after(ctx.dispose);
  const a = await ctx.sessionService.createSession();
  ctx.advanceMinutes(6);
  const b = await ctx.sessionService.createSession(); // expires 6 minutes after A
  ctx.advanceMinutes(5); // A overdue, B not
  await ctx.sessionService.sweep();
  assert.equal(ctx.sessionService.getSession(a.sessionId).status, 'expired');
  assert.equal(ctx.docker.has(a.sessionId), false);
  assert.equal(ctx.sessionService.getSession(b.sessionId).status, 'running');
  assert.equal(ctx.docker.has(b.sessionId), true);
});

test('teardown: flags die, container and temp files are gone, audit log survives', async (t) => {
  const ctx = buildContext(); t.after(ctx.dispose);
  const s = await ctx.sessionService.createSession();
  const f = await ctx.readFlags(s.sessionId);
  await submit(ctx, s.sessionId, 'user', f.user);
  const ended = await ctx.sessionService.terminate(s.sessionId);
  assert.equal(ended.status, 'terminated');
  assert.equal(ctx.docker.has(s.sessionId), false); // container cleanup
  assert.equal(fs.existsSync(path.join(ctx.stagingDir, s.sessionId)), false); // temp files
  assert.equal((await submit(ctx, s.sessionId, 'root', f.root)).httpStatus, 410);
  assert.deepEqual(attempts(ctx, s.sessionId), ['success', 'expired']); // audit preserved
  // Idempotent, and unknown sessions are reported as such.
  assert.equal((await ctx.sessionService.terminate(s.sessionId)).status, 'terminated');
  assert.equal(await ctx.sessionService.terminate('sess_' + '0'.repeat(32)), null);
});

test('staging directory never survives provisioning', async (t) => {
  const ctx = buildContext(); t.after(ctx.dispose);
  const s = await ctx.sessionService.createSession();
  assert.equal(fs.existsSync(path.join(ctx.stagingDir, s.sessionId)), false);
  assert.deepEqual(fs.readdirSync(ctx.stagingDir), []);
});

test('failed container removal is retried by the sweeper', async (t) => {
  const ctx = buildContext(); t.after(ctx.dispose);
  const s = await ctx.sessionService.createSession();
  ctx.docker.failNextRemove = true;
  await ctx.sessionService.terminate(s.sessionId);
  assert.equal(ctx.docker.has(s.sessionId), true); // Docker failed, container still there...
  const f = await ctx.readFlags(s.sessionId);
  assert.equal((await submit(ctx, s.sessionId, 'root', f.root)).httpStatus, 410); // ...but flags are already dead
  await ctx.sessionService.sweep();
  assert.equal(ctx.docker.has(s.sessionId), false);
  assert.equal(ctx.db.prepare('SELECT cleanup_done FROM sessions WHERE session_id=?').get(s.sessionId).cleanup_done, 1);
});

test('provisioning failure leaves no live session, container or temp files', async (t) => {
  const ctx = buildContext(); t.after(ctx.dispose);
  ctx.docker.failNextCreate = true;
  await assert.rejects(ctx.sessionService.createSession(), { status: 502 });
  const row = ctx.db.prepare('SELECT * FROM sessions').get();
  assert.equal(row.status, 'failed');
  assert.ok(ctx.db.prepare('SELECT * FROM flags').all().every((x) => x.status === 'expired' && x.flag_hash === ''));
  assert.equal(ctx.docker.containers.size, 0);
  assert.deepEqual(fs.readdirSync(ctx.stagingDir), []);
});

test('invalid session IDs, flag types and payloads are rejected and logged safely', async (t) => {
  const ctx = buildContext(); t.after(ctx.dispose);
  const s = await ctx.sessionService.createSession();
  assert.equal((await submit(ctx, '../../etc/passwd', 'root', 'x')).httpStatus, 404);
  assert.equal((await submit(ctx, 'sess_' + 'a'.repeat(32), 'root', 'x')).body.result, 'invalid_session');
  assert.equal((await submit(ctx, s.sessionId, '__proto__', 'x')).body.result, 'invalid_flag_type');
  assert.equal((await submit(ctx, s.sessionId, 'admin', 'x')).httpStatus, 400);
  assert.equal((await submit(ctx, s.sessionId, 'root', 12345)).body.result, 'invalid_request');
  assert.equal((await submit(ctx, s.sessionId, 'root', 'A'.repeat(5000))).body.result, 'invalid_request');
  assert.equal((await submit(ctx, s.sessionId, 'root', undefined)).body.result, 'invalid_request');
  assert.equal(ctx.flagService.getAttempts(undefined, 100).length, 7); // every one is in the audit log
});

test('session limit is enforced', async (t) => {
  const ctx = buildContext({ config: { maxActiveSessions: 2 } }); t.after(ctx.dispose);
  await ctx.sessionService.createSession();
  await ctx.sessionService.createSession();
  await assert.rejects(ctx.sessionService.createSession(), { status: 429 });
});

test('reconcile marks sessions orphaned in "provisioning" as failed', async (t) => {
  const ctx = buildContext(); t.after(ctx.dispose);
  ctx.db.prepare("INSERT INTO sessions (session_id,status,created_at,expires_at) VALUES ('sess_" + 'b'.repeat(32) + "','provisioning','2026-09-20T09:00:00Z','2026-09-20T10:00:00Z')").run();
  await ctx.sessionService.reconcile();
  assert.equal(ctx.db.prepare('SELECT status FROM sessions').get().status, 'failed');
});

test('no plaintext flag appears in the DB dump, logs, or API result', async (t) => {
  const ctx = buildContext(); t.after(ctx.dispose);
  const s = await ctx.sessionService.createSession();
  const f = await ctx.readFlags(s.sessionId);
  await submit(ctx, s.sessionId, 'user', f.user);
  await submit(ctx, s.sessionId, 'root', 'LAB_ROOT{deadbeefdeadbeefdeadbeefdeadbeef}');
  await ctx.sessionService.terminate(s.sessionId);
  const haystack = [ctx.dumpDb(), ctx.logLines.join('\n'), JSON.stringify(ctx.sessionService.getSession(s.sessionId))].join('\n');
  for (const v of [f.user, f.root, 'deadbeefdeadbeefdeadbeefdeadbeef']) assert.ok(!haystack.includes(v), 'plaintext leaked');
  // Hex payload of the flags must not leak either.
  assert.ok(!haystack.includes(f.user.slice(10, -1)));
});

test('no plaintext flag in the on-disk SQLite files', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flaglab-db-'));
  const dbPath = path.join(dir, 'flags.db');
  const ctx = buildContext({ dbPath });
  t.after(() => { ctx.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  const s = await ctx.sessionService.createSession();
  const f = await ctx.readFlags(s.sessionId);
  await submit(ctx, s.sessionId, 'root', f.root);
  ctx.db.pragma('wal_checkpoint(TRUNCATE)');
  for (const file of fs.readdirSync(dir)) {
    const bytes = fs.readFileSync(path.join(dir, file)).toString('latin1');
    assert.ok(!bytes.includes(f.root.slice(10, -1)), `flag found in ${file}`);
    assert.ok(!bytes.includes(f.user.slice(10, -1)), `flag found in ${file}`);
  }
});

test('source tree and target image contain no baked-in flag values', () => {
  const root = path.join(__dirname, '..', '..');
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', 'tests', 'data'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/LAB_(USER|ROOT)\{[0-9a-f]{32}\}/.test(fs.readFileSync(p, 'utf8'))) hits.push(p);
    }
  };
  walk(root);
  assert.deepEqual(hits, []);
});
