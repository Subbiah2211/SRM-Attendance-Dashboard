'use strict';
const notifications = require('../services/notifications');
const settings = require('../services/settings');
const audit = require('../services/audit');
const auditModel = require('../models/audit');
const { isDate } = require('../utils/dates');
const { pager, idOrNull } = require('./helpers');

// ---------------------------------------------------------------- notifications
async function notificationList(req, res) {
  const pg = pager(req, 0, 30);
  res.page('notifications/index', { title: 'Notifications', items: await notifications.list(req.user.userId, pg.limit, pg.offset), page: pg.page });
}
async function notificationRead(req, res) {
  await notifications.markRead(req.user.userId, idOrNull(req.params.id));
  res.done('/notifications', {});
}

// ---------------------------------------------------------------- audit log
async function auditList(req, res) {
  const f = { action: req.query.action || '', q: (req.query.q || '').trim(), from: isDate(req.query.from) ? req.query.from : '', to: isDate(req.query.to) ? req.query.to : '' };
  const pg = pager(req, 0);
  const { rows, total } = await auditModel.list(req.scope, f, pg);
  res.page('audit/index', { title: 'Audit log', rows, filters: f, pager: pager(req, total), actions: (await auditModel.actions(req.scope)).map((a) => a.action) });
}

// ---------------------------------------------------------------- settings
async function settingsForm(req, res) {
  res.page('settings/index', {
    title: req.scope.collegeId ? 'College settings' : 'Group default settings',
    keys: settings.KEYS, values: await settings.all(req.scope.collegeId), canEdit: req.can('settings', 'edit'),
  });
}
async function settingsSave(req, res) {
  const before = await settings.all(req.scope.collegeId);
  const body = { ...(req.body || {}) };
  // A browser form sends nothing for an unticked box; an API call changes only the keys it names.
  for (const [k, def] of Object.entries(settings.KEYS)) {
    if (def.type !== 'bool') continue;
    if (req.isApi && body[k] === undefined) continue;
    body[k] = body[k] === 'on' || body[k] === 'true' || body[k] === true;
  }
  const saved = await settings.save(req.scope.collegeId, body);
  await audit.log(req, 'settings_changed', { table: 'system_settings', oldValues: before, newValues: saved });
  res.done('/settings', { settings: saved }, 'Settings saved.');
}

module.exports = { notificationList, notificationRead, auditList, settingsForm, settingsSave };
