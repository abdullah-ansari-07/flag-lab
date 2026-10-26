'use strict';
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const { stageFlags, removeStaging } = require('./staging');
const { containerNameFor } = require('./utils/names');

const execFileAsync = promisify(execFile);

/**
 * Creates and destroys per-session target containers via the Docker CLI.
 *
 * Injection method: stage -> `docker create` -> `docker cp` -> `docker start`.
 * Why this and not env vars or a bind mount:
 *  - Env vars show up in `docker inspect`, `docker run` command lines and
 *    /proc/<pid>/environ -- exactly the places this system promises to keep
 *    flags out of. Files do not.
 *  - Copying into a *created-but-not-started* container means the flag files
 *    exist before the first process runs ("injected at startup"), and no host
 *    path ever has to be shared with the container. That makes it work the same
 *    whether the orchestrator runs on the host or inside its own container
 *    (bind-mount paths break in that second case).
 *  - The flags live only in the container's writable layer, never in an image
 *    layer, and the host-side staging copy is deleted immediately afterwards.
 *
 * execFile (not exec) is used throughout: arguments are passed as an array, no
 * shell is involved, so nothing here is injectable. The commands contain
 * session IDs only, never flag values.
 */
class DockerDriver {
  constructor({ image, stagingDir, dockerBin = 'docker', logger }) {
    this.image = image;
    this.stagingDir = stagingDir;
    this.dockerBin = dockerBin;
    this.logger = logger;
  }

  containerName(sessionId) {
    return containerNameFor(sessionId);
  }

  _docker(args) {
    return execFileAsync(this.dockerBin, args, { timeout: 60_000, maxBuffer: 1024 * 1024 });
  }

  /** Fail fast at startup if Docker or the target image is unavailable. */
  async preflight() {
    try {
      await this._docker(['image', 'inspect', this.image]);
    } catch (err) {
      throw new Error(
        `Docker target image "${this.image}" is not available (is the Docker daemon reachable?).\n` +
          `Build it with:  docker build -t ${this.image} ./target\n(${firstLine(err.message)})`
      );
    }
  }

  async createTarget(sessionId, flags) {
    const name = this.containerName(sessionId);
    try {
      const dir = await stageFlags(this.stagingDir, sessionId, flags);
      const { stdout } = await this._docker([
        'create',
        '--name', name,
        '--label', 'flaglab=1',
        '--label', `flaglab.session=${sessionId}`,
        this.image,
      ]);
      const containerId = stdout.trim();
      await this._docker(['cp', path.join(dir, 'user.txt'), `${name}:/root/user.txt`]);
      await this._docker(['cp', path.join(dir, 'root.txt'), `${name}:/root/root.txt`]);
      await this._docker(['start', name]);
      return containerId;
    } catch (err) {
      await this.removeTarget(sessionId).catch(() => {});
      throw new Error(`failed to provision target container: ${firstLine(err.message)}`);
    } finally {
      await removeStaging(this.stagingDir, sessionId).catch(() => {});
    }
  }

  /** Demo mode only: what `docker exec <container> cat /root/<file>` prints. */
  async readFile(sessionId, file) {
    if (!['user.txt', 'root.txt'].includes(file)) throw new Error('unsupported file');
    const { stdout } = await this._docker(['exec', this.containerName(sessionId), 'cat', `/root/${file}`]);
    return stdout.trim();
  }

  /** Idempotent: removing a container that is already gone is success. */
  async removeTarget(sessionId) {
    const name = this.containerName(sessionId);
    try {
      await this._docker(['rm', '--force', '--volumes', name]);
    } catch (err) {
      if (!/no such container/i.test(`${err.stderr || ''} ${err.message}`)) throw err;
    }
    await removeStaging(this.stagingDir, sessionId);
  }
}

function firstLine(text) {
  return String(text).split('\n')[0];
}

module.exports = { DockerDriver };
