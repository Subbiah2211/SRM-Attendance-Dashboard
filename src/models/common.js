'use strict';
// SQL fragments shared by models. Aliases: sec sections, d departments, pr programs, sem semesters.
const SECTION_LABEL = `(d.department_code || ' ' || pr.program_code || ' Year ' || ceil(sem.semester_no / 2.0)::int || ' Sem ' || sem.semester_no || ' ' || sec.section_name)`;
const SECTION_JOINS = `
  JOIN attendance.departments d ON d.department_id = sec.department_id
  JOIN attendance.programs pr ON pr.program_id = sec.program_id
  JOIN attendance.semesters sem ON sem.semester_id = sec.semester_id`;
const personName = (alias) => `btrim(concat_ws(' ', ${alias}.first_name, ${alias}.last_name))`;

/** Percentage under the college's rule for excused records (mirrors attendance.pct in SQL). */
function pct(attended, excused, total, excusedCounts = true) {
  const a = Number(attended) || 0, e = Number(excused) || 0, t = Number(total) || 0;
  const den = excusedCounts ? t : t - e;
  if (den <= 0) return null;
  return Math.round(((excusedCounts ? a + e : a) / den) * 1000) / 10;
}

module.exports = { SECTION_LABEL, SECTION_JOINS, personName, pct };
