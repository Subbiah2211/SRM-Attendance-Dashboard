'use strict';
const db = require('../config/db');
const { Where } = require('../utils/sql');
const { SECTION_LABEL, SECTION_JOINS, personName } = require('./common');

const SLOT_SELECT = `
  SELECT t.timetable_id, t.section_id, t.day_of_week, t.period_id, t.subject_id, t.staff_id, t.classroom_id,
         t.effective_from, t.effective_to, t.is_active, t.semester_id, t.academic_year_id,
         p.period_no, p.start_time, p.end_time,
         sub.subject_code, sub.subject_name, sub.short_name, sub.is_lab,
         st.staff_code, ${personName('su')} AS staff_name,
         concat_ws(' ', c.block_name, c.room_number) AS room,
         ${SECTION_LABEL} AS section_label, d.college_id, sec.department_id
    FROM attendance.timetable t
    JOIN attendance.sections sec ON sec.section_id = t.section_id
    ${SECTION_JOINS}
    JOIN attendance.periods p ON p.period_id = t.period_id
    JOIN attendance.subjects sub ON sub.subject_id = t.subject_id
    JOIN attendance.staff st ON st.staff_id = t.staff_id
    JOIN attendance.users su ON su.user_id = st.user_id
    JOIN attendance.classrooms c ON c.classroom_id = t.classroom_id`;

/** Limit a query on sections (alias sec, with d joined) to what the caller may see. */
function scopeSections(w, scope) {
  if (scope.collegeId) w.add('d.college_id = ?', scope.collegeId);
  if (scope.role === 'hod') w.add('sec.department_id = ?', scope.departmentId || 0);
  if (scope.role === 'staff') {
    const s = w.p(scope.staffId || 0);
    w.parts.push(`(EXISTS (SELECT 1 FROM attendance.timetable tt WHERE tt.section_id = sec.section_id AND tt.staff_id = ${s})
                OR EXISTS (SELECT 1 FROM attendance.staff_sections ss WHERE ss.section_id = sec.section_id AND ss.staff_id = ${s})
                OR EXISTS (SELECT 1 FROM attendance.class_swaps sw JOIN attendance.timetable tt ON tt.timetable_id = sw.timetable_id
                            WHERE tt.section_id = sec.section_id AND sw.replacement_staff_id = ${s} AND sw.status = 'approved'))`);
  }
  if (scope.role === 'student') w.add('sec.section_id = ?', scope.studentSectionId || 0);
  return w;
}

/** Sections for select boxes; current academic year only unless all = true. */
function sections(scope, { all = false } = {}) {
  const w = scopeSections(new Where(), scope);
  if (!all) w.parts.push('ay.is_active');
  return db.many(
    `SELECT sec.section_id AS value, ${SECTION_LABEL} AS label, sec.department_id, sec.semester_id, sec.academic_year_id
       FROM attendance.sections sec ${SECTION_JOINS}
       JOIN attendance.academic_years ay ON ay.academic_year_id = sec.academic_year_id
       ${w} ORDER BY label`,
    w.params
  );
}

async function getSection(scope, id) {
  const w = scopeSections(new Where(), scope).add('sec.section_id = ?', parseInt(id, 10) || 0);
  return db.one(
    `SELECT sec.*, ${SECTION_LABEL} AS label, d.college_id FROM attendance.sections sec ${SECTION_JOINS} ${w}`,
    w.params
  );
}

/** Slots in effect on a date, for one section or one staff member. */
function slotsOn(scope, { sectionId, staffId, date }) {
  const w = scopeSections(new Where(), scope);
  w.add('t.effective_from <= ?', date).add('(t.effective_to IS NULL OR t.effective_to >= ?)', date);
  w.opt('t.section_id = ?', sectionId);
  w.opt('t.staff_id = ?', staffId);
  return db.many(`${SLOT_SELECT} ${w} ORDER BY t.day_of_week, p.period_no`, w.params);
}

async function getSlot(scope, id) {
  const w = scopeSections(new Where(), scope).add('t.timetable_id = ?', parseInt(id, 10) || 0);
  return db.one(`${SLOT_SELECT} ${w}`, w.params);
}

const periods = (collegeId) =>
  db.many('SELECT period_id, period_no, start_time, end_time FROM attendance.periods WHERE college_id = $1 ORDER BY period_no', [collegeId]);

const history = (timetableIds) =>
  db.many(
    `SELECT h.*, ${personName('u')} AS modified_by_name FROM attendance.timetable_history h
       LEFT JOIN attendance.users u ON u.user_id = h.modified_by
      WHERE h.timetable_id = ANY($1) ORDER BY h.modified_at DESC LIMIT 50`,
    [timetableIds]
  );

module.exports = { SLOT_SELECT, scopeSections, sections, getSection, slotsOn, getSlot, periods, history };

/** Staff for filter boxes: the college's staff; for an HOD, own department plus anyone teaching its sections. */
function staffOptions(scope) {
  const w = new Where();
  if (scope.collegeId) w.add('st.college_id = ?', scope.collegeId);
  if (scope.role === 'hod') {
    const p = w.p(scope.departmentId || 0);
    w.parts.push(`(st.department_id = ${p} OR EXISTS (
        SELECT 1 FROM attendance.timetable t JOIN attendance.sections s2 ON s2.section_id = t.section_id
         WHERE t.staff_id = st.staff_id AND s2.department_id = ${p}))`);
  }
  return db.many(
    `SELECT st.staff_id AS value, st.staff_code || ' - ' || ${personName('u')} AS label
       FROM attendance.staff st JOIN attendance.users u ON u.user_id = st.user_id ${w} ORDER BY label`,
    w.params
  );
}
module.exports.staffOptions = staffOptions;
