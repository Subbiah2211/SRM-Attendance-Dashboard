'use strict';
const db = require('../config/db');
const model = require('../models/attendance');
const settings = require('./settings');
const { notFound, forbidden, invalid } = require('../utils/errors');

const STATUSES = ['present', 'late', 'absent', 'excused'];

/** Who may correct or hand-mark a session: admin (college), HOD (department), staff (own period, inside the window). */
async function canModify(scope, s) {
  if (scope.role === 'superadmin' || scope.role === 'admin') return true;
  if (scope.role === 'hod') return s.department_id === scope.departmentId;
  if (scope.role === 'staff') {
    if (s.staff_id !== scope.staffId && s.scheduled_staff_id !== scope.staffId) return false;
    const hours = await settings.get(s.college_id, 'staff_correction_window_hours', 48);
    return Date.now() <= new Date(s.ends_at).getTime() + hours * 3600000;
  }
  return false;
}

/** Recompute the summaries a change touches. */
async function refreshSummaries(client, date, semesterId, studentIds) {
  await client.query('SELECT attendance.refresh_daily_summary($1)', [date]);
  await client.query('SELECT attendance.refresh_subject_summary($1, $2::uuid[])', [semesterId, studentIds]);
}

/** Change one record's status. The reason is mandatory; old and new status are kept. */
async function correct(scope, userId, attendanceId, newStatus, reason) {
  if (!STATUSES.includes(newStatus)) throw invalid('Choose a status.');
  if (!reason || reason.trim().length < 5) throw invalid('Give a reason of at least 5 characters.');
  const rec = await model.record(scope, attendanceId);
  if (!rec) throw notFound('That attendance record does not exist.');
  const s = await model.session(scope, rec.timetable_id, rec.attendance_date);
  if (!s) throw notFound('That attendance record does not exist.');
  if (!(await canModify(scope, s))) throw forbidden('You can no longer correct this period.');
  if (rec.status === newStatus) throw invalid('The record already has that status.');
  await db.tx(async (c) => {
    await c.query(
      `UPDATE attendance.records SET status = $2, attendance_source = 'manual', marked_by = $3 WHERE attendance_id = $1`,
      [rec.attendance_id, newStatus, userId]
    );
    await c.query(
      `INSERT INTO attendance.corrections (attendance_id, old_status, new_status, reason, corrected_by) VALUES ($1, $2, $3, $4, $5)`,
      [rec.attendance_id, rec.status, newStatus, reason.trim(), userId]
    );
    await refreshSummaries(c, rec.attendance_date, rec.semester_id, [rec.student_id]);
  });
  return { record: rec, oldStatus: rec.status, newStatus };
}

/** Mark a whole period by hand (camera offline, opted-out students, and so on). */
async function manualMark(scope, userId, timetableId, date, statuses) {
  const s = await model.session(scope, timetableId, date);
  if (!s) throw notFound('That class does not exist on that date.');
  if (!(await canModify(scope, s))) throw forbidden('You can no longer mark this period.');
  if (new Date(s.starts_at).getTime() > Date.now()) throw invalid('This period has not started yet.');
  const roster = await model.sessionStudents(s);
  const marks = [];
  for (const st of roster) {
    const v = statuses && statuses[st.student_id];
    if (!v || st.elsewhere) continue; // already marked in a parallel class of this period
    if (!STATUSES.includes(v)) throw invalid('Choose a status for every student you mark.');
    if (st.status !== v || st.attendance_source !== 'manual') marks.push({ student_id: st.student_id, status: v });
  }
  await db.tx(async (c) => {
    for (const m of marks) {
      await c.query(
        `INSERT INTO attendance.records (student_id, timetable_id, attendance_date, attendance_source, status, marked_by)
         VALUES ($1, $2, $3, 'manual', $4, $5)
         ON CONFLICT (student_id, timetable_id, attendance_date) DO UPDATE
           SET status = EXCLUDED.status, attendance_source = 'manual', marked_by = EXCLUDED.marked_by`,
        [m.student_id, s.timetable_id, s.session_date, m.status, userId]
      );
    }
    await c.query(
      `INSERT INTO attendance.class_sessions (timetable_id, session_date, status, staff_id, closed_at, closed_by, note)
       VALUES ($1, $2, 'closed', $3, now(), $4, 'Marked by hand')
       ON CONFLICT (timetable_id, session_date) DO UPDATE
         SET status = 'closed', closed_at = now(), closed_by = EXCLUDED.closed_by, note = 'Marked by hand'`,
      [s.timetable_id, s.session_date, s.staff_id, userId]
    );
    await refreshSummaries(c, s.session_date, s.semester_id, roster.map((r) => r.student_id));
  });
  return { session: s, changed: marks.length };
}

module.exports = { STATUSES, canModify, refreshSummaries, correct, manualMark };
