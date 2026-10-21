'use strict';
const db = require('../config/db');
const { Where } = require('../utils/sql');
const { SECTION_LABEL, SECTION_JOINS, personName } = require('./common');

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Data scope for rows of attendance.sessions_between (alias s). */
function scopeSessions(w, scope) {
  if (scope.role === 'hod') w.add('s.department_id = ?', scope.departmentId || 0);
  if (scope.role === 'staff') {
    const p = w.p(scope.staffId || 0);
    w.parts.push(`(s.staff_id = ${p} OR s.scheduled_staff_id = ${p} OR EXISTS (
        SELECT 1 FROM attendance.staff_sections ss WHERE ss.staff_id = ${p} AND ss.section_id = s.section_id AND ss.role IN ('class_advisor', 'mentor')))`);
  }
  if (scope.role === 'student') w.add('s.section_id = ?', scope.studentSectionId || 0);
  return w;
}

const SESSION_JOINS = `
  JOIN attendance.sections sec ON sec.section_id = s.section_id
  ${SECTION_JOINS}
  JOIN attendance.colleges col ON col.college_id = s.college_id
  JOIN attendance.periods p ON p.period_id = s.period_id
  JOIN attendance.subjects sub ON sub.subject_id = s.subject_id
  JOIN attendance.staff st ON st.staff_id = s.staff_id
  JOIN attendance.users su ON su.user_id = st.user_id
  JOIN attendance.classrooms c ON c.classroom_id = s.classroom_id`;

const COUNTS = `
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE r.status IN ('present', 'late'))::int AS present,
           count(*) FILTER (WHERE r.status = 'late')::int AS late,
           count(*) FILTER (WHERE r.status = 'absent')::int AS absent,
           count(*) FILTER (WHERE r.status = 'excused')::int AS excused,
           count(*)::int AS marked
      FROM attendance.records r
     WHERE r.timetable_id = s.timetable_id AND r.attendance_date = s.session_date) a ON true
  LEFT JOIN LATERAL (
    -- On the roll of this class: takes the subject, and is not marked in a parallel class of the period.
    SELECT count(*)::int AS strength FROM identity.students x
     WHERE x.section_id = s.section_id AND x.enrollment_status IN ('active', 'opted_out')
       AND attendance.takes_subject(x.student_id, s.subject_id, s.semester_id, s.section_id)
       AND NOT EXISTS (
             SELECT 1 FROM attendance.records r2 JOIN attendance.timetable t2 ON t2.timetable_id = r2.timetable_id
              WHERE r2.student_id = x.student_id AND r2.attendance_date = s.session_date
                AND t2.section_id = s.section_id AND t2.period_id = s.period_id AND t2.timetable_id <> s.timetable_id)) n ON true`;

// Record counts only (the dashboards' totals do not need the roll).
const MARKS = `
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE r.status IN ('present', 'late'))::int AS present,
           count(*) FILTER (WHERE r.status = 'late')::int AS late,
           count(*) FILTER (WHERE r.status = 'absent')::int AS absent,
           count(*) FILTER (WHERE r.status = 'excused')::int AS excused,
           count(*)::int AS marked
      FROM attendance.records r
     WHERE r.timetable_id = s.timetable_id AND r.attendance_date = s.session_date) a ON true`;

const SESSION_COLS = `
  s.session_date, s.timetable_id, s.status, s.section_id, s.department_id, s.college_id, s.semester_id,
  s.staff_id, s.scheduled_staff_id, s.subject_id, s.period_id, s.classroom_id,
  p.period_no, p.start_time, p.end_time,
  ((s.session_date + p.start_time) AT TIME ZONE col.timezone) AS starts_at,
  ((s.session_date + p.end_time) AT TIME ZONE col.timezone) AS ends_at,
  ${SECTION_LABEL} AS section_label, sub.subject_code, sub.subject_name, sub.short_name,
  ${personName('su')} AS staff_name, st.staff_code, su.user_id AS staff_user_id,
  concat_ws(' ', c.block_name, c.room_number) AS room, col.timezone,
  a.present, a.late, a.absent, a.excused, a.marked, n.strength`;

