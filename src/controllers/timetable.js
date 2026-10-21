'use strict';
const model = require('../models/timetable');
const master = require('../models/master');
const service = require('../services/timetable');
const audit = require('../services/audit');
const exporter = require('../services/export');
const { notFound } = require('../utils/errors');
const { todayIn, isDate, addDays, DAY_NAMES } = require('../utils/dates');
const { idOrNull } = require('./helpers');

async function load(req) {
  const { scope } = req;
  const date = isDate(req.query.date) ? req.query.date : todayIn(scope.timezone);
  const sections = await model.sections(scope);
  let sectionId = idOrNull(req.query.section_id);
  let staffId = idOrNull(req.query.staff_id);
  // Sensible start: a student's own section, a staff member's own week, else the first section.
  if (!sectionId && !staffId) {
    if (scope.role === 'staff') staffId = scope.staffId;
    else sectionId = scope.role === 'student' ? scope.studentSectionId : sections[0] && sections[0].value;
  }
  if (scope.role === 'staff' && staffId && staffId !== scope.staffId) staffId = scope.staffId;
  const slots = sectionId || staffId ? await model.slotsOn(scope, { sectionId, staffId, date }) : [];
  const periods = scope.collegeId ? await model.periods(scope.collegeId) : [];
  const days = [1, 2, 3, 4, 5, 6].concat(slots.some((s) => s.day_of_week === 7) ? [7] : []);
  const cells = {};
  for (const s of slots) (cells[`${s.day_of_week}|${s.period_id}`] = cells[`${s.day_of_week}|${s.period_id}`] || []).push(s);
  return { date, sections, sectionId, staffId, slots, periods, days, cells };
}

async function index(req, res) {
  const d = await load(req);
  res.page('timetable/index', {
    title: 'Timetable', ...d, dayNames: DAY_NAMES,
    staffOptions: ['admin', 'hod', 'superadmin'].includes(req.user.role) ? await model.staffOptions(req.scope) : [],
    canEdit: req.can('timetable', 'edit') && !!d.sectionId && req.scope.role !== 'staff',
    canDelete: req.can('timetable', 'delete') || req.can('timetable', 'edit'),
    history: d.slots.length ? await model.history(d.slots.map((s) => s.timetable_id)) : [],
  });
}

async function exportGrid(req, res) {
  const d = await load(req);
  const rows = d.slots.map((s) => ({ day: DAY_NAMES[s.day_of_week], period: s.period_no, time: `${String(s.start_time).slice(0, 5)}-${String(s.end_time).slice(0, 5)}`, section: s.section_label, subject: `${s.subject_code} ${s.subject_name}`, staff: s.staff_name, room: s.room }));
  await exporter.send(req, res, {
    name: 'timetable', title: 'Timetable', subtitle: `In effect on ${d.date}`,
    columns: [{ header: 'Day', key: 'day', width: 12 }, { header: 'Period', key: 'period', width: 8 }, { header: 'Time', key: 'time', width: 12 }, { header: 'Section', key: 'section', width: 28 }, { header: 'Subject', key: 'subject', width: 34 }, { header: 'Staff', key: 'staff', width: 22 }, { header: 'Room', key: 'room', width: 14 }],
    rows,
  }, req.query.format);
}

async function slotForm(req, res) {
  const section = await model.getSection(req.scope, req.query.section_id);
  if (!section) throw notFound('That section does not exist.');
  const day = parseInt(req.query.day, 10), periodId = idOrNull(req.query.period_id);
  // With timetable_id the form changes that class; without it, it adds one (a period can hold several).
  const existing = req.query.timetable_id ? await model.getSlot(req.scope, req.query.timetable_id) : null;
  if (req.query.timetable_id && (!existing || existing.section_id !== section.section_id || !existing.is_active)) throw notFound('That class is no longer in the timetable.');
  const all = { ...req.scope, role: 'admin' }; // an HOD may assign staff and rooms of other departments
  res.page('timetable/slot', {
    title: existing ? 'Change class' : 'Add class', section, day: existing ? existing.day_of_week : day, periodId: existing ? existing.period_id : periodId, existing, dayNames: DAY_NAMES,
    defaultFrom: addDays(todayIn(req.scope.timezone), 1),
    options: { periods: await master.options(all, 'periods'), subjects: await master.options(all, 'subjects'), staff: await master.options(all, 'staff'), classrooms: await master.options(all, 'classrooms') },
  });
}

async function saveSlot(req, res) {
  const { row, old } = await service.saveSlot(req.scope, req.user.userId, req.body || {});
  await audit.log(req, old ? 'timetable_slot_replaced' : 'timetable_slot_created', { table: 'timetable', recordId: row.timetable_id, oldValues: old, newValues: row });
  res.done(`/timetable?section_id=${row.section_id}&date=${row.effective_from}`, { slot: row }, `Slot saved, in effect from ${row.effective_from}.`);
}

async function closeSlot(req, res) {
  const slot = await service.closeSlot(req.scope, req.user.userId, req.params.id, (req.body || {}).effective_from);
  await audit.log(req, 'timetable_slot_closed', { table: 'timetable', recordId: slot.timetable_id, oldValues: slot });
  res.done(`/timetable?section_id=${slot.section_id}`, {}, 'Slot closed. Past attendance for it is kept.');
}

module.exports = { index, exportGrid, slotForm, saveSlot, closeSlot };
