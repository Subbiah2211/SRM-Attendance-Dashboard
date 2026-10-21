'use strict';
const path = require('path');
require('dotenv').config({ quiet: true });

const env = process.env;
const port = parseInt(env.PORT || '3000', 10);

const config = {
  nodeEnv: env.NODE_ENV || 'development',
  port,
  appUrl: env.APP_URL || `http://localhost:${port}`,
  databaseUrl: env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/srm_attendance',
  dbPoolSize: parseInt(env.DB_POOL_SIZE || '10', 10),
  sessionSecret: env.SESSION_SECRET || 'dev-only-secret-change-me',
  cookieSecure: env.COOKIE_SECURE === 'true',
  storageDir: path.resolve(env.STORAGE_DIR || path.join(__dirname, '..', '..', 'storage')),
  // Students' enrolment photos: one folder per register number.
  photoDir: path.resolve(env.PHOTO_DIR || path.join(__dirname, '..', '..', 'var', 'photos')),
  // The Python that has the recognition requirements installed. Empty: look for a venv, then the system Python.
  pythonBin: env.PYTHON_BIN || '',
  smtp: {
    host: env.SMTP_HOST || '',
    port: parseInt(env.SMTP_PORT || '587', 10),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_FROM || 'attendance@localhost',
  },
  worker: {
    ingestIntervalMs: parseInt(env.WORKER_INGEST_MS || '5000', 10),
    closeIntervalMs: parseInt(env.WORKER_CLOSE_MS || '60000', 10),
    batchSize: parseInt(env.WORKER_BATCH_SIZE || '500', 10),
  },
};

if (config.nodeEnv === 'production' && config.sessionSecret === 'dev-only-secret-change-me') {
  throw new Error('SESSION_SECRET must be set in production');
}

module.exports = config;
