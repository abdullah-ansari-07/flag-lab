'use strict';
const fs = require('fs/promises');
const path = require('path');

// Flags are written to a short-lived, per-session staging directory on the
// orchestrator host, copied into the container, and removed immediately.
// "wx" refuses to overwrite, so a stale directory can never leak an old flag.
async function stageFlags(stagingRoot, sessionId, flags) {
  const dir = path.join(stagingRoot, sessionId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, 'user.txt'), `${flags.user}\n`, { flag: 'wx', mode: 0o444 });
  await fs.writeFile(path.join(dir, 'root.txt'), `${flags.root}\n`, { flag: 'wx', mode: 0o400 });
  return dir;
}

async function removeStaging(stagingRoot, sessionId) {
  await fs.rm(path.join(stagingRoot, sessionId), { recursive: true, force: true });
}

module.exports = { stageFlags, removeStaging };
