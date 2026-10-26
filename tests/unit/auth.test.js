'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContext, client } = require('../helpers');

async function setup(t, config) {
  const ctx = buildContext({ config }); t.after(ctx.dispose);
  const srv = await ctx.listen(); t.after(srv.close);
  return { ctx, srv, anon: client(srv.baseUrl) };
}
const flag = (c, id, flagType, value) => c.request('POST', `/api/sessions/${id}/flag`, { flagType, value });

test('registration signs the user in; /me, logout and re-login work', async (t) => {
  const { srv, anon } = await setup(t);
  assert.equal((await anon.request('GET', '/api/auth/me')).status, 401);
  const reg = await anon.register('Alice_1'); // stored lowercase
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.username, 'alice_1');
  assert.equal((await anon.request('GET', '/api/auth/me')).body.user.username, 'alice_1');
  assert.equal((await anon.request('POST', '/api/auth/logout')).status, 200);
  assert.equal((await anon.request('GET', '/api/auth/me')).status, 401);
  const again = client(srv.baseUrl);
  assert.equal((await again.request('POST', '/api/auth/login', { username: 'ALICE_1', password: 'correct-horse-battery' })).status, 200);
});

test('registration validates username and password and rejects duplicates', async (t) => {
  const { anon } = await setup(t);
  assert.equal((await anon.register('ab')).body.error, 'invalid_username');
  assert.equal((await anon.register('has space')).body.error, 'invalid_username');
  assert.equal((await anon.register('../etc')).body.error, 'invalid_username');
  assert.equal((await anon.register('carol', 'short')).body.error, 'invalid_password');
  assert.equal((await anon.register('carol', 'x'.repeat(200))).body.error, 'invalid_password');
  assert.equal((await anon.register('carol')).status, 201);
});

test('duplicate usernames are rejected case-insensitively', async (t) => {
  const { srv, anon } = await setup(t);
  await anon.register('dave');
  const other = client(srv.baseUrl);
  const r = await other.register('DAVE');
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'username_taken');
});

test('wrong credentials give one generic 401 for unknown user and wrong password', async (t) => {
  const { srv, anon } = await setup(t);
  await anon.register('erin');
  const c = client(srv.baseUrl);
  const wrongPw = await c.request('POST', '/api/auth/login', { username: 'erin', password: 'not-the-password' });
  const noUser = await c.request('POST', '/api/auth/login', { username: 'nobody', password: 'not-the-password' });
  assert.equal(wrongPw.status, 401); assert.equal(noUser.status, 401);
  assert.deepEqual(wrongPw.body, noUser.body);
  assert.equal(c.cookie, '');
});

test('repeated failed sign-ins are throttled (429), then recover after the window', async (t) => {
  const { ctx, srv, anon } = await setup(t);
  await anon.register('frank');
  const c = client(srv.baseUrl);
  for (let i = 0; i < 8; i++) assert.equal((await c.request('POST', '/api/auth/login', { username: 'frank', password: 'wrong-password' })).status, 401);
  const blocked = await c.request('POST', '/api/auth/login', { username: 'frank', password: 'correct-horse-battery' });
  assert.equal(blocked.status, 429); // even the right password is refused during the lockout
  ctx.advanceMinutes(16);
  assert.equal((await c.request('POST', '/api/auth/login', { username: 'frank', password: 'correct-horse-battery' })).status, 200);
});

test('login cookie is HttpOnly and SameSite=Strict; Secure when configured', async (t) => {
  const { anon } = await setup(t, { cookieSecure: true });
  const r = await anon.register('gina');
  const c = r.setCookie[0];
  assert.match(c, /HttpOnly/i); assert.match(c, /SameSite=Strict/i); assert.match(c, /Secure/i);
});

test('login sessions expire', async (t) => {
  const { ctx, anon } = await setup(t, { loginTtlHours: 1 });
  await anon.register('hank');
  assert.equal((await anon.request('GET', '/api/auth/me')).status, 200);
  ctx.advanceMinutes(61);
  assert.equal((await anon.request('GET', '/api/auth/me')).status, 401);
});

