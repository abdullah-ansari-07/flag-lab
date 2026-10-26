'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContext, client } = require('../helpers');

async function twoUsers(t, config) {
  const ctx = buildContext({ config }); t.after(ctx.dispose);
  const srv = await ctx.listen(); t.after(srv.close);
  const alice = client(srv.baseUrl); const bob = client(srv.baseUrl);
  assert.equal((await alice.register('alice')).status, 201);
  assert.equal((await bob.register('bob')).status, 201);
  return { ctx, srv, alice, bob };
}
const flag = (c, id, flagType, value) => c.request('POST', `/api/sessions/${id}/flag`, { flagType, value });

test('HTTP: the six demonstration scenarios, with two signed-in users', async (t) => {
  const { ctx, alice, bob } = await twoUsers(t);

  // Test 1: two concurrent sessions (one per user), different flags
  const a = (await alice.request('POST', '/api/sessions')).body;
  const b = (await bob.request('POST', '/api/sessions')).body;
  assert.equal(a.status, 'running');
  assert.notEqual(a.sessionId, b.sessionId);
  const fa = await ctx.readFlags(a.sessionId);
  const fb = await ctx.readFlags(b.sessionId);
  assert.notEqual(fa.root, fb.root);
  assert.notEqual(fa.user, fb.user);
  assert.ok(!JSON.stringify(a).includes(fa.root)); // API never returns flags

  // Test 2: correct flag to own session
  let r = await flag(alice, a.sessionId, 'root', fa.root);
  assert.equal(r.status, 200); assert.equal(r.body.result, 'success');
  // Test 3: Alice's flag submitted by Bob to Bob's own session
  r = await flag(bob, b.sessionId, 'root', fa.root);
  assert.equal(r.status, 403); assert.equal(r.body.result, 'incorrect');
  // Test 4: incorrect flag
  r = await flag(alice, a.sessionId, 'user', 'LAB_USER{wrong-guess}');
  assert.equal(r.status, 403);
  // Test 5: replay
  r = await flag(alice, a.sessionId, 'root', fa.root);
  assert.equal(r.status, 409); assert.equal(r.body.result, 'already_solved');
  // Test 6: teardown then expired
  r = await alice.request('DELETE', `/api/sessions/${a.sessionId}`);
  assert.equal(r.status, 200); assert.equal(r.body.status, 'terminated');
  r = await flag(alice, a.sessionId, 'user', fa.user);
  assert.equal(r.status, 410); assert.deepEqual(r.body, { result: 'expired' });
  assert.equal(ctx.docker.has(a.sessionId), false);
  assert.equal(ctx.docker.has(b.sessionId), true);
});

test('HTTP: status and attempts endpoints expose progress, never flags or hashes', async (t) => {
  const { ctx, alice } = await twoUsers(t);
  const s = (await alice.request('POST', '/api/sessions')).body;
  const f = await ctx.readFlags(s.sessionId);
  await flag(alice, s.sessionId, 'user', f.user);
  await flag(alice, s.sessionId, 'root', 'LAB_ROOT{nope}');
  const st = await alice.request('GET', `/api/sessions/${s.sessionId}`);
  assert.deepEqual(st.body.flags, [{ flagType: 'root', solved: false }, { flagType: 'user', solved: true }]);
  const at = await alice.request('GET', `/api/sessions/${s.sessionId}/attempts`);
  assert.deepEqual(at.body.attempts.map((x) => x.result), ['incorrect', 'success']);
  for (const text of [JSON.stringify(st.body), JSON.stringify(at.body)]) {
    assert.ok(!text.includes(f.user) && !/[0-9a-f]{64}/.test(text));
  }
  assert.equal((await alice.request('GET', '/api/sessions/nope')).status, 404);
});

test('HTTP: list returns only the caller\'s labs, newest first', async (t) => {
  const { alice, bob } = await twoUsers(t);
  const a1 = (await alice.request('POST', '/api/sessions')).body;
  const a2 = (await alice.request('POST', '/api/sessions')).body;
  const b1 = (await bob.request('POST', '/api/sessions')).body;
  const la = (await alice.request('GET', '/api/sessions')).body.sessions.map((s) => s.sessionId);
  const lb = (await bob.request('GET', '/api/sessions')).body.sessions.map((s) => s.sessionId);
  assert.deepEqual(la, [a2.sessionId, a1.sessionId]);
  assert.deepEqual(lb, [b1.sessionId]);
});

test('HTTP: malformed bodies and unknown routes return clean JSON errors', async (t) => {
  const { alice } = await twoUsers(t);
  const s = (await alice.request('POST', '/api/sessions')).body;
  const url = `/api/sessions/${s.sessionId}/flag`;
  assert.equal((await alice.request('POST', url, '{not json')).status, 400);
  assert.equal((await alice.request('POST', url, { flagType: 'root', value: 'x'.repeat(10_000) })).status, 413);
  assert.equal((await alice.request('POST', url, {})).status, 400);
  assert.equal((await alice.request('GET', '/api/nope')).status, 404);
});

test('HTTP: audit endpoint is token-gated and hides plaintext submissions', async (t) => {
  const { alice } = await twoUsers(t);
  const s = (await alice.request('POST', '/api/sessions')).body;
  await flag(alice, s.sessionId, 'root', 'LAB_ROOT{guessguessguessguessguessguess12}');
  const url = `/api/admin/attempts?sessionId=${s.sessionId}`;
  assert.equal((await alice.request('GET', url)).status, 401);
  assert.equal((await alice.request('GET', url, undefined, { Authorization: 'Bearer wrong' })).status, 401);
  const ok = await alice.request('GET', url, undefined, { Authorization: 'Bearer test-admin-token' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.attempts[0].result, 'incorrect');
  assert.equal(ok.body.attempts[0].user_id, 1); // audit records WHO submitted
  assert.match(ok.body.attempts[0].submitted_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(ok.body).includes('guessguess'));
});

test('HTTP: audit endpoint is disabled when no ADMIN_TOKEN is configured', async (t) => {
  const { alice } = await twoUsers(t, { adminToken: '' });
  assert.equal((await alice.request('GET', '/api/admin/attempts', undefined, { Authorization: 'Bearer ' })).status, 404);
});

test('HTTP: health check and the UI are served', async (t) => {
  const { alice, srv } = await twoUsers(t);
  assert.deepEqual((await alice.request('GET', '/healthz')).body, { status: 'ok' });
  const html = await (await fetch(srv.baseUrl + '/')).text();
  assert.match(html, /<title>Flag Lab/);
  assert.deepEqual((await alice.request('GET', '/api/meta')).body, { demoMode: false, sessionTtlMinutes: 60 });
});
