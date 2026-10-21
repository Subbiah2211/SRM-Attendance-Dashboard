'use strict';
// Database setup.
//   npm run db:init   empty database: loads the v2.0 base schema, then every migration
//   npm run migrate   existing v2.0 (or later) database: applies migrations not yet applied
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const BASE = path.join(__dirname, '..', 'db', 'base', '000_schema_v2_0.sql');
const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

/** pg_dump output is written for psql; make it runnable through a driver, by any role. */
function cleanDump(sql, serverVersionNum) {
  return sql
    .split('\n')
    .filter((l) => !l.startsWith('\\'))                                   // psql meta-commands (\restrict)
    .filter((l) => !/^ALTER .* OWNER TO .*;\s*$/.test(l))                 // objects belong to the connecting role
    .filter((l) => !/^COMMENT ON EXTENSION /.test(l))
    .filter((l) => serverVersionNum >= 170000 || !/^SET transaction_timeout/.test(l))
    .join('\n');
}

async function migrate(databaseUrl, { withBase = false, log = console.log } = {}) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const version = parseInt((await client.query('SHOW server_version_num')).rows[0].server_version_num, 10);
    const exists = async (name) => (await client.query('SELECT to_regclass($1) AS t', [name])).rows[0].t !== null;

    if (!(await exists('attendance.users'))) {
      if (!withBase) throw new Error('The attendance schema is not in this database. Run "npm run db:init" on an empty database.');
      log('Loading base schema v2.0 ...');
      await client.query(cleanDump(fs.readFileSync(BASE, 'utf8'), version));
      await client.query('RESET search_path');
    }
    await client.query('CREATE TABLE IF NOT EXISTS attendance.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    // A database created from the whole-schema file already contains the migrations: mark them by what they add.
    const MARKERS = {
      '001_': `SELECT to_regclass('attendance.colleges') IS NOT NULL AS ok`,
      '002_': `SELECT to_regclass('attendance.student_subjects') IS NOT NULL AS ok`,
      '003_': `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'identity' AND table_name = 'cameras' AND column_name = 'viewer_url') AS ok`,
    };
    for (const f of files) {
      const marker = MARKERS[f.slice(0, 4)];
      if (marker && (await client.query(marker)).rows[0].ok) await client.query('INSERT INTO attendance.schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING', [f]);
    }
    const done = new Set((await client.query('SELECT version FROM attendance.schema_migrations')).rows.map((r) => r.version));
    for (const f of files) {
      if (done.has(f)) continue;
      log(`Applying ${f} ...`);
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
        await client.query('INSERT INTO attendance.schema_migrations (version) VALUES ($1)', [f]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${f} failed: ${err.message}`);
      }
    }
    log('Database is up to date.');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  const config = require('../src/config/env');
  migrate(config.databaseUrl, { withBase: process.argv.includes('--with-base') }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { migrate };