test('passwords and login tokens are never stored in plaintext', async (t) => {
  const { ctx, anon } = await setup(t);
  const password = 'sup3r-secret-passphrase';
  await anon.register('iris', password);
  const token = anon.cookie.split('=')[1];
  const dump = JSON.stringify(ctx.db.prepare('SELECT * FROM users').all()) + JSON.stringify(ctx.db.prepare('SELECT * FROM login_sessions').all());
  assert.ok(!dump.includes(password));
  assert.ok(!dump.includes(token));
  assert.match(ctx.db.prepare('SELECT password_hash h FROM users').get().h, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.ok(!ctx.logLines.join('\n').includes(password));
});

test('unauthenticated requests cannot touch any session endpoint', async (t) => {
  const { anon } = await setup(t);
  const id = 'sess_' + 'a'.repeat(32);
  for (const [m, u] of [['GET', '/api/sessions'], ['POST', '/api/sessions'], ['GET', `/api/sessions/${id}`], ['DELETE', `/api/sessions/${id}`],
    ['POST', `/api/sessions/${id}/flag`], ['GET', `/api/sessions/${id}/attempts`], ['GET', `/api/sessions/${id}/reveal`]]) {
    assert.equal((await anon.request(m, u, m === 'POST' ? {} : undefined)).status, 401, `${m} ${u}`);
  }
});

test('ownership: another user cannot read, submit to, end or inspect my lab', async (t) => {
  const { ctx, srv, anon } = await setup(t);
  const alice = anon; await alice.register('alice');
  const mallory = client(srv.baseUrl); await mallory.register('mallory');
  const s = (await alice.request('POST', '/api/sessions')).body;
  const f = await ctx.readFlags(s.sessionId);

  for (const [m, u, b] of [['GET', `/api/sessions/${s.sessionId}`], ['GET', `/api/sessions/${s.sessionId}/attempts`],
    ['DELETE', `/api/sessions/${s.sessionId}`], ['GET', `/api/sessions/${s.sessionId}/reveal`]]) {
    const r = await mallory.request(m, u, b);
    assert.equal(r.status, 404, `${m} ${u}`); // same as "does not exist"
  }
  // Even with the CORRECT flag, Mallory cannot submit to Alice's lab, and it must not count as solved.
  const r = await flag(mallory, s.sessionId, 'root', f.root);
  assert.equal(r.status, 404); assert.equal(r.body.result, 'invalid_session');
  assert.equal((await alice.request('GET', `/api/sessions/${s.sessionId}`)).body.flags.every((x) => !x.solved), true);
  assert.equal(ctx.docker.has(s.sessionId), true); // DELETE did not tear it down
  // The attempt is audited against Mallory's user id.
  const row = ctx.db.prepare('SELECT * FROM flag_attempts ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.result, 'invalid_session');
  assert.equal(row.user_id, ctx.db.prepare("SELECT id FROM users WHERE username='mallory'").get().id);
  // Alice still can.
  assert.equal((await flag(alice, s.sessionId, 'root', f.root)).status, 200);
});

test('cross-origin state-changing requests are refused; same-origin and no-Origin pass', async (t) => {
  const { srv, anon } = await setup(t);
  await anon.register('jules');
  const evil = await anon.request('POST', '/api/sessions', undefined, { Origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const same = await anon.request('POST', '/api/sessions', undefined, { Origin: srv.baseUrl });
  assert.equal(same.status, 201);
});

test('demo mode: reveal is disabled by default and owner-only when enabled', async (t) => {
  const off = await setup(t);
  await off.anon.register('kim');
  const s1 = (await off.anon.request('POST', '/api/sessions')).body;
  assert.equal((await off.anon.request('GET', `/api/sessions/${s1.sessionId}/reveal`)).status, 404);

  const on = await setup(t, { demoMode: true });
  const alice = on.anon; await alice.register('alice');
  const bob = client(on.srv.baseUrl); await bob.register('bob');
  const sa = (await alice.request('POST', '/api/sessions')).body;
  const sb = (await bob.request('POST', '/api/sessions')).body;
  const ra = (await alice.request('GET', `/api/sessions/${sa.sessionId}/reveal`)).body;
  const rb = (await bob.request('GET', `/api/sessions/${sb.sessionId}/reveal`)).body;
  assert.deepEqual(ra, await on.ctx.readFlags(sa.sessionId));
  assert.notEqual(ra.root, rb.root);
  assert.equal((await bob.request('GET', `/api/sessions/${sa.sessionId}/reveal`)).status, 404);
  await alice.request('DELETE', `/api/sessions/${sa.sessionId}`);
  assert.equal((await alice.request('GET', `/api/sessions/${sa.sessionId}/reveal`)).status, 410);
  assert.ok(!on.ctx.logLines.join('\n').includes(ra.root)); // revealing does not log the value
  assert.deepEqual((await alice.request('GET', '/api/meta')).body.demoMode, true);
});

test('users with several labs each get distinct flags across all of them', async (t) => {
  const { ctx, srv, anon } = await setup(t);
  const alice = anon; await alice.register('alice');
  const bob = client(srv.baseUrl); await bob.register('bob');
  const seen = new Set();
  for (const c of [alice, bob, alice, bob]) {
    const s = (await c.request('POST', '/api/sessions')).body;
    const f = await ctx.readFlags(s.sessionId);
    seen.add(f.user); seen.add(f.root);
  }
  assert.equal(seen.size, 8);
});
