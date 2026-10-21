'use strict';
/**
 * Small WHERE builder that keeps $n placeholders in step with a params array.
 *   const w = new Where();
 *   w.add('d.college_id = ?', 3).add('s.name ILIKE ?', '%a%');
 *   db.many(`SELECT ... ${w}`, w.params)
 */
class Where {
  constructor(params = []) {
    this.params = params;
    this.parts = [];
  }
  /** Register a value and get its placeholder. */
  p(value) {
    this.params.push(value);
    return `$${this.params.length}`;
  }
  add(sql, ...values) {
    let i = 0;
    this.parts.push(sql.replace(/\?/g, () => this.p(values[i++])));
    return this;
  }
  /** Add only when the value is present. */
  opt(sql, value) {
    if (value !== undefined && value !== null && value !== '') this.add(sql, value);
    return this;
  }
  toString() {
    return this.parts.length ? `WHERE ${this.parts.join(' AND ')}` : '';
  }
  and() {
    return this.parts.length ? ` AND ${this.parts.join(' AND ')}` : '';
  }
}

/**
 * Apply the caller's data scope. cols names the SQL column for each scope level;
 * levels that are not named are not filtered (use them only where the table has
 * no such column and a parent filter already covers it).
 *   college:    always applied when the scope has a college
 *   department: applied for HOD
 *   staff:      applied for staff; a column name, or fn(placeholder) => sql
 *   student:    applied for student
 */
function applyScope(w, scope, cols) {
  if (scope.collegeId != null && cols.college) w.add(`${cols.college} = ?`, scope.collegeId);
  if (scope.role === 'hod' && cols.department) w.add(`${cols.department} = ?`, scope.departmentId || 0);
  if (scope.role === 'staff' && cols.staff) {
    const ph = w.p(scope.staffId || 0);
    w.parts.push(typeof cols.staff === 'function' ? cols.staff(ph) : `${cols.staff} = ${ph}`);
  }
  if (scope.role === 'student' && cols.student) w.add(`${cols.student} = ?`, scope.studentId || '00000000-0000-0000-0000-000000000000');
  return w;
}

function paging(query, defaultSize = 50) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const size = Math.min(Math.max(parseInt(query.page_size, 10) || defaultSize, 1), 200);
  return { page, size, limit: size, offset: (page - 1) * size };
}

module.exports = { Where, applyScope, paging };
