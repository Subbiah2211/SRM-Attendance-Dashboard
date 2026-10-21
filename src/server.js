'use strict';
const config = require('./config/env');
const db = require('./config/db');
const { createApp } = require('./app');

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`[web] attendance dashboard on ${config.appUrl} (${config.nodeEnv})`);
});

function shutdown(signal) {
  console.log(`[web] ${signal}: closing`);
  server.close(() => db.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
