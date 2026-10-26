# Dynamic Per-Session Flag Generation & Validation (Problem Statement #3)

Every lab session gets its **own, cryptographically random** `user` and `root` flags. The flags are injected into that session's target container at start-up, only their keyed hashes are stored server-side, and a submission is validated **only against the session it was submitted to**.

```
Node.js + Express  ->  SQLite (better-sqlite3)  ->  Docker CLI  ->  per-session target container
   (REST API)            (HMACs + audit log)        (create/cp/start)    /root/user.txt, /root/root.txt
```

Scope: the core of this project is Problem Statement #3. It does **not** include terminal auth, network isolation or resource tuning (#1, #2, #4). A small account system and web UI were added on top so that several users can each run their own labs and the "different sessions, different flags" behaviour is easy to see. **The session ID is still the unit of flag isolation; the account layer decides who may use which session.**

---

## 1. Quick start (Docker, recommended)

Prerequisites: Docker Engine or Docker Desktop with Compose v2. On Windows use Docker Desktop with the WSL2 backend; Ubuntu with native Docker is the least fiddly option.

```bash
cp .env.example .env
# put a real secret into .env:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste as FLAG_PEPPER=
# (or, if Node 22+ is installed locally:  npm run init-env)

docker compose up --build        # builds the target image + the orchestrator, then starts it
```

Open <http://localhost:3000>, create an account, and start a lab (see "Web UI" below), or use the API.

For a **live presentation** set `DEMO_MODE=true` in `.env` before starting. That adds a "Reveal flags (demo)" button to each lab so the audience can see that two users get different flags. It exposes plaintext flags through the API, so leave it `false` otherwise.

### Run the demo against the real containers

```bash
docker compose exec app node scripts/demo.js
```

(`ADMIN_TOKEN` in `.env` makes the demo also print the audit trail.)

### Share with the company

```bash
sh scripts/package-images.sh     # -> flag-system-images.tar.gz  (both images)
```

Recipient:

```bash
gunzip -c flag-system-images.tar.gz | docker load
cp .env.example .env             # set FLAG_PEPPER
docker compose up --no-build -d
```

Alternatively send the repository folder and have them run `docker compose up --build`.

## 2. Local development (no Docker needed for tests)

Requires Node 22+.

```bash
npm install
cp .env.example .env && npm run init-env   # init-env only creates .env if it does not exist
npm test                  # 45 unit tests, no Docker required
npm run demo:mock         # full demo in-process with a mock Docker driver
npm run test:integration  # real-Docker test (auto-skipped when Docker is absent)

# Run the server against real Docker (target image must exist first):
docker build -t flag-lab-target:latest ./target
npm start
```

`DOCKER_DRIVER=mock` runs the server without Docker at all (no real containers).

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `FLAG_PEPPER` | **required** | Server-side HMAC secret, >= 32 chars. The server refuses to start without it. |
| `SESSION_TTL_MINUTES` | `60` | Session and flag lifetime |
| `PORT` | `3000` | HTTP port |
| `DEMO_MODE` | `false` | Enables the "Reveal flags" button / `GET /api/sessions/:id/reveal` (owner only) |
| `LOGIN_TTL_HOURS` | `8` | Lifetime of a login cookie |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS so the cookie is Secure |
| `ADMIN_TOKEN` | empty | Enables `GET /api/admin/attempts` (audit trail). Empty = endpoint disabled. |
| `DOCKER_DRIVER` | `docker` | `docker` or `mock` |
| `TARGET_IMAGE` | `flag-lab-target:latest` | Image launched per session |
| `MAX_ACTIVE_SESSIONS` | `50` | Hard cap on concurrent sessions (429 beyond it) |
| `SWEEP_INTERVAL_SECONDS` | `30` | How often overdue sessions are expired and failed cleanups retried |
| `DB_PATH` | `./data/flags.db` | SQLite file |

## 2b. Web UI

Open <http://localhost:3000>.

1. **Create account** (3-32 chars of letters/numbers/underscore; password 8+ chars), or **Sign in**.
2. Press **Start lab**. Each lab card has its own colour stripe and 6-character fingerprint taken from its session ID, so different labs are visibly different.
3. Read the flags inside the container with the command shown on the card (`docker exec ... cat /root/user.txt /root/root.txt`), or press **Reveal flags (demo)** when `DEMO_MODE=true`.
4. Pick *User* or *Root*, paste the value, **Submit flag**. The card explains the result in plain language and updates the solved progress.
5. **Show attempts** lists your submission history for that lab. **End lab** tears it down.

