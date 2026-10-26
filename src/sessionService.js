'use strict';
const { generateSessionId, SESSION_ID_RE } = require('./utils/crypto');
const { HttpError } = require('./utils/errors');

/**
 * Orchestrates the session lifecycle: DB rows, flag issuance, container
 * provisioning, expiry and teardown.
 *
 * Ordering rule that matters for security: when a session ends we invalidate
 * its flags in the database FIRST (synchronously, in a transaction) and only
 * then try to remove the container. If Docker is down or slow, the flags are
 * already dead; the leftover container is retried by the sweeper.
 */
class SessionService {
  constructor({ db, flagService, docker, config, logger, clock = () => new Date() }) {
    this.db = db;
    this.flagService = flagService;
    this.docker = docker;
    this.config = config;
    this.logger = logger;
    this.clock = clock;
    this.timer = null;

    this.stmts = {
      insertSession: db.prepare(
        `INSERT INTO sessions (session_id, user_id, status, created_at, expires_at) VALUES (?, ?, 'provisioning', ?, ?)`
      ),
      activate: db.prepare(`UPDATE sessions SET status = 'active', container_id = ? WHERE session_id = ? AND status = 'provisioning'`),
      getSession: db.prepare('SELECT * FROM sessions WHERE session_id = ?'),
      endSession: db.prepare(`UPDATE sessions SET status = ?, ended_at = ? WHERE session_id = ?`),
      markCleaned: db.prepare('UPDATE sessions SET cleanup_done = 1 WHERE session_id = ?'),
      liveCount: db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE status IN ('provisioning','active')`),
      dueSessions: db.prepare(`SELECT session_id FROM sessions WHERE status = 'active' AND expires_at <= ?`),
      pendingCleanup: db.prepare(
        `SELECT session_id FROM sessions WHERE status NOT IN ('active','provisioning') AND cleanup_done = 0`
      ),
      stuckProvisioning: db.prepare(`SELECT session_id FROM sessions WHERE status = 'provisioning'`),
      listByUser: db.prepare('SELECT session_id FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50'),
      owner: db.prepare('SELECT user_id FROM sessions WHERE session_id = ?'),
      flagsOf: db.prepare('SELECT flag_type, solved_at, status FROM flags WHERE session_id = ? ORDER BY flag_type'),
    };
  }

  async createSession({ userId = null } = {}) {
    if (this.stmts.liveCount.get().c >= this.config.maxActiveSessions) {
      throw new HttpError(429, 'too_many_sessions', 'maximum number of concurrent sessions reached');
    }

    const sessionId = generateSessionId();
    const now = this.clock();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.config.sessionTtlMinutes * 60_000).toISOString();

    // Session row + flag hashes are committed together or not at all.
    let flags = this.db.transaction(() => {
      this.stmts.insertSession.run(sessionId, userId, createdAt, expiresAt);
      return this.flagService.issueFlags(sessionId, expiresAt);
    })();

    try {
      const containerId = await this.docker.createTarget(sessionId, flags);
      this.stmts.activate.run(containerId, sessionId);
    } catch (err) {
      this.logger.error('session_provision_failed', { sessionId, error: err.message });
      await this.endSession(sessionId, 'failed');
      throw new HttpError(502, 'provisioning_failed', 'could not start the target container');
    } finally {
      flags = null; // drop our reference to the plaintext as soon as it has been injected
    }

    this.logger.info('session_created', { sessionId, expiresAt });
    return {
      sessionId,
      status: 'running',
      createdAt,
      expiresAt,
      targetContainer: this.docker.containerName(sessionId),
    };
  }

  getSession(sessionId) {
    if (!SESSION_ID_RE.test(sessionId)) return null;
    const row = this.stmts.getSession.get(sessionId);
    if (!row) return null;
    const expiredByClock = row.status === 'active' && new Date(row.expires_at) <= this.clock();
    const status = expiredByClock ? 'expired' : row.status === 'active' ? 'running' : row.status;
    return {
      sessionId: row.session_id,
      status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      endedAt: row.ended_at,
      // Progress only. Never the flag values or hashes.
      flags: this.stmts.flagsOf.all(sessionId).map((f) => ({ flagType: f.flag_type, solved: !!f.solved_at })),
    };
  }

  /** Owner's user id; undefined if the session does not exist, null if it has no owner. */
  ownerOf(sessionId) {
    if (!SESSION_ID_RE.test(sessionId)) return undefined;
    const row = this.stmts.owner.get(sessionId);
    return row ? row.user_id : undefined;
  }

  listSessions(userId) {
    return this.stmts.listByUser.all(userId).map((r) => this.getSession(r.session_id));
  }

  /** Learner-visible attempt history for one session (no hashes, no IPs). */
  attemptHistory(sessionId, limit = 50) {
    return this.flagService
      .getAttempts(sessionId, limit)
      .map((a) => ({ timestamp: a.timestamp, flagType: a.flag_type, result: a.result }));
  }

  /**
   * DEMO MODE ONLY. Reads the plaintext flags back out of the running
   * container so a presenter can show that sessions differ. The route that
   * calls this is disabled unless DEMO_MODE=true.
   */
  async revealFlags(sessionId) {
    const s = this.getSession(sessionId);
    if (!s) throw new HttpError(404, 'not_found', 'session not found');
    if (s.status !== 'running') throw new HttpError(410, 'expired', 'this lab has ended');
    try {
      const [user, root] = await Promise.all([
        this.docker.readFile(sessionId, 'user.txt'),
        this.docker.readFile(sessionId, 'root.txt'),
      ]);
      return { user, root };
    } catch (err) {
      this.logger.error('reveal_failed', { sessionId, error: err.message });
      throw new HttpError(502, 'reveal_failed', 'could not read the flags from the lab container');
    }
  }

  /** Learner-facing wrapper: makes sure an overdue session is torn down before validating. */
  async submitFlag({ sessionId, flagType, value, sourceIp, userId }) {
    if (typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId)) {
      await this.expireIfDue(sessionId);
    }
    return this.flagService.validate({ sessionId, flagType, value, sourceIp, userId });
  }

  async expireIfDue(sessionId) {
    const row = this.stmts.getSession.get(sessionId);
    if (row && row.status === 'active' && new Date(row.expires_at) <= this.clock()) {
      await this.endSession(sessionId, 'expired');
    }
  }

  /** DELETE /api/sessions/:id. Idempotent. Returns null if the session never existed. */
  async terminate(sessionId) {
    if (!SESSION_ID_RE.test(sessionId)) return null;
    return this.endSession(sessionId, 'terminated');
  }

  async endSession(sessionId, finalStatus) {
    const row = this.stmts.getSession.get(sessionId);
    if (!row) return null;

    if (row.status === 'active' || row.status === 'provisioning') {
      const nowIso = this.clock().toISOString();
      this.db.transaction(() => {
        this.stmts.endSession.run(finalStatus, nowIso, sessionId);
        this.flagService.expireFlags(sessionId, nowIso);
      })();
      this.logger.info('session_ended', { sessionId, status: finalStatus });
    }
    await this.cleanupContainer(sessionId);
    return this.getSession(sessionId);
  }

  async cleanupContainer(sessionId) {
    try {
      await this.docker.removeTarget(sessionId);
      this.stmts.markCleaned.run(sessionId);
      return true;
    } catch (err) {
      this.logger.error('container_cleanup_failed', { sessionId, error: err.message });
      return false; // cleanup_done stays 0 so the sweeper retries
    }
  }

  /** Expire overdue sessions and retry any container cleanups that failed earlier. */
  async sweep() {
    const nowIso = this.clock().toISOString();
    for (const { session_id } of this.stmts.dueSessions.all(nowIso)) {
      await this.endSession(session_id, 'expired');
    }
    for (const { session_id } of this.stmts.pendingCleanup.all()) {
      await this.cleanupContainer(session_id);
    }
  }

  /** On boot: anything still "provisioning" belongs to a previous crashed process. */
  async reconcile() {
    for (const { session_id } of this.stmts.stuckProvisioning.all()) {
      await this.endSession(session_id, 'failed');
    }
    await this.sweep();
  }

  startSweeper() {
    this.stopSweeper();
    this.timer = setInterval(() => {
      this.sweep().catch((err) => this.logger.error('sweep_failed', { error: err.message }));
    }, this.config.sweepIntervalSeconds * 1000);
    this.timer.unref();
  }

  stopSweeper() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { SessionService };
