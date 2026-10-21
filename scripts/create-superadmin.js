'use strict';
// Create (or reset) the group-level superadmin.
//   node scripts/create-superadmin.js --username superadmin --password 'Choose@Strong1' --name 'Group Admin' --email you@example.edu
const db = require('../src/config/db');
const { hashPassword } = require('../src/utils/crypto');
const { checkStrength } = require('../src/services/auth');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : process.env[`SUPERADMIN_${name.toUpperCase()}`] || fallback;
}

async function main() {
  const username = arg('username', 'superadmin').toLowerCase();
  const password = arg('password');
  if (!password) throw new Error('Give a password: --password <value> (at least 8 characters, a letter and a number).');
  checkStrength(password);
  const name = arg('name', 'Group Administrator');
  const hash = await hashPassword(password);
  const existing = await db.one(`SELECT user_id FROM attendance.users WHERE college_id IS NULL AND lower(username) = $1`, [username]);
  if (existing) {
    await db.query(`UPDATE attendance.users SET password_hash = $2, status = 'active', failed_attempts = 0, locked_until = NULL, must_change_password = false WHERE user_id = $1`, [existing.user_id, hash]);
    console.log(`Password reset for superadmin "${username}".`);
  } else {
    await db.query(
      `INSERT INTO attendance.users (username, password_hash, role_id, first_name, email, college_id, must_change_password)
       SELECT $1, $2, role_id, $3, $4, NULL, false FROM attendance.roles WHERE role_name = 'superadmin'`,
      [username, hash, name, arg('email', null)]
    );
    console.log(`Superadmin "${username}" created. Sign in with "Group administration" selected as the college.`);
  }
}

main().then(() => db.end()).catch((err) => {
  console.error(err.message);
  db.end().finally(() => process.exit(1));
});
