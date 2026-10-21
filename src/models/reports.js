'use strict';
const db = require('../config/db');
const { Where } = require('../utils/sql');
const { NIL_UUID } = require('./attendance');

/** Students below the threshold in a subject, for their current semester. */
async function defaulters(scope, f, threshold, pg) {
  const w = new Where().add('ss.percentage < ?', threshold);
  w.parts.push("x.enrollment_status = 'active'", 'ss.semester_id = sec.semester_id');
  if (scope.collegeId) w.add('x.college_id = ?', scope.collegeId);
  if (scope.role === 'hod') w.add('sec.department_id = ?', scope.departmentId || 0);
  if (scope.role === 'student') w.add('x.student_id = ?', scope.studentId || NIL_UUID);
  if (scope.role === 'staff') {
    w.parts.push(`EXISTS (SELECT 1 FROM attendance.timetable t WHERE t.staff_id = ${w.p(scope.staffId || 0)}
                           AND t.subject_id = ss.subject_id AND t.section_id = x.section_id)`);
  }
  w.opt('x.section_id = ?', f.section_id);
  w.opt('ss.subject_id = ?', f.subject_id);
  w.opt('sec.department_id = ?', f.department_id);
  const from = `
    FROM attendance.subject_summary ss
    JOIN identity.students x ON x.student_id = ss.student_id
    JOIN attendance.subjects sub ON sub.subject_id = ss.subject_id
    JOIN attendance.sections sec ON sec.section_id = x.section_id
    JOIN attendance.departments d ON d.department_id = sec.department_id
    JOIN attendance.semesters sem ON sem.semester_id = sec.semester_id
    ${w}`;
  const total = (await db.one(`SELECT count(*)::int AS n ${from}`, w.params)).n;
  const rows = await db.many(
    `SELECT x.student_id, x.full_name, x.register_no, x.roll_no,
            d.department_code || ' Sem ' || sem.semester_no || ' ' || sec.section_name AS section_label,
            sub.subject_code, sub.subject_name, ss.total_classes, ss.attended_classes, ss.absent_classes,
            ss.excused_classes, ss.percentage
       ${from}
      ORDER BY ss.percentage, section_label, x.register_no ${pg ? `LIMIT ${pg.limit} OFFSET ${pg.offset}` : ''}`,
    w.params
  );
  return { rows, total };
}

const logExport = (userId, name, type, filePath) =>
  db.query('INSERT INTO attendance.report_exports (exported_by, report_name, report_type, file_path) VALUES ($1, $2, $3, $4)', [userId, name, type, filePath]);

module.exports = { defaulters, logExport };
