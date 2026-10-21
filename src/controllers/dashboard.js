'use strict';
const attendance = require('../models/attendance');
const dashboard = require('../models/dashboard');
const cameras = require('../models/cameras');
const reports = require('../models/reports');
const timetable = require('../models/timetable');
const master = require('../models/master');
const imports = require('../services/imports');
const settings = require('../services/settings');
const db = require('../config/db');
const { pct } = require('../models/common');
const { addDays, isDate, todayIn, daysBetween } = require('../utils/dates');
const { idOrNull } = require('./helpers');

/** Everything in the common block except the scope object, which views read as 'my'. */
const forView = ({ scope, ...rest }) => rest;

const withPct = (rows, exc) => rows.map((r) => ({ ...r, percentage: pct(r.present, r.excused, r.marked, exc) }));

function trendChart(rows, exc) {
  return {
    type: 'line',
    labels: rows.map((r) => r.attendance_date.slice(5)),
    datasets: [{ label: 'Attendance %', data: rows.map((r) => pct(r.present, r.excused, r.marked, exc)) }],
  };
}

/** Doughnut of today's marks: on time, late, absent, excused. */
function splitChart(t) {
  return {
    type: 'doughnut', tones: ['present', 'late', 'absent', 'excused'],
    labels: ['On time', 'Late', 'Absent', 'Excused'],
    datasets: [{ data: [Math.max(t.present - t.late, 0), t.late, t.absent, t.excused] }],
  };
}

/** Sections as rows, periods as columns: the register-style grid. */
function pivot(sessions) {
  const periods = [...new Map(sessions.map((s) => [s.period_no, { period_no: s.period_no, start_time: s.start_time, end_time: s.end_time }])).values()]
    .sort((a, b) => a.period_no - b.period_no);
  const bySection = new Map();
  for (const s of sessions) {
    if (!bySection.has(s.section_id)) bySection.set(s.section_id, { section_id: s.section_id, label: s.section_label, cells: {} });
    const cells = bySection.get(s.section_id).cells;
    (cells[s.period_no] = cells[s.period_no] || []).push(s); // lab batches and electives run in parallel
  }
  return { periods, rows: [...bySection.values()].sort((a, b) => a.label.localeCompare(b.label)) };
}

/** The period the dashboard covers: a preset, a from-to range, or one date. Never later than today. */
function rangeOf(q, today) {
  let from = today, to = today, preset = 'today';
  if (q.range === 'yesterday') { from = to = addDays(today, -1); preset = 'yesterday'; }
  else if (q.range === 'week') { from = addDays(today, -6); preset = 'week'; }
  else if (q.range === 'month') { from = addDays(today, -29); preset = 'month'; }
  else if (isDate(q.from) || isDate(q.to)) {
    from = isDate(q.from) ? q.from : q.to;
    to = isDate(q.to) ? q.to : q.from;
    if (to < from) [from, to] = [to, from];
    preset = 'custom';
  } else if (isDate(q.date)) { from = to = q.date; preset = q.date === today ? 'today' : 'custom'; }
  if (to > today) to = today;
  if (from > to) from = to;
  if (daysBetween(from, to) > 92) from = addDays(to, -92);
  return { from, to, preset, single: from === to };
}

async function common(req) {
  const { scope } = req;
  const today = todayIn(scope.timezone);
  const range = rangeOf(req.query, today);
  const exc = await settings.get(scope.collegeId, 'excused_counts_as_attended', true);
  const threshold = await settings.get(scope.collegeId, 'defaulter_threshold_pct', 75);
  // "date" stays for single-day views (the register, the trend's last day).
  return { scope, today, date: range.to, ...range, exc, threshold, isToday: range.single && range.to === today };
}

const BY = { admin: ['department', 'class', 'subject', 'staff', 'period', 'date'], hod: ['class', 'subject', 'staff', 'period', 'date'], staff: ['class', 'subject', 'period', 'date'] };