**Showing two users side by side:** sign in as `alice` in a normal window and `bob` in a private/incognito window, start a lab in each, reveal both, then paste Alice's root flag into Bob's lab. It is refused.

## 3. API

All `/api/sessions...` routes need a login cookie (`flaglab_session`, set by register/login). A session you do not own behaves exactly like one that does not exist (`404`).

| Method & path | Purpose | Success |
|---|---|---|
| `POST /api/auth/register` | Create account and sign in (`{username, password}`) | `201` |
| `POST /api/auth/login` | Sign in | `200` |
| `POST /api/auth/logout` | Sign out | `200` |
| `GET /api/auth/me` | Current user | `200` / `401` |
| `GET /api/meta` | Public: `{demoMode, sessionTtlMinutes}` | `200` |
| `GET /api/sessions` | My labs, newest first | `200` |
| `POST /api/sessions` | Start a lab: generate + inject flags | `201` |
| `GET /api/sessions/:id` | Status and per-flag solved progress (never flag values) | `200` |
| `POST /api/sessions/:id/flag` | Submit a flag | see below |
| `GET /api/sessions/:id/attempts` | My submission history for this lab | `200` |
| `DELETE /api/sessions/:id` | Tear down (idempotent) | `200` |
| `GET /api/sessions/:id/reveal` | **Demo mode only**: plaintext flags, owner only | `200` / `404` when off |
| `GET /api/admin/attempts?sessionId=&limit=` | Full audit trail incl. user ids, `Authorization: Bearer <ADMIN_TOKEN>` | `200` |

**Create**

```bash
curl -s -c alice.jar -X POST localhost:3000/api/auth/register -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"alice-password-1"}'
curl -s -b alice.jar -X POST localhost:3000/api/sessions
```
```json
{ "sessionId": "sess_3f9c...", "status": "running",
  "createdAt": "2026-09-20T10:00:00.000Z", "expiresAt": "2026-09-20T11:00:00.000Z",
  "targetContainer": "flaglab-target-sess_3f9c..." }
```

**Submit** (`flagType` is `user` or `root`)

```bash
curl -s -b alice.jar -X POST localhost:3000/api/sessions/$ID/flag \
  -H 'Content-Type: application/json' \
  -d '{"flagType":"root","value":"LAB_ROOT{...}"}'
```

| HTTP | `result` | Meaning |
|---|---|---|
| 200 | `success` | Correct for this session (`allFlagsSolved` tells you if both are done) |
| 403 | `incorrect` | Wrong value, wrong type, or another session's flag |
| 409 | `already_solved` | Correct value submitted again (replay) |
| 410 | `expired` | Session expired or was terminated; flags are dead |
| 404 | `invalid_session` | Unknown, malformed, or not your session ID |
| 400 | `invalid_flag_type` / `invalid_request` | Bad `flagType` / missing or oversized `value` |

## 4. Step-by-step demonstration (manual)

```bash
H='Content-Type: application/json'
# 1. Two users = two cookie jars (like two browsers)
curl -s -c alice.jar -X POST localhost:3000/api/auth/register -H "$H" -d '{"username":"alice","password":"alice-password-1"}'
curl -s -c bob.jar   -X POST localhost:3000/api/auth/register -H "$H" -d '{"username":"bob","password":"bob-password-123"}'

# 2. Each starts a lab
A=$(curl -s -b alice.jar -X POST localhost:3000/api/sessions | grep -o 'sess_[0-9a-f]*' | head -1)
B=$(curl -s -b bob.jar   -X POST localhost:3000/api/sessions | grep -o 'sess_[0-9a-f]*' | head -1)

# 3. Inspect the flags inside the containers: they differ
docker exec flaglab-target-$A cat /root/user.txt /root/root.txt
docker exec flaglab-target-$B cat /root/user.txt /root/root.txt
FA_ROOT=$(docker exec flaglab-target-$A cat /root/root.txt)
FA_USER=$(docker exec flaglab-target-$A cat /root/user.txt)

# 4. Correct flag, to the right session                 -> 200 success
curl -s -b alice.jar -X POST localhost:3000/api/sessions/$A/flag -H "$H" -d "{\"flagType\":\"root\",\"value\":\"$FA_ROOT\"}"

# 5. Alice's flag submitted by Bob to Bob's session      -> 403 incorrect
curl -s -b bob.jar -X POST localhost:3000/api/sessions/$B/flag -H "$H" -d "{\"flagType\":\"root\",\"value\":\"$FA_ROOT\"}"

# 6. Bob tries Alice's session directly                  -> 404 invalid_session
curl -s -b bob.jar -X POST localhost:3000/api/sessions/$A/flag -H "$H" -d "{\"flagType\":\"root\",\"value\":\"$FA_ROOT\"}"

# 7. Random wrong flag                                   -> 403 incorrect
curl -s -b alice.jar -X POST localhost:3000/api/sessions/$A/flag -H "$H" -d '{"flagType":"user","value":"LAB_USER{wrong-guess}"}'

# 8. Replay the solved flag                              -> 409 already_solved
curl -s -b alice.jar -X POST localhost:3000/api/sessions/$A/flag -H "$H" -d "{\"flagType\":\"root\",\"value\":\"$FA_ROOT\"}"

# 9. End Alice's lab, retry her once-correct flag        -> 410 {"result":"expired"}
curl -s -b alice.jar -X DELETE localhost:3000/api/sessions/$A
curl -s -i -b alice.jar -X POST localhost:3000/api/sessions/$A/flag -H "$H" -d "{\"flagType\":\"user\",\"value\":\"$FA_USER\"}"
```

