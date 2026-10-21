'use strict';
const model = require('../models/users');
const master = require('../models/master');
const timetable = require('../models/timetable');
const service = require('../services/users');
const audit = require('../services/audit');
const { notFound } = require('../utils/errors');
const { pager, idOrNull } = require('./helpers');

async function index(req, res) {
  const f = { role: req.query.role || '', department_id: idOrNull(req.query.department_id), status: req.query.status || '', q: (req.query.q || '').trim() };
  const pg = pager(req, 0);
  const { rows, total } = await model.list(req.scope, f, pg);
  res.page('users/index', {
    title: 'Users', users: rows, filters: f, pager: pager(req, total),
    departments: req.scope.collegeId ? await master.options(req.scope, 'departments') : [],
    creatable: service.creatable(req.scope),
  });
}

async function form(req, res) {
  const user = req.params.id ? await model.get(req.scope, req.params.id) : null;
  if (req.params.id && !user) throw notFound('That user does not exist.');
  res.page('users/form', {
    title: user ? 'Edit user' : 'Add a user', editUser: user, creatable: service.creatable(req.scope),
    departments: req.scope.collegeId ? await master.options(req.scope, 'departments') : [],
    sections: req.scope.collegeId ? await timetable.sections(req.scope) : [],
  });
}

async function create(req, res) {
  const out = await service.create(req.scope, req.body || {});
  await audit.log(req, 'user_created', { table: 'users', recordId: out.userId, newValues: { username: req.body.username, role: out.role } });
  res.done('/users', { user_id: out.userId, temporary_password: out.password },
    `User created. One-time password: ${out.password} (shown once; the user must change it at first sign-in).`);
}

async function update(req, res) {
  const before = await service.update(req.scope, req.params.id, req.body || {});
  await audit.log(req, 'user_updated', { table: 'users', recordId: before.user_id, oldValues: { first_name: before.first_name, last_name: before.last_name, email: before.email, mobile: before.mobile }, newValues: req.body });
  res.done('/users', {}, 'User saved.');
}

async function status(req, res) {
  const next = (req.body || {}).status === 'active' ? 'active' : 'inactive';
  const user = await service.setStatus(req.scope, req.user.userId, req.params.id, next);
  await audit.log(req, next === 'active' ? 'user_reactivated' : 'user_deactivated', { table: 'users', recordId: user.user_id, oldValues: { status: user.status }, newValues: { status: next } });
  res.done('/users', {}, next === 'active' ? 'User reactivated.' : 'User deactivated and signed out.');
}

async function resetPassword(req, res) {
  const { user, password } = await service.resetPassword(req.scope, req.params.id);
  await audit.log(req, 'password_reset_by_admin', { table: 'users', recordId: user.user_id });
  res.done('/users', { temporary_password: password }, `New one-time password for ${user.username}: ${password} (shown once).`);
}

module.exports = { index, form, create, update, status, resetPassword };