/**
 * The filter bar shared by the admin, HOD and staff dashboards: period, department, class,
 * subject, staff, hour and AI camera. Returns the filters, their option lists, the chosen
 * camera with what it is seeing, and the breakdown by the chosen category.
 */
async function board(req, c, role) {
  const q = req.query;
  const cams = req.can('camera_view') ? await cameras.viewable(c.scope) : [];
  const camera = cams.find((x) => x.camera_id === String(q.camera_id || '')) || null;
  const f = {
    from: c.from, to: c.to,
    department_id: role === 'admin' ? idOrNull(q.department_id) : null,
    section_id: idOrNull(q.section_id), subject_id: idOrNull(q.subject_id),
    staff_id: role === 'staff' ? null : idOrNull(q.staff_id), period_id: idOrNull(q.period_id),
    classroom_id: camera ? camera.classroom_id || -1 : null,
  };
  const by = BY[role].includes(q.by) ? q.by : BY[role][0];
  const hasCollege = !!c.scope.collegeId;
  const [totals, rows, sections, subjects, staff, periods, departments, cameraActivity] = await Promise.all([
    attendance.totals(c.scope, f),
    attendance.breakdown(c.scope, f, by),
    timetable.sections(c.scope),
    hasCollege ? master.options(c.scope, 'subjects') : [],
    role === 'staff' ? [] : timetable.staffOptions(c.scope),
    hasCollege ? master.options(c.scope, 'periods') : [],
    role === 'admin' && hasCollege ? master.options(c.scope, 'departments') : [],
    camera ? cameras.activity({ ...camera, college_id: c.scope.collegeId }, c.scope.timezone, 6) : null,
  ]);
  return {
    filters: f, by, byOptions: BY[role], camera, cameraActivity,
    totals: { ...totals, percentage: pct(totals.present, totals.excused, totals.marked, c.exc) },
    breakdown: withPct(rows, c.exc), split: splitChart(totals),
    options: { departments, sections, subjects, staff, periods, cameras: cams },
  };
}

async function superadmin(req, res) {
  const colleges = await dashboard.collegesToday();
  const sum = (k) => colleges.reduce((a, c) => a + (c[k] || 0), 0);
  res.page('dashboard/superadmin', {
    title: 'All colleges', colleges,
    totals: { colleges: colleges.filter((c) => c.is_active).length, students: sum('students'), users: sum('users'), cameras: sum('cameras') },
  });
}

async function admin(req, res) {
  const c = await common(req);
  const b = await board(req, c, 'admin');
  const [manual, cams, unknown, recent, trend] = await Promise.all([
    attendance.sessions(c.scope, { from: addDays(c.today, -2), to: c.today, status: 'needs_manual' }, { limit: 20, offset: 0 }),
    cameras.health(c.scope),
    cameras.unknown(c.scope, false, { limit: 1, offset: 0 }),
    req.can('master_data') ? imports.listBatches(c.scope, { limit: 5, offset: 0 }) : { rows: [] },
    dashboard.trend(c.scope, addDays(c.to, -29), c.to, { department_id: b.filters.department_id, section_id: b.filters.section_id }),
  ]);
  res.page('dashboard/admin', {
    title: 'College dashboard', ...forView(c), ...b, manual: manual.rows,
    cameras: { total: cams.length, online: cams.filter((x) => x.status === 'online').length, offline: cams.filter((x) => x.status === 'offline').length },
    unknownCount: unknown.total, imports: recent.rows, chart: trendChart(trend, c.exc),
  });
}

