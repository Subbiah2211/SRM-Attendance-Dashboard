'use strict';
const enrolment = require('../services/enrolment');
const model = require('../models/attendance');
const timetable = require('../models/timetable');
const master = require('../models/master');
const service = require('../services/attendance');
const settings = require('../services/settings');
const exporter = require('../services/export');
const audit = require('../services/audit');
const { pct } = require('../models/common');
const { notFound } = require('../utils/errors');
const { addDays, isDate, fmtClock } = require('../utils/dates');
const { idOrNull, dateRange, pager } = require('./helpers');

const STATUS_LABEL = { scheduled: 'Open', closed: 'Closed', needs_manual: 'Needs manual marking', cancelled: 'Cancelled' };

function filtersOf(req) {
  const range = dateRange(req.query, req.scope.timezone);
  return {
    ...range,
    section_id: idOrNull(req.query.section_id), subject_id: idOrNull(req.query.subject_id),
    staff_id: idOrNull(req.query.staff_id), period_id: idOrNull(req.query.period_id),
    status: ['scheduled', 'closed', 'needs_manual'].includes(req.query.status) ? req.query.status : null,
  };
}

async function describe(req, f) {
  const parts = [f.from === f.to ? `Date ${f.from}` : `${f.from} to ${f.to}`];
  if (f.section_id) parts.push('one class');
  if (f.subject_id) parts.push('one subject');
  if (f.staff_id) parts.push('one staff member');
  if (f.period_id) parts.push('one period');
  if (f.status) parts.push(STATUS_LABEL[f.status]);
  return `${req.scope.collegeName || 'All colleges'}. ${parts.join(', ')}.`;
}

/** Sessions with counts, filtered by date or range, class, subject, staff and period. */
async function index(req, res) {
  const f = filtersOf(req);
  const exc = await settings.get(req.scope.collegeId, 'excused_counts_as_attended', true);
  const pg = pager(req, 0);
  const { rows, total } = await model.sessions(req.scope, f, pg);
  const staffRoles = ['superadmin', 'admin', 'hod'];
  res.page('attendance/index', {
    title: 'Attendance', filters: f, statusLabel: STATUS_LABEL,
    sessions: rows.map((r) => ({ ...r, percentage: pct(r.present, r.excused, r.marked, exc) })),
    pager: pager(req, total),
    options: {
      sections: await timetable.sections(req.scope),
      subjects: req.scope.collegeId && req.user.role !== 'student' ? await master.options(req.scope, 'subjects') : [],
      staff: staffRoles.includes(req.user.role) ? await timetable.staffOptions(req.scope) : [],
      periods: req.scope.collegeId ? await master.options(req.scope, 'periods') : [],
    },
  });
}

async function exportIndex(req, res) {
  const f = filtersOf(req);
  const exc = await settings.get(req.scope.collegeId, 'excused_counts_as_attended', true);
  const { rows } = await model.sessions(req.scope, f, { limit: 5000, offset: 0 });
  await exporter.send(req, res, {
    name: 'attendance', title: 'Attendance by period', subtitle: await describe(req, f),
    columns: [
      { header: 'Date', key: 'session_date', width: 12 }, { header: 'Period', key: 'period_no', width: 7 },
      { header: 'Class', key: 'section_label', width: 28 }, { header: 'Subject', key: 'subject', width: 30 },
      { header: 'Staff', key: 'staff_name', width: 22 }, { header: 'Room', key: 'room', width: 12 },
      { header: 'Present', key: 'present', width: 9 }, { header: 'Late', key: 'late', width: 7 },
      { header: 'Absent', key: 'absent', width: 8 }, { header: 'Excused', key: 'excused', width: 9 },
      { header: 'Not marked', key: 'unmarked', width: 10 }, { header: '%', key: 'percentage', width: 7 }, { header: 'Status', key: 'state', width: 18 },
    ],
    rows: rows.map((r) => ({ ...r, unmarked: r.strength - r.marked, subject: `${r.subject_code} ${r.subject_name}`, percentage: pct(r.present, r.excused, r.marked, exc), state: STATUS_LABEL[r.status] })),
  }, req.query.format);
}

async function loadSession(req) {
  if (!isDate(req.params.date)) throw notFound('That class does not exist on that date.');
  const s = await model.session(req.scope, req.params.timetableId, req.params.date);
  if (!s) throw notFound('That class does not exist on that date.');
  return s;
}

