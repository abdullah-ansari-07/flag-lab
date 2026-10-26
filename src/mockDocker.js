'use strict';
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { stageFlags, removeStaging } = require('./staging');
const { containerNameFor } = require('./utils/names');

/**
 * In-memory stand-in for DockerDriver with the same interface. It still goes
 * through the real staging code (so temp-file cleanup is genuinely exercised),
 * but "containers" are just entries in a Map. Used by unit tests, by
 * `npm run demo:mock`, and by DOCKER_DRIVER=mock for machines without Docker.
 */
class MockDockerDriver {
  constructor({ stagingDir } = {}) {
    this.stagingDir = stagingDir || path.join(os.tmpdir(), 'flaglab-staging-mock');
    this.containers = new Map();
    this.failNextCreate = false;
    this.failNextRemove = false;
  }

  containerName(sessionId) {
    return containerNameFor(sessionId);
  }

  async preflight() {}

  async createTarget(sessionId, flags) {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('mock: simulated provisioning failure');
    }
    try {
      const dir = await stageFlags(this.stagingDir, sessionId, flags);
      const files = {
        'user.txt': await fs.readFile(path.join(dir, 'user.txt'), 'utf8'),
        'root.txt': await fs.readFile(path.join(dir, 'root.txt'), 'utf8'),
      };
      this.containers.set(sessionId, { files });
      return `mock-${this.containerName(sessionId)}`;
    } finally {
      await removeStaging(this.stagingDir, sessionId);
    }
  }

  async removeTarget(sessionId) {
    if (this.failNextRemove) {
      this.failNextRemove = false;
      throw new Error('mock: simulated removal failure');
    }
    this.containers.delete(sessionId);
    await removeStaging(this.stagingDir, sessionId);
  }

  has(sessionId) {
    return this.containers.has(sessionId);
  }

  /** What `docker exec <container> cat /root/<file>` would print. */
  async readFile(sessionId, file) {
    const c = this.containers.get(sessionId);
    if (!c || !(file in c.files)) throw new Error(`mock: no such file ${file} in ${sessionId}`);
    return c.files[file].trim();
  }
}

module.exports = { MockDockerDriver };
