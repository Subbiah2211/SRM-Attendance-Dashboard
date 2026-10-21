'use strict';
// URL map. The same router is mounted at / (HTML pages) and /api/v1 (JSON).
// Every protected route names the module and action it needs; data scope is applied in the models.
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config/env');
const { requireLogin, requireCollege, requireSuperadmin } = require('../middlewares/authenticate');
const { permit, permitAny } = require('../middlewares/permit');
const { importFile, enrolPhotos } = require('../middlewares/upload');

const auth = require('../controllers/auth');
const dashboard = require('../controllers/dashboard');
const colleges = require('../controllers/colleges');
const users = require('../controllers/users');
const master = require('../controllers/master');
const imports = require('../controllers/imports');
const timetable = require('../controllers/timetable');
const swaps = require('../controllers/swaps');
const attendance = require('../controllers/attendance');
const reports = require('../controllers/reports');
const cameras = require('../controllers/cameras');
const misc = require('../controllers/misc');
const enrolment = require('../controllers/enrolment');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  skip: () => config.nodeEnv === 'test',
  message: { code: 'too_many_attempts', message: 'Too many sign-in attempts. Try again in a few minutes.' },
});

// ---- public
router.get('/', (req, res) => res.redirect(req.user ? '/dashboard' : '/login'));
router.get('/health', (req, res) => res.json({ ok: true }));
router.get('/login', auth.showLogin);
router.get('/c/:code/login', auth.showLogin);
router.post(['/login', '/auth/login'], loginLimiter, auth.login);
router.get('/password/forgot', auth.showForgot);
router.post('/password/forgot', loginLimiter, auth.forgot);
router.get('/password/reset/:token', auth.showReset);
router.post('/password/reset/:token', loginLimiter, auth.reset);

// ---- everything below needs a signed-in user
router.use(requireLogin);
router.post(['/logout', '/auth/logout'], auth.logout);
router.get('/auth/me', auth.me);
router.get('/password', auth.showPassword);
router.post(['/password', '/auth/password'], auth.changePassword);

// ---- a student's own face enrolment (required at first sign-in)
router.get('/enroll', enrolment.show);
router.post('/enroll', enrolPhotos, enrolment.submit);
router.get('/students/:id/photos/:file', permit('attendance'), enrolment.photo);
router.post('/students/:id/enrolment/reset', permit('users', 'edit'), enrolment.reset);

// ---- dashboard
router.get('/dashboard', permit('dashboard'), dashboard.index);
router.get('/dashboard/summary', permit('dashboard'), dashboard.summary);
router.get('/dashboard/period-grid', permit('dashboard'), dashboard.periodGrid);
router.get('/dashboard/trend', permit('dashboard'), dashboard.trend);

// ---- colleges and module permissions (superadmin assigns; admin views own college)
router.get('/colleges', requireSuperadmin, colleges.index);
router.get('/colleges/new', requireSuperadmin, colleges.form);
router.post('/colleges', requireSuperadmin, colleges.save);
router.get('/colleges/:id/edit', requireSuperadmin, colleges.form);
router.route('/colleges/:id').post(requireSuperadmin, colleges.save).patch(requireSuperadmin, colleges.save);
router.post('/colleges/:id/enter', requireSuperadmin, colleges.enter);
router.get('/modules', permit('permissions'), colleges.modules);
router.get('/permissions', permit('permissions'), colleges.showPermissions);
router.get('/colleges/:id/permissions', permit('permissions'), colleges.showPermissions);
router.route('/colleges/:id/permissions').post(requireSuperadmin, colleges.savePermissions).put(requireSuperadmin, colleges.savePermissions);

// ---- users
router.get('/users', permit('users'), users.index);
router.get('/users/new', permit('users', 'edit'), users.form);
router.post('/users', permit('users', 'edit'), users.create);
router.get('/users/:id/edit', permit('users', 'edit'), users.form);
router.route('/users/:id').post(permit('users', 'edit'), users.update).patch(permit('users', 'edit'), users.update);
router.post('/users/:id/status', permit('users', 'delete'), users.status);
router.post('/users/:id/reset-password', permit('users', 'edit'), users.resetPassword);

// ---- master data and academic setup (generic lists; the entity decides the module)
router.get('/master/:entity', master.guard('view'), master.index);
router.get('/master/:entity/new', requireCollege, master.guard('edit'), master.form);
router.post('/master/:entity', requireCollege, master.guard('edit'), master.save);
router.get('/master/:entity/:id/edit', master.guard('edit'), master.form);
router.route('/master/:entity/:id').post(requireCollege, master.guard('edit'), master.save).patch(requireCollege, master.guard('edit'), master.save)
  .delete(master.guard('delete'), master.remove);