async function showSession(req, res) {
  const s = await loadSession(req);
  const students = await model.sessionStudents(s, req.scope.role === 'student' ? req.scope.studentId || model.NIL_UUID : null);
  const started = new Date(s.starts_at).getTime() <= Date.now();
  res.page('attendance/session', {
    title: `${s.subject_code} period ${s.period_no}`, session: s, students, statusLabel: STATUS_LABEL, statuses: service.STATUSES,
    canModify: req.can('corrections', 'edit') && started && (await service.canModify(req.scope, s)),
    prev: addDays(s.session_date, -7), next: addDays(s.session_date, 7),
  });
}

async function exportSession(req, res) {
  const s = await loadSession(req);
  const students = await model.sessionStudents(s);
  await exporter.send(req, res, {
    name: 'period-attendance', title: `${s.section_label}: ${s.subject_code} ${s.subject_name}`,
    subtitle: `${s.session_date}, period ${s.period_no}, ${s.staff_name}, room ${s.room}. ${STATUS_LABEL[s.status]}.`,
    columns: [
      { header: 'Roll', key: 'roll_no', width: 8 }, { header: 'Register no', key: 'register_no', width: 20 }, { header: 'Name', key: 'full_name', width: 30 },
      { header: 'Status', key: 'state', width: 12 }, { header: 'First seen', key: 'entry', width: 10 }, { header: 'Last seen', key: 'exit', width: 10 },
      { header: 'Source', key: 'source', width: 10 }, { header: 'Confidence', key: 'conf', width: 10 },
    ],
    rows: students.map((x) => ({
      ...x, state: x.status || 'not marked', entry: fmtClock(x.entry_time, s.timezone), exit: fmtClock(x.exit_time, s.timezone),
      source: x.attendance_source === 'ai' ? 'AI' : x.attendance_source || '', conf: x.confidence === null || x.confidence === undefined ? '' : Number(x.confidence).toFixed(2),
    })),
  }, req.query.format);
}

async function manual(req, res) {
  const out = await service.manualMark(req.scope, req.user.userId, req.params.timetableId, req.params.date, (req.body || {}).status || {});
  await audit.log(req, 'attendance_marked_by_hand', { table: 'records', recordId: `${out.session.timetable_id}/${out.session.session_date}`, newValues: { changed: out.changed } });
  res.done(`/attendance/sessions/${out.session.timetable_id}/${out.session.session_date}`, { changed: out.changed }, `Saved. ${out.changed} records set by hand; the period is closed.`);
}

async function showRecord(req, res) {
  const rec = await model.record(req.scope, req.params.id);
  const s = rec && (await model.session(req.scope, rec.timetable_id, rec.attendance_date));
  if (!rec || !s) throw notFound('That attendance record does not exist.');
  const [corrections, history] = await model.recordHistory(rec);
  res.page('attendance/record', {
    title: `${rec.full_name}: ${s.subject_code}`, record: rec, session: s, corrections, history, statuses: service.STATUSES,
    canModify: req.can('corrections', 'edit') && (await service.canModify(req.scope, s)),
  });
}

async function correct(req, res) {
  const b = req.body || {};
  const out = await service.correct(req.scope, req.user.userId, req.params.id, b.status, b.reason);
  await audit.log(req, 'attendance_corrected', { table: 'records', recordId: out.record.attendance_id, oldValues: { status: out.oldStatus }, newValues: { status: out.newStatus, reason: b.reason } });
  res.done(`/attendance/records/${out.record.attendance_id}`, { old_status: out.oldStatus, new_status: out.newStatus }, `Changed from ${out.oldStatus} to ${out.newStatus}.`);
}

async function student(req, res) {
  const id = req.params.id === 'me' ? req.scope.studentId : req.params.id;
  const st = id && /^[0-9a-f-]{36}$/i.test(id) ? await model.student(req.scope, id) : null;
  if (!st) throw notFound('That student does not exist.');
  const { from, to } = dateRange({ from: req.query.from || addDays(dateRange({}, req.scope.timezone).today, -30), to: req.query.to }, req.scope.timezone);
  const until = isDate(req.query.to) ? to : dateRange({}, req.scope.timezone).today;
  res.page('attendance/student', {
    title: st.full_name, student: st, from, to: until,
    threshold: await settings.get(st.college_id, 'defaulter_threshold_pct', 75),
    subjects: await model.studentSubjects(st.student_id), records: await model.studentRecords(st.student_id, from, until),
    // Face enrolment: the stored photos, and who may clear them.
    facePhotos: enrolment.photos(st), face: await enrolment.student(st.student_id),
    canResetFace: req.user.role !== 'student' && req.can('users', 'edit'),
  });
}

module.exports = { index, exportIndex, showSession, exportSession, manual, showRecord, correct, student };
