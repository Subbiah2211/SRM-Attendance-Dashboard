'use strict';
const db = require('../config/db');
const model = require('../models/swaps');
const timetable = require('../models/timetable');
const master = require('../models/master');
const notifications = require('../services/notifications');
const audit = require('../services/audit');
const { notFound, invalid, forbidden, conflict } = require('../utils/errors');
const { todayIn, isDate, isoDow, addDays, DAY_NAMES } = require('../utils/dates');
const { pager } = require('./helpers');

async function index(req, res) {
  const pg = pager(req, 0);
  const { rows, total } = await model.list(req.scope, pg);
  const today = todayIn(req.scope.timezone);
  // Slots a staff member can ask a substitute for: their own. HOD and admin: any in scope.
  const mySlots = req.scope.collegeId && req.can('class_swaps', 'edit')
    ? await timetable.slotsOn(req.scope, { staffId: req.scope.role === 'staff' ? req.scope.staffId : null, date: today })
    : [];
  res.page('swaps/index', {
    title: 'Class swaps', swaps: rows, pager: pager(req, total), today, dayNames: DAY_NAMES,
    slots: mySlots.slice(0, 500), staff: req.scope.collegeId ? await master.options({ ...req.scope, role: 'admin' }, 'staff') : [],
    canRequest: req.can('class_swaps', 'edit') && !!req.scope.collegeId,
    canDecide: req.can('class_swaps', 'edit') && ['hod', 'admin', 'superadmin'].includes(req.user.role),
  });
}

async function create(req, res) {
  const b = req.body || {};
  const slot = await timetable.getSlot(req.scope, b.timetable_id);
  if (!slot) throw notFound('That class does not exist.');
  if (req.scope.role === 'staff' && slot.staff_id !== req.scope.staffId) throw forbidden('You can ask for a substitute only for your own classes.');
  const today = todayIn(req.scope.timezone);
  if (!isDate(b.swap_date) || b.swap_date < today) throw invalid('Choose today or a later date.');
  if (isoDow(b.swap_date) !== slot.day_of_week) throw invalid(`That class runs on ${DAY_NAMES[slot.day_of_week]}; ${b.swap_date} is a ${DAY_NAMES[isoDow(b.swap_date)]}.`);
  if (slot.effective_from > b.swap_date || (slot.effective_to && slot.effective_to < b.swap_date)) throw invalid('That class is not in the timetable on that date.');
  const repl = (await master.options({ ...req.scope, role: 'admin' }, 'staff')).find((s) => String(s.value) === String(b.replacement_staff_id));
  if (!repl || repl.value === slot.staff_id) throw invalid('Choose a different staff member as the substitute.');
  const busy = await db.one(
    `SELECT 1 FROM attendance.timetable t WHERE t.staff_id = $1 AND t.day_of_week = $2 AND t.period_id = $3
        AND t.effective_from <= $4 AND (t.effective_to IS NULL OR t.effective_to >= $4)`,
    [repl.value, slot.day_of_week, slot.period_id, b.swap_date]
  );
  if (busy) throw conflict('The substitute already has a class in that period.');
  const swap = await db.one(
    `INSERT INTO attendance.class_swaps (original_staff_id, replacement_staff_id, timetable_id, swap_date, reason)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [slot.staff_id, repl.value, slot.timetable_id, b.swap_date, String(b.reason || '').trim().slice(0, 300) || null]
  );
  const hod = await db.one('SELECT hs.user_id FROM attendance.departments d JOIN attendance.staff hs ON hs.staff_id = d.hod_staff_id WHERE d.department_id = $1', [slot.department_id]);
  if (hod) await notifications.notify(hod.user_id, { title: 'Substitution request', message: `${slot.staff_name} asks ${repl.label} to take ${slot.subject_code} (${slot.section_label}) on ${b.swap_date}, period ${slot.period_no}.`, type: 'attendance' });
  await audit.log(req, 'swap_requested', { table: 'class_swaps', recordId: swap.swap_id, newValues: swap });
  res.done('/class-swaps', { swap }, 'Request sent to the HOD.');
}

async function decide(req, res) {
  if (!['hod', 'admin', 'superadmin'].includes(req.user.role)) throw forbidden('Only the HOD or admin can decide a substitution.');
  const swap = await model.get(req.scope, req.params.id);
  if (!swap) throw notFound('That request does not exist.');
  if (swap.status !== 'pending') throw invalid(`This request is already ${swap.status}.`);
  const status = (req.body || {}).decision === 'approve' ? 'approved' : 'rejected';
  if (status === 'approved' && swap.swap_date < addDays(todayIn(req.scope.timezone), 0)) throw invalid('The date of this request has passed.');
  await db.query('UPDATE attendance.class_swaps SET status = $2, approved_by = $3 WHERE swap_id = $1', [swap.swap_id, status, req.user.userId]);
  const note = { title: `Substitution ${status}`, message: `${swap.subject_code} (${swap.section_label}) on ${swap.swap_date}, period ${swap.period_no}: ${status}.`, type: 'attendance' };
  await notifications.notify(swap.original_user_id, note);
  await notifications.notify(swap.replacement_user_id, note);
  await audit.log(req, `swap_${status}`, { table: 'class_swaps', recordId: swap.swap_id, oldValues: { status: 'pending' }, newValues: { status } });
  res.done('/class-swaps', {}, `Request ${status}.`);
}

module.exports = { index, create, decide };