`scripts/demo.js` runs this sequence with PASS/FAIL assertions.

## 5. Project structure

```
src/
  server.js          entrypoint: config, DB, driver, sweeper, graceful shutdown
  app.js             Express wiring (dependency-injected)
  authService.js     accounts: scrypt passwords, hashed login tokens, sign-in throttle
  middleware/auth.js cookie parsing, requireAuth, same-origin check
  config.js          env parsing + validation (refuses a weak/missing pepper)
  db.js              SQLite schema: sessions, flags, flag_attempts
  flagService.js     issue / store (HMAC) / validate / expire  -- no Docker dependency
  sessionService.js  lifecycle: create, expire, terminate, sweep, reconcile
  dockerService.js   real Docker driver (create -> cp -> start, idempotent rm)
  mockDocker.js      in-memory driver with the same interface (tests, demo:mock)
  staging.js         short-lived host staging files for injection
  routes/            auth.js, sessions.js, flags.js, admin.js, owned.js (ownership gate)
  utils/             crypto.js, logger.js, errors.js, names.js
target/Dockerfile    flag-free lab target image
public/index.html    web UI: sign-in, your labs, per-lab flag submission (vanilla JS, no external assets)
scripts/             demo.js, init-env.js, package-images.sh
tests/unit/          45 tests, no Docker
tests/integration/   real-Docker test (skips without Docker)
Dockerfile, docker-compose.yml, .env.example, .gitignore
```

## 6. Security design decisions

- **`crypto.randomBytes(16)`**: 128 bits from the OS CSPRNG. Unguessable, so a learner cannot derive another session's flag; no timestamps, counters or session data go into the flag.
- **HMAC-SHA256 with a server-side pepper**: the database never holds a flag, and a stolen database cannot be used to verify guesses without the pepper. The MAC input also binds `sessionId` and `flagType`, so a stored hash is meaningful only for its own (session, type).
- **`crypto.timingSafeEqual`**: constant-time hash comparison (length is checked first because it throws on mismatch).
- **Session-scoped lookup**: validation reads exactly the row `(sessionId, flagType)`. There is no "find this flag anywhere" query, so cross-session reuse fails by construction rather than by a blocklist.
- **File injection, not env vars**: env vars appear in `docker inspect` and process listings. Files are copied into a created-but-not-started container (so they exist before the first process runs), land in the container's writable layer (never an image layer), `user.txt` is `0444` and `root.txt` is `0400`, and the host-side staging copy is deleted immediately. This avoids bind mounts deliberately: host paths break when the orchestrator itself runs in a container, and `docker cp` works identically in both setups. Trade-off: the files are not mounted read-only; root inside the target can modify them, which is acceptable because the DB hash, not the file, is the source of truth.
- **No plaintext in DB, logs or API**: only HMACs are stored; submitted values are HMAC'd before being written to `flag_attempts`; the logger only receives IDs and result codes; docker commands contain session IDs only. Tests assert this against the DB dump, the on-disk SQLite bytes, the log output and API responses.
- **Session expiry**: enforced from the clock inside the validator, not only by the background sweeper, so there is no window where an overdue session still accepts a flag. Expiry also purges the stored hashes (`flag_hash = ''`) so a bug elsewhere cannot revive a flag.
- **Container teardown ordering**: flags are invalidated in a DB transaction first, then the container is removed. If Docker fails, the flags are already dead and the sweeper retries the removal.
- **Audit logging**: every outcome (`success`, `incorrect`, `already_solved`, `expired`, `invalid_session`, `invalid_flag_type`, `invalid_request`) is written to `flag_attempts` with source IP and time. The log survives teardown.
- **Atomic replay protection**: `UPDATE ... WHERE solved_at IS NULL` means two simultaneous correct submissions cannot both succeed (tested with 10 concurrent requests).
- **Accounts**: passwords use scrypt (N=16384, r=8, p=1) with a per-user salt and are compared in constant time. The login cookie holds 256 random bits and only its SHA-256 is stored, so a leaked database does not give usable sessions. An unknown username costs the same work as a wrong password and returns the same error. Eight failed sign-ins per (IP, username) trigger a 15-minute lockout (in memory).
- **Cookie and CSRF**: `HttpOnly` (page scripts cannot read it), `SameSite=Strict`, `Secure` when `COOKIE_SECURE=true`, plus a server-side check that rejects state-changing browser requests whose `Origin` is not this host.
- **Ownership**: every `:sessionId` route checks that the session belongs to the logged-in user. Someone else's session and a non-existent one both return `404`, so IDs cannot be probed. Refused submissions are still written to the audit trail with the submitting user's id.
- **Demo mode**: `GET /api/sessions/:id/reveal` reads the flags back from the container for presentations. It is off by default, owner-only, `no-store`, and its output is never logged.
- **UI**: built with `textContent` only (no `innerHTML`), so server data cannot inject markup.
- **Input hardening**: strict `sess_<32 hex>` IDs (no path or shell metacharacters reach container names or file paths), `execFile` with argument arrays (no shell), 4 KB body limit, `Object.hasOwn` for flag types (`__proto__` is rejected).