function sessionFilters(w, f) {
  w.opt('s.section_id = ?', f.section_id);
  w.opt('s.subject_id = ?', f.subject_id);
  w.opt('s.staff_id = ?', f.staff_id);
  w.opt('s.period_id = ?', f.period_id);
  w.opt('s.department_id = ?', f.department_id);
  w.opt('s.status = ?', f.status);
  w.opt('s.timetable_id = ?', f.timetable_id);
  w.opt('s.classroom_id = ?', f.classroom_id); // the room of a chosen camera
  return w;
}

/**
 * Class sessions between two dates with attendance counts.
 * f: { from, to, section_id, subject_id, staff_id, period_id, department_id, status, timetable_id }
 */
async function sessions(scope, f, pg) {
  const w = new Where();
  const fn = `attendance.sessions_between(${w.p(f.from)}::date, ${w.p(f.to)}::date, ${w.p(scope.collegeId || null)}::int)`;
  scopeSessions(w, scope);
  sessionFilters(w, f);
  const mine = scope.role === 'student'
    ? `, (SELECT r.status FROM attendance.records r WHERE r.timetable_id = s.timetable_id AND r.attendance_date = s.session_date AND r.student_id = ${w.p(scope.studentId || NIL_UUID)}) AS my_status`
    : '';
  const from = `FROM ${fn} s ${SESSION_JOINS}`;
  const order = f.order === 'asc' ? 's.session_date, p.period_no, section_label' : 's.session_date DESC, p.period_no, section_label';
  const limit = pg ? `LIMIT ${pg.limit} OFFSET ${pg.offset}` : '';
  const rows = await db.many(`SELECT ${SESSION_COLS} ${mine} ${from} ${COUNTS} ${w} ORDER BY ${order} ${limit}`, w.params);
  let total = rows.length;
  if (pg) {
    // The count query has no student sub-select, so drop that parameter.
    const cw = new Where();
    const cfn = `attendance.sessions_between(${cw.p(f.from)}::date, ${cw.p(f.to)}::date, ${cw.p(scope.collegeId || null)}::int)`;
    scopeSessions(cw, scope);
    sessionFilters(cw, f);
    total = (await db.one(`SELECT count(*)::int AS n FROM ${cfn} s ${cw}`, cw.params)).n;
  }
  return { rows, total };
}

/** Totals over a set of sessions (cards on the dashboards). */
async function totals(scope, f) {
  const w = new Where();
  const fn = `attendance.sessions_between(${w.p(f.from)}::date, ${w.p(f.to)}::date, ${w.p(scope.collegeId || null)}::int)`;
  scopeSessions(w, scope);
  sessionFilters(w, f);
  return db.one(
    `SELECT count(*)::int AS sessions,
            count(*) FILTER (WHERE s.status = 'needs_manual')::int AS needs_manual,
            count(*) FILTER (WHERE s.status = 'closed')::int AS closed,
            COALESCE(sum(a.present), 0)::int AS present, COALESCE(sum(a.late), 0)::int AS late,
            COALESCE(sum(a.absent), 0)::int AS absent, COALESCE(sum(a.excused), 0)::int AS excused,
            COALESCE(sum(a.marked), 0)::int AS marked
       FROM ${fn} s ${MARKS} ${w}`,
    w.params
  );
}

// Ways to group the same sessions: one row per department, class, subject, staff member, period or date.
const GROUPS = {
  department: { key: 'd.department_id', label: "d.department_code || ' ' || d.department_name", order: '2' },
  class: { key: 's.section_id', label: SECTION_LABEL, order: '2' },
  subject: { key: 's.subject_id', label: "sub.subject_code || ' ' || sub.subject_name", order: '2' },
  staff: { key: 's.staff_id', label: personName('su'), order: '2' },
  period: { key: 'p.period_no', label: "'Period ' || p.period_no || ' (' || to_char(p.start_time, 'HH24:MI') || ' to ' || to_char(p.end_time, 'HH24:MI') || ')'", order: '1' },
  date: { key: 's.session_date', label: "to_char(s.session_date, 'Dy, DD Mon YYYY')", order: '1 DESC' },
};

