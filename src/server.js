'use strict';
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { createLogger } = require('./utils/logger');
const { DockerDriver } = require('./dockerService');
const { MockDockerDriver } = require('./mockDocker');

async function main() {
  const config = loadConfig();
  const logger = createLogger();
  const db = openDb(config.dbPath);

  const docker =
    config.dockerDriver === 'mock'
      ? new MockDockerDriver({ stagingDir: config.stagingDir })
      : new DockerDriver({
          image: config.targetImage,
          stagingDir: config.stagingDir,
          dockerBin: config.dockerBin,
          logger,
        });
  if (config.dockerDriver === 'mock') logger.warn('mock_docker_driver', { note: 'no real containers will be created' });
  await docker.preflight();

  const { app, sessionService } = createApp({ config, db, docker, logger });
  await sessionService.reconcile();
  sessionService.startSweeper();

  const server = app.listen(config.port, () => logger.info('listening', { port: config.port }));

  const shutdown = (signal) => {
    logger.info('shutdown', { signal });
    sessionService.stopSweeper();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