async function hod(req, res) {
  const c = await common(req);
  const b = await board(req, c, 'hod');
  const [grid, trend, defaulters] = await Promise.all([
    c.single ? attendance.sessions(c.scope, { ...b.filters, order: 'asc' }) : { rows: [] },
    dashboard.trend(c.scope, addDays(c.to, -29), c.to, { section_id: b.filters.section_id }),
    req.can('reports') ? reports.defaulters(c.scope, { section_id: b.filters.section_id, subject_id: b.filters.subject_id }, c.threshold, { limit: 10, offset: 0 }) : { rows: [], total: 0 },
  ]);
  res.page('dashboard/hod', {
    title: 'Department dashboard', ...forView(c), ...b,
    grid: pivot(withPct(grid.rows, c.exc)), chart: trendChart(trend, c.exc), defaulters,
  });
}

async function staff(req, res) {
  const c = await common(req);
  const b = await board(req, c, 'staff');
  const [list, manual] = await Promise.all([
    attendance.sessions(c.scope, { ...b.filters, order: c.single ? 'asc' : 'desc' }, { limit: 100, offset: 0 }),
    attendance.sessions(c.scope, { from: addDays(c.today, -2), to: c.today, status: 'needs_manual' }),
  ]);
  res.page('dashboard/staff', {
    title: 'My classes', ...forView(c), ...b, sessions: withPct(list.rows, c.exc), manual: manual.rows,
    totals: { ...b.totals, classes: b.totals.sessions },
  });
}

async function student(req, res) {
  const c = await common(req);
  const [today, subjects, alerts] = await Promise.all([
    attendance.sessions(c.scope, { from: c.date, to: c.date, order: 'asc' }),
    attendance.studentSubjects(c.scope.studentId || attendance.NIL_UUID),
    db.many(
      `SELECT a.alert_type, a.percentage, sub.subject_code, sub.subject_name FROM attendance.alerts a
         JOIN attendance.subjects sub ON sub.subject_id = a.subject_id WHERE a.student_id = $1 ORDER BY a.percentage`,
      [c.scope.studentId || attendance.NIL_UUID]
    ),
  ]);
  // Overall figure across the current semester's subjects (the semester with the most recent records).
  const current = subjects.length ? subjects.filter((x) => x.semester_no === subjects[0].semester_no) : [];
  const add = (k) => current.reduce((a, r) => a + (r[k] || 0), 0);
  res.page('dashboard/student', {
    title: 'My attendance', ...forView(c), sessions: today.rows, subjects: current, alerts,
    overall: { percentage: pct(add('attended_classes'), add('excused_classes'), add('total_classes'), c.exc), attended: add('attended_classes'), total: add('total_classes'), below: current.filter((x) => x.percentage !== null && x.percentage < c.threshold).length },
  });
}

function index(req, res) {
  const role = req.user.role;
  if (role === 'superadmin' && !req.scope.collegeId) return superadmin(req, res);
  if (role === 'superadmin' || role === 'admin') return admin(req, res);
  if (role === 'hod') return hod(req, res);
  if (role === 'staff') return staff(req, res);
  return student(req, res);
}

// JSON endpoints behind the same permission (used by /api/v1 clients).
async function summary(req, res) {
  const c = await common(req);
  const t = await attendance.totals(c.scope, { from: c.date, to: c.date, section_id: idOrNull(req.query.section_id) });
  res.json({ date: c.date, ...t, percentage: pct(t.present, t.excused, t.marked, c.exc) });
}
async function periodGrid(req, res) {
  const c = await common(req);
  const { rows } = await attendance.sessions(c.scope, { from: c.date, to: c.date, section_id: idOrNull(req.query.section_id), order: 'asc' });
  res.json({ date: c.date, ...pivot(withPct(rows, c.exc)) });
}
async function trend(req, res) {
  const c = await common(req);
  const from = isDate(req.query.from) ? req.query.from : addDays(c.date, -29);
  const to = isDate(req.query.to) ? req.query.to : c.date;
  const rows = await dashboard.trend(c.scope, from, to, { section_id: idOrNull(req.query.section_id), department_id: idOrNull(req.query.department_id) });
  res.json({ from, to, days: withPct(rows, c.exc) });
}

module.exports = { index, summary, periodGrid, trend };