/** Attendance totals of a set of sessions, grouped by a category. */
function breakdown(scope, f, by) {
  const g = GROUPS[by] || GROUPS.class;
  const w = new Where();
  const fn = `attendance.sessions_between(${w.p(f.from)}::date, ${w.p(f.to)}::date, ${w.p(scope.collegeId || null)}::int)`;
  scopeSessions(w, scope);
  sessionFilters(w, f);
  return db.many(
    `SELECT ${g.key} AS key, ${g.label} AS label, count(*)::int AS sessions,
            count(*) FILTER (WHERE s.status = 'needs_manual')::int AS needs_manual,
            COALESCE(sum(a.present), 0)::int AS present, COALESCE(sum(a.late), 0)::int AS late,
            COALESCE(sum(a.absent), 0)::int AS absent, COALESCE(sum(a.excused), 0)::int AS excused,
            COALESCE(sum(a.marked), 0)::int AS marked
       FROM ${fn} s ${SESSION_JOINS} ${MARKS} ${w}
      GROUP BY 1, 2 ORDER BY ${g.order}`,
    w.params
  );
}

async function session(scope, timetableId, date) {
  const { rows } = await sessions(scope, { from: date, to: date, timetable_id: parseInt(timetableId, 10) || 0 });
  return rows[0] || null;
}

/** The roll of a class with each student's record, if any. `elsewhere` names a parallel class the student was marked in. */
function sessionStudents(s, onlyStudentId) {
  const params = [s.timetable_id, s.session_date, s.section_id, s.subject_id, s.semester_id, s.period_id];
  let extra = '';
  if (onlyStudentId) {
    params.push(onlyStudentId);
    extra = 'AND x.student_id = $7';
  }
  return db.many(
    `SELECT x.student_id, x.full_name, x.register_no, x.roll_no, x.enrollment_status, x.face_registered,
            r.attendance_id, r.status, r.entry_time, r.exit_time, r.duration_minutes, r.attendance_source, r.confidence,
            other.subject_code AS elsewhere
       FROM identity.students x
       LEFT JOIN attendance.records r ON r.student_id = x.student_id AND r.timetable_id = $1 AND r.attendance_date = $2
       LEFT JOIN LATERAL (
         SELECT COALESCE(sub2.short_name, sub2.subject_code) || ', ' || concat_ws(' ', c2.block_name, c2.room_number) AS subject_code
           FROM attendance.records r2
           JOIN attendance.timetable t2 ON t2.timetable_id = r2.timetable_id
           JOIN attendance.subjects sub2 ON sub2.subject_id = t2.subject_id
           JOIN attendance.classrooms c2 ON c2.classroom_id = t2.classroom_id
          WHERE r2.student_id = x.student_id AND r2.attendance_date = $2
            AND t2.section_id = $3 AND t2.period_id = $6 AND t2.timetable_id <> $1 LIMIT 1) other ON r.attendance_id IS NULL
      WHERE x.section_id = $3
        AND ((x.enrollment_status IN ('active', 'opted_out') AND attendance.takes_subject(x.student_id, $4, $5, $3))
             OR r.attendance_id IS NOT NULL) ${extra}
      ORDER BY x.roll_no NULLS LAST, x.register_no, x.full_name`,
    params
  );
}

async function record(scope, id) {
  const w = new Where().add('r.attendance_id = ?', parseInt(id, 10) || 0);
  if (scope.collegeId) w.add('d.college_id = ?', scope.collegeId);
  if (scope.role === 'hod') w.add('sec.department_id = ?', scope.departmentId || 0);
  if (scope.role === 'student') w.add('r.student_id = ?', scope.studentId || NIL_UUID);
  return db.one(
    `SELECT r.*, x.full_name, x.register_no, x.roll_no, t.section_id, t.semester_id, sec.department_id, d.college_id,
            ${personName('mu')} AS marked_by_name
       FROM attendance.records r
       JOIN identity.students x ON x.student_id = r.student_id
       JOIN attendance.timetable t ON t.timetable_id = r.timetable_id
       JOIN attendance.sections sec ON sec.section_id = t.section_id
       JOIN attendance.departments d ON d.department_id = sec.department_id
       LEFT JOIN attendance.users mu ON mu.user_id = r.marked_by
       ${w}`,
    w.params
  );
}

