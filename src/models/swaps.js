'use strict';
const db = require('../config/db');
const { Where } = require('../utils/sql');
const { SECTION_LABEL, SECTION_JOINS, personName } = require('./common');

const FROM = `
  FROM attendance.class_swaps sw
  JOIN attendance.timetable t ON t.timetable_id = sw.timetable_id
  JOIN attendance.sections sec ON sec.section_id = t.section_id
  ${SECTION_JOINS}
  JOIN attendance.periods p ON p.period_id = t.period_id
  JOIN attendance.subjects sub ON sub.subject_id = t.subject_id
  JOIN attendance.staff os ON os.staff_id = sw.original_staff_id JOIN attendance.users ou ON ou.user_id = os.user_id
  JOIN attendance.staff rs ON rs.staff_id = sw.replacement_staff_id JOIN attendance.users ru ON ru.user_id = rs.user_id`;

function where(scope) {
  const w = new Where();
  if (scope.collegeId) w.add('d.college_id = ?', scope.collegeId);
  if (scope.role === 'hod') w.add('sec.department_id = ?', scope.departmentId || 0);
  if (scope.role === 'staff') {
    const p = w.p(scope.staffId || 0);
    w.parts.push(`(sw.original_staff_id = ${p} OR sw.replacement_staff_id = ${p})`);
  }
  return w;
}

async function list(scope, pg) {
  const w = where(scope);
  const total = (await db.one(`SELECT count(*)::int AS n ${FROM} ${w}`, w.params)).n;
  const rows = await db.many(
    `SELECT sw.swap_id, sw.swap_date, sw.status, sw.reason, sw.requested_at, sw.timetable_id, p.period_no,
            sub.subject_code, sub.subject_name, ${SECTION_LABEL} AS section_label, sec.department_id,
            ${personName('ou')} AS original_name, ${personName('ru')} AS replacement_name, ou.user_id AS original_user_id, ru.user_id AS replacement_user_id
       ${FROM} ${w} ORDER BY (sw.status = 'pending') DESC, sw.swap_date DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`,
    w.params
  );
  return { rows, total };
}

async function get(scope, id) {
  const w = where(scope).add('sw.swap_id = ?', parseInt(id, 10) || 0);
  return db.one(
    `SELECT sw.*, sec.department_id, ou.user_id AS original_user_id, ru.user_id AS replacement_user_id,
            sub.subject_code, p.period_no, ${SECTION_LABEL} AS section_label ${FROM} ${w}`,
    w.params
  );
}

module.exports = { list, get };
