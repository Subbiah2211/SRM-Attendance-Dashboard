'use strict';
const db = require('../config/db');
const config = require('../config/env');
const settings = require('./settings');
const audit = require('./audit');
const notifications = require('./notifications');
const { sha256, randomToken, hashPassword, verifyPassword } = require('../utils/crypto');
const { HttpError, invalid } = require('../utils/errors');

const BAD_LOGIN = 'College, username or password is not right.';

function activeColleges() {
  return db.many('SELECT college_code, college_name, campus FROM attendance.colleges WHERE is_active ORDER BY college_name');
}

async function findUser(collegeCode, username) {
  let collegeId = 0;
  if (collegeCode) {
    const c = await db.one('SELECT college_id FROM attendance.colleges WHERE college_code = $1 AND is_active', [collegeCode]);
    if (!c) return null;
    collegeId = c.college_id;
  }
  const user = await db.one(
    `SELECT u.*, r.role_name FROM attendance.users u JOIN attendance.roles r ON r.role_id = u.role_id
      WHERE lower(u.username) = lower($1) AND COALESCE(u.college_id, 0) = $2`,
    [String(username || '').trim(), collegeId]
  );
  // Group login (no college) is for the superadmin only.
  if (user && !collegeCode && user.role_name !== 'superadmin') return null;
  return user;
}

/** Check credentials and open a session. Returns { token, user }. */
async function login({ collegeCode, username, password, ip, device }) {
  const user = await findUser(collegeCode, username);
  const req = { ip };
  if (!user || user.status !== 'active') throw new HttpError(401, 'bad_login', BAD_LOGIN);
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new HttpError(423, 'locked', 'This account is locked after too many failed attempts. Try again later.');
  }
  const ok = await verifyPassword(user.password_hash, password);
  if (!ok) {
    const max = await settings.get(user.college_id, 'login_max_attempts', 5);
    const lockMin = await settings.get(user.college_id, 'login_lock_minutes', 15);
    const attempts = user.failed_attempts + 1;
    if (attempts >= max) {
      await db.query(
        `UPDATE attendance.users SET failed_attempts = 0, locked_until = now() + make_interval(mins => $2) WHERE user_id = $1`,
        [user.user_id, lockMin]
      );
      await audit.log(req, 'login_locked', { table: 'users', recordId: user.user_id, userId: user.user_id, collegeId: user.college_id });
    } else {
      await db.query('UPDATE attendance.users SET failed_attempts = $2 WHERE user_id = $1', [user.user_id, attempts]);
    }
    await audit.log(req, 'login_failed', { table: 'users', recordId: user.user_id, userId: user.user_id, collegeId: user.college_id });
    throw new HttpError(401, 'bad_login', BAD_LOGIN);
  }
  const token = randomToken(32);
  await db.query(
    `INSERT INTO attendance.user_sessions (user_id, session_token, ip_address, device) VALUES ($1, $2, $3, $4)`,
    [user.user_id, sha256(token), ip || null, (device || '').slice(0, 200)]
  );
  await db.query('UPDATE attendance.users SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE user_id = $1', [user.user_id]);
  await audit.log(req, 'login', { table: 'users', recordId: user.user_id, userId: user.user_id, collegeId: user.college_id });
  return { token, user };
}

function logout(token) {
  return db.query('UPDATE attendance.user_sessions SET logout_at = now() WHERE session_token = $1 AND logout_at IS NULL', [sha256(token)]);
}

function checkStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw invalid('Password must be at least 8 characters.');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw invalid('Password must contain a letter and a number.');
}

async function changePassword(userId, current, next) {
  const user = await db.one('SELECT user_id, username, password_hash FROM attendance.users WHERE user_id = $1', [userId]);
  if (!user || !(await verifyPassword(user.password_hash, current))) throw invalid('Current password is not right.');
  checkStrength(next);
  if (next === current || next.toLowerCase() === user.username.toLowerCase()) throw invalid('Choose a password different from the current one and from your username.');
  await db.query(
    'UPDATE attendance.users SET password_hash = $2, must_change_password = false, reset_token_hash = NULL, reset_expires_at = NULL WHERE user_id = $1',
    [userId, await hashPassword(next)]
  );
}

/** Email a reset link. Always resolves the same way, so it does not reveal which accounts exist. */
async function requestReset({ collegeCode, username }) {
  const user = await findUser(collegeCode, username);
  if (!user || user.status !== 'active' || !user.email) return;
  const token = randomToken(32);
  await db.query(
    `UPDATE attendance.users SET reset_token_hash = $2, reset_expires_at = now() + interval '1 hour' WHERE user_id = $1`,
    [user.user_id, sha256(token)]
  );
  await notifications.queueEmail({
    email: user.email,
    subject: 'Reset your attendance dashboard password',
    message: `Open this link within one hour to set a new password:\n${config.appUrl}/password/reset/${token}\n\nIf you did not ask for this, ignore this email.`,
  });
}

async function resetWithToken(token, next) {
  checkStrength(next);
  const user = await db.one(
    'SELECT user_id FROM attendance.users WHERE reset_token_hash = $1 AND reset_expires_at > now() AND status = $2',
    [sha256(token), 'active']
  );
  if (!user) throw invalid('This reset link is no longer valid. Ask for a new one.');
  await db.query(
    `UPDATE attendance.users SET password_hash = $2, must_change_password = false, reset_token_hash = NULL,
            reset_expires_at = NULL, failed_attempts = 0, locked_until = NULL WHERE user_id = $1`,
    [user.user_id, await hashPassword(next)]
  );
  await db.query('UPDATE attendance.user_sessions SET logout_at = now() WHERE user_id = $1 AND logout_at IS NULL', [user.user_id]);
}

module.exports = { activeColleges, login, logout, changePassword, requestReset, resetWithToken, checkStrength };
