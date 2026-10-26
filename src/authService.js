'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const { HttpError } = require('./utils/errors');

const scrypt = promisify(crypto.scrypt);
// scrypt is memory-hard, so stolen hashes are expensive to brute-force on GPUs.
// N=16384, r=8, p=1 (~16 MB, tens of ms) is the commonly recommended interactive setting.
const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 64 };
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128; // bounds the CPU an attacker can burn per request

const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60_000;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keyLen } = SCRYPT;
  const dk = await scrypt(password, salt, keyLen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${dk.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, N, r, p, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const dk = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(dk, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Accounts and login sessions.
 *  - Passwords: scrypt with a per-user random salt; compared in constant time.
 *  - Login token: 256 random bits in an HttpOnly cookie. Only its SHA-256 is
 *    stored, so a leaked database does not yield usable cookies.
 *  - Failed logins are throttled per (ip, username) in memory.
 */
class AuthService {
  constructor({ db, clock = () => new Date(), loginTtlHours = 8, logger }) {
    this.db = db;
    this.clock = clock;
    this.ttlMs = loginTtlHours * 3600_000;
    this.logger = logger;
    this.failures = new Map();
    this.dummyHash = null; // used to equalise timing when the username does not exist

    this.stmts = {
      insertUser: db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'),
      userByName: db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?'),
      insertLogin: db.prepare('INSERT INTO login_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
      loginByToken: db.prepare(
        `SELECT u.id, u.username, l.expires_at FROM login_sessions l JOIN users u ON u.id = l.user_id WHERE l.token_hash = ?`
      ),
      deleteLogin: db.prepare('DELETE FROM login_sessions WHERE token_hash = ?'),
    };
  }

  static validateUsername(raw) {
    const username = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!USERNAME_RE.test(username)) {
      throw new HttpError(400, 'invalid_username', 'username must be 3-32 characters: letters, numbers or underscore');
    }
    return username;
  }

  static validatePassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      throw new HttpError(400, 'invalid_password', `password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters`);
    }
  }

  async register(rawUsername, password) {
    const username = AuthService.validateUsername(rawUsername);
    AuthService.validatePassword(password);
    const passwordHash = await hashPassword(password);
    try {
      const info = this.stmts.insertUser.run(username, passwordHash, this.clock().toISOString());
      this.logger?.info('user_registered', { userId: Number(info.lastInsertRowid) });
      return { id: Number(info.lastInsertRowid), username };
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
        throw new HttpError(409, 'username_taken', 'that username is already taken');
      }
      throw err;
    }
  }

  _throttleKey(ip, username) {
    return `${ip || '?'}|${String(username).toLowerCase().slice(0, 64)}`;
  }

  _checkThrottle(key) {
    const rec = this.failures.get(key);
    const now = this.clock().getTime();
    if (rec && now - rec.first > FAILURE_WINDOW_MS) this.failures.delete(key);
    else if (rec && rec.count >= MAX_FAILURES) {
      throw new HttpError(429, 'too_many_attempts', 'too many failed sign-ins; wait 15 minutes and try again');
    }
  }

  _recordFailure(key) {
    const now = this.clock().getTime();
    const rec = this.failures.get(key);
    if (!rec || now - rec.first > FAILURE_WINDOW_MS) this.failures.set(key, { count: 1, first: now });
    else rec.count += 1;
    if (this.failures.size > 10_000) this.failures.clear(); // memory bound
  }

  async login(rawUsername, password, ip) {
    const username = typeof rawUsername === 'string' ? rawUsername.trim().toLowerCase() : '';
    const key = this._throttleKey(ip, username);
    this._checkThrottle(key);

    const bad = () => {
      this._recordFailure(key);
      return new HttpError(401, 'invalid_credentials', 'incorrect username or password');
    };
    if (typeof password !== 'string' || password.length > MAX_PASSWORD || !USERNAME_RE.test(username)) throw bad();

    const user = this.stmts.userByName.get(username);
    if (!user) {
      this.dummyHash ??= await hashPassword('timing-equaliser');
      await verifyPassword(password, this.dummyHash); // same work whether or not the user exists
      throw bad();
    }
    if (!(await verifyPassword(password, user.password_hash))) throw bad();

    this.failures.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    this.stmts.insertLogin.run(sha256(token), user.id, now.toISOString(), expiresAt);
    this.logger?.info('user_login', { userId: user.id });
    return { token, expiresAt, user: { id: user.id, username: user.username } };
  }

  authenticate(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const row = this.stmts.loginByToken.get(sha256(token));
    if (!row) return null;
    if (new Date(row.expires_at) <= this.clock()) {
      this.stmts.deleteLogin.run(sha256(token));
      return null;
    }
    return { id: row.id, username: row.username };
  }

  logout(token) {
    if (typeof token === 'string') this.stmts.deleteLogin.run(sha256(token));
  }
}

module.exports = { AuthService };
