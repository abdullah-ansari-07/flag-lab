'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateFlag, generateSessionId, hmacFlag, hashesMatch, SESSION_ID_RE } = require('../../src/utils/crypto');

test('flags have the expected format and 128 bits of randomness', () => {
  const f = generateFlag('LAB_ROOT');
  assert.match(f, /^LAB_ROOT\{[0-9a-f]{32}\}$/); // 32 hex chars = 16 bytes = 128 bits
});

test('flag uniqueness: 10,000 generated flags contain no duplicates', () => {
  const seen = new Set();
  for (let i = 0; i < 10_000; i++) seen.add(generateFlag('LAB_USER'));
  assert.equal(seen.size, 10_000);
});

test('session IDs match the strict format and are unique', () => {
  const ids = new Set(Array.from({ length: 1000 }, generateSessionId));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, SESSION_ID_RE);
});

test('HMAC is deterministic, pepper-dependent and bound to session and type', () => {
  const base = hmacFlag('pepper-1', 'sess_a', 'root', 'LAB_ROOT{x}');
  assert.equal(base, hmacFlag('pepper-1', 'sess_a', 'root', 'LAB_ROOT{x}'));
  assert.notEqual(base, hmacFlag('pepper-2', 'sess_a', 'root', 'LAB_ROOT{x}'));
  assert.notEqual(base, hmacFlag('pepper-1', 'sess_b', 'root', 'LAB_ROOT{x}'));
  assert.notEqual(base, hmacFlag('pepper-1', 'sess_a', 'user', 'LAB_ROOT{x}'));
  assert.match(base, /^[0-9a-f]{64}$/);
});

test('hashesMatch handles equal, different, and mismatched-length inputs without throwing', () => {
  const h = hmacFlag('p', 's', 'root', 'v');
  assert.equal(hashesMatch(h, h), true);
  assert.equal(hashesMatch(h, hmacFlag('p', 's', 'root', 'w')), false);
  assert.equal(hashesMatch(h, 'abcd'), false);
  assert.equal(hashesMatch(h, ''), false); // blanked (expired) hash never matches
  assert.equal(hashesMatch('', ''), false);
});