function recordHistory(rec) {
  return Promise.all([
    db.many(
      `SELECT c.old_status, c.new_status, c.reason, c.corrected_at, ${personName('u')} AS by_name
         FROM attendance.corrections c JOIN attendance.users u ON u.user_id = c.corrected_by
        WHERE c.attendance_id = $1 ORDER BY c.corrected_at DESC`,
      [rec.attendance_id]
    ),
    db.many(
      `SELECT h.previous_status, h.new_status, h.modified_at, ${personName('u')} AS by_name
         FROM attendance.status_history h LEFT JOIN attendance.users u ON u.user_id = h.modified_by
        WHERE h.student_id = $1 AND h.timetable_id = $2 AND h.attendance_date = $3 ORDER BY h.modified_at DESC`,
      [rec.student_id, rec.timetable_id, rec.attendance_date]
    ),
  ]);
}

async function student(scope, id) {
  const w = new Where().add('x.student_id = ?', id);
  if (scope.collegeId) w.add('x.college_id = ?', scope.collegeId);
  if (scope.role === 'hod') w.add('sec.department_id = ?', scope.departmentId || 0);
  if (scope.role === 'student') w.add('x.student_id = ?', scope.studentId || NIL_UUID);
  if (scope.role === 'staff') {
    const p = w.p(scope.staffId || 0);
    w.parts.push(`(EXISTS (SELECT 1 FROM attendance.timetable tt WHERE tt.section_id = x.section_id AND tt.staff_id = ${p})
                OR EXISTS (SELECT 1 FROM attendance.staff_sections ss WHERE ss.section_id = x.section_id AND ss.staff_id = ${p}))`);
  }
  return db.one(
    `SELECT x.student_id, x.full_name, x.register_no, x.roll_no, x.university_id, x.section_id, x.college_id,
            x.enrollment_status, x.face_registered, ${SECTION_LABEL} AS section_label
       FROM identity.students x
       LEFT JOIN attendance.sections sec ON sec.section_id = x.section_id
       LEFT JOIN attendance.departments d ON d.department_id = sec.department_id
       LEFT JOIN attendance.programs pr ON pr.program_id = sec.program_id
       LEFT JOIN attendance.semesters sem ON sem.semester_id = sec.semester_id
       ${w}`,
    w.params
  );
}

const studentSubjects = (studentId) =>
  db.many(
    `SELECT sub.subject_code, sub.subject_name, sem.semester_no, ss.subject_id, ss.semester_id,
            ss.total_classes, ss.attended_classes, ss.absent_classes, ss.late_classes, ss.excused_classes, ss.percentage
       FROM attendance.subject_summary ss
       JOIN attendance.subjects sub ON sub.subject_id = ss.subject_id
       JOIN attendance.semesters sem ON sem.semester_id = ss.semester_id
      WHERE ss.student_id = $1 ORDER BY sem.semester_no DESC, sub.subject_code`,
    [studentId]
  );

const studentRecords = (studentId, from, to) =>
  db.many(
    `SELECT r.attendance_id, r.attendance_date, r.status, r.attendance_source, r.entry_time, r.timetable_id,
            p.period_no, sub.subject_code, sub.subject_name
       FROM attendance.records r
       JOIN attendance.timetable t ON t.timetable_id = r.timetable_id
       JOIN attendance.periods p ON p.period_id = t.period_id
       JOIN attendance.subjects sub ON sub.subject_id = t.subject_id
      WHERE r.student_id = $1 AND r.attendance_date BETWEEN $2 AND $3
      ORDER BY r.attendance_date DESC, p.period_no`,
    [studentId, from, to]
  );

module.exports = { scopeSessions, sessions, totals, breakdown, GROUPS, session, sessionStudents, record, recordHistory, student, studentSubjects, studentRecords, NIL_UUID };