## 7. Requirement mapping

| Requirement | Where |
|---|---|
| Unique flag per session | `generateFlag` (128-bit CSPRNG), `FlagService.issueFlags`; test "25 sessions -> 54 distinct flags" |
| Injection into target at startup | `DockerDriver.createTarget`: create -> cp -> start; image contains no flags (`target/Dockerfile`, tested) |
| Backend mapping session -> expected flags | `flags` table keyed `(session_id, flag_type)` holding HMACs |
| Submission/validation endpoint tied to session | `POST /api/sessions/:id/flag`, scoped lookup |
| No reuse/replay across sessions | Session-scoped, session-bound HMAC; `solved_at` + atomic update gives `already_solved` |
| Log attempts (success/failure) | `flag_attempts` table, every code path |
| Outcome: two sessions differ; only own flag accepted | Demo tests 1-3, unit and HTTP tests |
| Several users, different sessions (extra) | Accounts + ownership gate; UI shows each lab's own fingerprint, progress and history |
| Expiry (extra) | TTL, clock-enforced `410`, sweeper, `DELETE` teardown |

## 8. Assumptions

- Each session has a single target container, with flags at `/root/user.txt` and `/root/root.txt`; flag format is `LAB_USER{<32 hex>}` / `LAB_ROOT{<32 hex>}`.
- Accounts are self-service (open registration) and have no roles, email, or password reset. A lab belongs to the user who started it.
- One orchestrator instance owns the SQLite file (SQLite is fine for a single node; multi-node would need a shared store).
- The orchestrator is trusted and controls the Docker daemon.

## 9. Limitations

- A learner can still read *their own* lab's flag and give it to a friend, but the friend can only use it in their own lab, where it never matches. The system proves a flag belongs to a lab and that the lab belongs to the submitting user, not that the person did the exploitation unaided.
- Registration is open to anyone who can reach the server. For a real deployment add invitation codes or SSO, email verification and password reset; none of that is implemented.
- The sign-in throttle is in memory (resets on restart, per instance). Serve over HTTPS and set `COOKIE_SECURE=true` outside localhost.
- The UI was exercised with an automated DOM test (jsdom), not in a real browser; check layout and the clipboard buttons by eye.
- **Mounting `/var/run/docker.sock` into the orchestrator is root-equivalent on the host.** Fine for a prototype; production should use a socket proxy or a dedicated rootless Docker host.
- No rate limiting on flag submissions (brute force of 128 bits is infeasible, but log spam is possible).
- Flags exist in plaintext inside the container by design; anyone with a root shell there can read them.
- Cheat detection (noticing that a submitted value belongs to a different session) is deliberately not implemented, because the brief forbids global flag lookups.
- The real-Docker path was verified on Ubuntu by running `scripts/demo.js` before accounts were added. The account layer, the UI and `DockerDriver.readFile` (demo-mode reveal) have been tested only against the mock driver; rerun the demo and press **Reveal flags** once on a Docker host.
