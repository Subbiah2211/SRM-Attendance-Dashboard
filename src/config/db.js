'use strict';
const { Pool, types } = require('pg');
const config = require('./env');

// Keep DATE as 'YYYY-MM-DD' text (no time-zone shifting), and return numbers for
// NUMERIC and BIGINT, which are small in this schema.
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));

const pool = new Pool({ connectionString: config.databaseUrl, max: config.dbPoolSize });
pool.on('error', (err) => console.error('[db] idle client error', err.message));

async function query(text, params) {
  return pool.query(text, params);
}
async function many(text, params) {
  return (await pool.query(text, params)).rows;
}
async function one(text, params) {
  return (await pool.query(text, params)).rows[0] || null;
}

/** Run fn(client) inside one transaction. The client has the same many/one helpers. */
async function tx(fn) {
  const client = await pool.connect();
  client.many = async (t, p) => (await client.query(t, p)).rows;
  client.one = async (t, p) => (await client.query(t, p)).rows[0] || null;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, many, one, tx, end: () => pool.end() };