router.post('/master/:entity/:id/delete', master.guard('delete'), master.remove);

// ---- uploads: departments, subjects, timetable, staff, students, classrooms, sections
router.get('/imports', permit('master_data'), imports.index);
router.get('/imports/templates/:type', permit('master_data'), imports.template);
router.post('/imports', permit('master_data', 'edit'), requireCollege, importFile, imports.upload);
router.get('/imports/:id', permit('master_data'), imports.show);
router.get('/imports/:id/errors', permit('master_data'), imports.errors);
router.get('/imports/:id/setup', permit('master_data', 'edit'), imports.setupForm);
router.post('/imports/:id/setup', permit('master_data', 'edit'), imports.setupApply);
router.route('/imports/:id/rows/:rowId').post(permit('master_data', 'edit'), imports.updateRow).patch(permit('master_data', 'edit'), imports.updateRow)
  .delete(permit('master_data', 'edit'), imports.removeRow);
router.post('/imports/:id/rows/:rowId/delete', permit('master_data', 'edit'), imports.removeRow);
router.post('/imports/:id/commit', permit('master_data', 'edit'), imports.commit);
router.route('/imports/:id').delete(permit('master_data', 'edit'), imports.cancel);
router.post('/imports/:id/cancel', permit('master_data', 'edit'), imports.cancel);

// ---- timetable
router.get('/timetable', permit('timetable'), timetable.index);
router.get('/timetable/export', permit('timetable', 'export'), timetable.exportGrid);
router.get('/timetable/slots/new', permit('timetable', 'edit'), requireCollege, timetable.slotForm);
router.route('/timetable/slots').post(permit('timetable', 'edit'), requireCollege, timetable.saveSlot).put(permit('timetable', 'edit'), requireCollege, timetable.saveSlot);
router.post('/timetable/slots/:id/close', permitAny(['timetable', 'delete'], ['timetable', 'edit']), timetable.closeSlot);
router.delete('/timetable/slots/:id', permitAny(['timetable', 'delete'], ['timetable', 'edit']), timetable.closeSlot);

// ---- class swaps
router.get('/class-swaps', permit('class_swaps'), swaps.index);
router.post('/class-swaps', permit('class_swaps', 'edit'), requireCollege, swaps.create);
router.post('/class-swaps/:id/decision', permit('class_swaps', 'edit'), swaps.decide);

// ---- attendance
router.get('/attendance', permit('attendance'), attendance.index);
router.get('/attendance/export', permit('attendance', 'export'), attendance.exportIndex);
router.get('/attendance/sessions/:timetableId/:date', permit('attendance'), attendance.showSession);
router.get('/attendance/sessions/:timetableId/:date/export', permit('attendance', 'export'), attendance.exportSession);
router.post('/attendance/sessions/:timetableId/:date/manual', permit('corrections', 'edit'), attendance.manual);
router.get('/attendance/records/:id', permit('attendance'), attendance.showRecord);
router.route('/attendance/:id').post(permit('corrections', 'edit'), attendance.correct).patch(permit('corrections', 'edit'), attendance.correct);
router.get('/students/:id/attendance', permit('attendance'), attendance.student);

// ---- reports
router.get('/reports/defaulters', permit('reports'), reports.defaulters);
router.get('/reports/defaulters/export', permit('reports', 'export'), reports.exportDefaulters);

// ---- cameras and unknown faces
router.get('/cameras/view', permit('camera_view'), cameras.view);
router.get('/cameras/health', permit('cameras'), cameras.health);
router.get('/unknown-detections', permit('cameras'), cameras.unknown);
router.post('/unknown-detections/:id/review', permit('cameras', 'edit'), cameras.review);

// ---- notifications, audit log, settings
router.get('/notifications', permit('notifications'), misc.notificationList);
router.route('/notifications/read').post(permit('notifications'), misc.notificationRead);
router.route('/notifications/:id/read').post(permit('notifications'), misc.notificationRead).patch(permit('notifications'), misc.notificationRead);
router.get('/audit-logs', permit('audit_log'), misc.auditList);
router.get('/settings', permit('settings'), misc.settingsForm);
router.route('/settings').post(permit('settings', 'edit'), misc.settingsSave).put(permit('settings', 'edit'), misc.settingsSave);

module.exports = router;
