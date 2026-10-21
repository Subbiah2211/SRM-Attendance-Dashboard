'use strict';
const config = require('../config/env');
const auth = require('../services/auth');
const audit = require('../services/audit');
const { COOKIE, cookieOptions } = require('../middlewares/authenticate');
const { hmac } = require('../utils/crypto');

async function showLogin(req, res) {
  if (req.user) return res.redirect('/dashboard');
  res.page('auth/login', { title: 'Sign in', colleges: await auth.activeColleges(), selected: req.params.code || req.query.college || '', username: '' });
}

async function login(req, res) {
  const { college_code: collegeCode = '', username = '', password = '' } = req.body || {};
  try {
    const { token, user } = await auth.login({ collegeCode, username, password, ip: (req.ip || '').replace(/^::ffff:/, ''), device: req.get('user-agent') });
    res.cookie(COOKIE, token, cookieOptions());
    if (req.isApi) {
      return res.json({ ok: true, role: user.role_name, must_change_password: user.must_change_password, csrf_token: hmac(config.sessionSecret, 'csrf:' + token) });
    }
    res.redirect(303, user.must_change_password ? '/password' : '/dashboard');
  } catch (err) {
    if (req.isApi || !err.status || err.status >= 500) throw err;
    res.status(err.status);
    res.render('auth/login', { title: 'Sign in', colleges: await auth.activeColleges(), selected: collegeCode, username, flash: { kind: 'error', message: err.message } });
  }
}

async function logout(req, res) {
  if (req.sessionToken) {
    await auth.logout(req.sessionToken);
    await audit.log(req, 'logout', { table: 'users', recordId: req.user.userId });
  }
  res.clearCookie(COOKIE, cookieOptions());
  if (req.isApi) return res.json({ ok: true });
  res.redirect(303, '/login');
}

const showPassword = (req, res) => res.page('auth/password', { title: 'Change password', forced: req.user.mustChangePassword });

async function changePassword(req, res) {
  const { current_password: current, new_password: next, confirm_password: confirm } = req.body || {};
  if (next !== confirm) throw Object.assign(new Error('The two new passwords do not match.'), { status: 422 });
  await auth.changePassword(req.user.userId, current, next);
  await audit.log(req, 'password_changed', { table: 'users', recordId: req.user.userId });
  res.done('/dashboard', {}, 'Password changed.');
}

const showForgot = async (req, res) => res.page('auth/forgot', { title: 'Reset password', colleges: await auth.activeColleges() });

async function forgot(req, res) {
  await auth.requestReset({ collegeCode: (req.body || {}).college_code || '', username: (req.body || {}).username || '' });
  res.done('/login', {}, 'If that account has an email address, a reset link has been sent to it.');
}

const showReset = (req, res) => res.page('auth/reset', { title: 'Set a new password', token: req.params.token });

async function reset(req, res) {
  const { new_password: next, confirm_password: confirm } = req.body || {};
  if (next !== confirm) throw Object.assign(new Error('The two passwords do not match.'), { status: 422 });
  await auth.resetWithToken(req.params.token, next);
  res.done('/login', {}, 'Password set. Sign in with the new password.');
}

const me = (req, res) => res.json({ user: req.user, scope: req.scope, permissions: req.permissions });

module.exports = { showLogin, login, logout, showPassword, changePassword, showForgot, forgot, showReset, reset, me };
