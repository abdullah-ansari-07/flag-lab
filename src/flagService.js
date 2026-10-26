'use strict';
const {
  FLAG_TYPES,
  SESSION_ID_RE,
  generateFlag,
  hmacFlag,
  hashesMatch,
} = require('./utils/crypto');

const MAX_VALUE_LENGTH = 256; // real flags are ~42 chars; cap input before hashing it

/**
 * Pure flag logic: issue, store (as HMACs), validate, expire.
 * It talks only to SQLite -- no Docker -- so it is unit-testable on its own.
 */
class FlagService {
  constructor({ db, pepper, clock = () => new Date(), logger }) {
    this.db = db;
    this.pepper = pepper;
    this.clock = clock;
    this.logger = logger;

    this.stmts = {
      insertFlag: db.prepare(
        `INSERT INTO flags (session_id, flag_type, flag_hash, status, created_at, expires_at)
         VALUES (?, ?, ?, 'active', ?, ?)`
      ),
      getSession: db.prepare('SELECT session_id, status, expires_at FROM sessions WHERE session_id = ?'),
      getFlag: db.prepare('SELECT flag_hash, status, solved_at FROM flags WHERE session_id = ? AND flag_type = ?'),
      // The WHERE clause makes "mark solved" atomic: two concurrent correct
      // submissions cannot both win.
      markSolved: db.prepare(
        `UPDATE flags SET solved_at = ?
         WHERE session_id = ? AND flag_type = ? AND status = 'active' AND solved_at IS NULL`
      ),
      unsolvedCount: db.prepare(
        `SELECT COUNT(*) AS c FROM flags WHERE session_id = ? AND solved_at IS NULL`
      ),
      expireFlags: db.prepare(
        `UPDATE flags SET status = 'expired', flag_hash = '', expired_at = ?
         WHERE session_id = ? AND status = 'active'`
      ),
      logAttempt: db.prepare(
        `INSERT INTO flag_attempts (session_id, flag_type, submitted_hash, result, source_ip, user_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ),
      attempts: db.prepare(
        `SELECT id, session_id, flag_type, submitted_hash, result, source_ip, user_id, timestamp
         FROM flag_attempts WHERE session_id = ? ORDER BY id DESC LIMIT ?`
      ),
      allAttempts: db.prepare(
        `SELECT id, session_id, flag_type, submitted_hash, result, source_ip, user_id, timestamp
         FROM flag_attempts ORDER BY id DESC LIMIT ?`
      ),
    };
  }

  /**
   * Generates fresh flags for a session, stores ONLY their HMACs, and returns
   * the plaintext so the caller can inject it into the container. The caller
   * must not persist or log the returned object.
   */
  issueFlags(sessionId, expiresAtIso) {
    const createdAt = this.clock().toISOString();
    const flags = {};
    for (const [type, prefix] of Object.entries(FLAG_TYPES)) {
      flags[type] = generateFlag(prefix);
      this.stmts.insertFlag.run(
        sessionId,
        type,
        hmacFlag(this.pepper, sessionId, type, flags[type]),
        createdAt,
        expiresAtIso
      );
    }
    return flags;
  }

  /** Invalidate all flags of a session and purge their hashes (metadata is kept for audit). */
  expireFlags(sessionId, nowIso = this.clock().toISOString()) {
    this.stmts.expireFlags.run(nowIso, sessionId);
  }

  getAttempts(sessionId, limit = 100) {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    return sessionId ? this.stmts.attempts.all(sessionId, n) : this.stmts.allAttempts.all(n);
  }

  /** Normalises untrusted input and builds the audit-logging `finish` helper. */
  _context({ sessionId, flagType, value, sourceIp, userId }) {
    const now = this.clock();
    const nowIso = now.toISOString();
    // Nothing downstream uses the raw values.
    const sid = typeof sessionId === 'string' ? sessionId.slice(0, 64) : '';
    const type = typeof flagType === 'string' ? flagType.slice(0, 16) : '';
    const submitted = typeof value === 'string' ? value.slice(0, MAX_VALUE_LENGTH) : '';
    const submittedHash = hmacFlag(this.pepper, sid, type, submitted);

    const finish = (result, httpStatus, extra = {}) => {
      this.stmts.logAttempt.run(sid, type || null, submittedHash, result, sourceIp || null, userId ?? null, nowIso);
      this.logger?.info('flag_attempt', { sessionId: sid, flagType: type || null, userId: userId ?? null, result });
      return { httpStatus, body: { result, ...extra } };
    };
    return { now, nowIso, sid, type, submittedHash, finish };
  }

  /**
   * Records a submission that was refused before validation (e.g. the caller
   * does not own the session) so it still appears in the audit trail. The
   * response is identical to "no such session", so existence is not leaked.
   */
  reject(args, result = 'invalid_session', httpStatus = 404) {
    return this._context(args).finish(result, httpStatus);
  }

  /**
   * Validates a submission strictly against (sessionId, flagType). There is no
   * global lookup of the submitted value anywhere.
   * Returns { httpStatus, body } and always writes an audit row.
   */
  validate(args) {
    const { value } = args;
    const { now, nowIso, sid, type, submittedHash, finish } = this._context(args);

    // 1. Session must exist.
    const session = SESSION_ID_RE.test(sid) ? this.stmts.getSession.get(sid) : undefined;
    if (!session) return finish('invalid_session', 404);

    // 2. Flag type must be known and the payload well-formed.
    if (!Object.hasOwn(FLAG_TYPES, type)) return finish('invalid_flag_type', 400);
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VALUE_LENGTH) {
      return finish('invalid_request', 400);
    }

    // 3. Expiry is enforced here from the clock, not only by the background
    //    sweeper, so a late submission can never succeed in the gap between
    //    expiry and cleanup.
    if (session.status !== 'active' || new Date(session.expires_at) <= now) {
      return finish('expired', 410);
    }

    // 4. Compare against THIS session's expected hash, in constant time.
    const row = this.stmts.getFlag.get(sid, type);
    const matches = !!row && row.status === 'active' && hashesMatch(submittedHash, row.flag_hash);
    if (!matches) return finish('incorrect', 403);

    // 5. Replay: the right value, submitted again.
    if (row.solved_at) return finish('already_solved', 409, { flagType: type });

    const solve = this.db.transaction(() => {
      const res = this.stmts.markSolved.run(nowIso, sid, type);
      if (res.changes !== 1) return null; // lost a race with a concurrent submission
      return this.stmts.unsolvedCount.get(sid).c === 0;
    });
    const allSolved = solve();
    if (allSolved === null) return finish('already_solved', 409, { flagType: type });
    return finish('success', 200, { flagType: type, solvedAt: nowIso, allFlagsSolved: allSolved });
  }
}

module.exports = { FlagService };
