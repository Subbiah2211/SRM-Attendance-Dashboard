'use strict';
const db = require('../config/db');
const { Where } = require('../utils/sql');
const { scopeSessions } = require('./attendance');

/** One row per college with today's attendance (superadmin landing page). */
const collegesToday = () =>
  db.many(`
    SELECT c.college_id, c.college_code, c.college_name, c.campus, c.is_active,
           (SELECT count(*)::int FROM identity.cameras cam WHERE cam.college_id = c.college_id AND cam.enabled) AS cameras,
           (SELECT count(*)::int FROM attendance.users u WHERE u.college_id = c.college_id AND u.status = 'active') AS users,
           (SELECT count(*)::int FROM identity.students s WHERE s.college_id = c.college_id AND s.enrollment_status = 'active') AS students,
           (SELECT count(*)::int FROM attendance.import_batches b WHERE b.college_id = c.college_id AND b.uploaded_at > now() - interval '7 days') AS uploads_7d,
           a.present, a.excused, a.marked,
           attendance.pct(a.present, a.excused, a.marked, c.college_id) AS percentage
      FROM attendance.colleges c
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE r.status IN ('present', 'late'))::int AS present,
               count(*) FILTER (WHERE r.status = 'excused')::int AS excused,
               count(*)::int AS marked
          FROM attendance.records r JOIN identity.students s ON s.student_id = r.student_id
         WHERE s.college_id = c.college_id AND r.attendance_date = (now() AT TIME ZONE c.timezone)::date) a ON true
     ORDER BY c.college_name`);

/** Attendance per department on one date. */
function departmentsOn(scope, date) {
  const w = new Where();
  const fn = `attendance.sessions_between(${w.p(date)}::date, ${w.p(date)}::date, ${w.p(scope.collegeId || null)}::int)`;
  scopeSessions(w, scope);
  return db.many(
    `SELECT d.department_id, d.department_code, d.department_name, count(*)::int AS sessions,
            count(*) FILTER (WHERE s.status = 'needs_manual')::int AS needs_manual,
            COALESCE(sum(a.present), 0)::int AS present, COALESCE(sum(a.excused), 0)::int AS excused,
            COALESCE(sum(a.absent), 0)::int AS absent, COALESCE(sum(a.marked), 0)::int AS marked
       FROM ${fn} s
       JOIN attendance.departments d ON d.department_id = s.department_id
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE r.status IN ('present', 'late')) AS present,
                count(*) FILTER (WHERE r.status = 'excused') AS excused,
                count(*) FILTER (WHERE r.status = 'absent') AS absent, count(*) AS marked
           FROM attendance.records r WHERE r.timetable_id = s.timetable_id AND r.attendance_date = s.session_date) a ON true
       ${w}
      GROUP BY d.department_id, d.department_code, d.department_name ORDER BY d.department_code`,
    w.params
  );
}

/** Daily totals from the summary table (date ranges read summaries, not raw records). */
function trend(scope, from, to, f = {}) {
  const w = new Where().add('ds.attendance_date BETWEEN ? AND ?', from, to);
  if (scope.collegeId) w.add('d.college_id = ?', scope.collegeId);
  if (scope.role === 'hod') w.add('ds.department_id = ?', scope.departmentId || 0);
  w.opt('ds.department_id = ?', f.department_id);
  w.opt('ds.section_id = ?', f.section_id);
  return db.many(
    `SELECT ds.attendance_date, sum(ds.present_count)::int AS present, sum(ds.excused_count)::int AS excused,
            sum(ds.absent_count)::int AS absent, sum(ds.total_marks)::int AS marked
       FROM attendance.daily_summary ds JOIN attendance.departments d ON d.department_id = ds.department_id
       ${w} GROUP BY ds.attendance_date HAVING sum(ds.total_marks) > 0 ORDER BY ds.attendance_date`,
    w.params
  );
}

module.exports = { collegesToday, departmentsOn, trend };
