'use strict';
const db = require('../config/db');
const entities = require('../config/entities');
const { Where } = require('../utils/sql');
const { notFound, forbidden, invalid } = require('../utils/errors');
const { isDate } = require('../utils/dates');

// College-scoped option lists for select fields. Every FK a form posts is checked against these.
const OPTION_SQL = {
  departments: (w, scope) => `SELECT department_id AS value, department_code || ' - ' || department_name AS label FROM attendance.departments WHERE college_id = ${w.p(scope.collegeId)}
                              ${scope.role === 'hod' ? `AND department_id = ${w.p(scope.departmentId || 0)}` : ''} ORDER BY department_code`,
  programs: (w, scope) => `SELECT program_id AS value, program_code || ' - ' || program_name AS label FROM attendance.programs WHERE college_id = ${w.p(scope.collegeId)} ORDER BY program_code`,
  academic_years: (w, scope) => `SELECT academic_year_id AS value, label || CASE WHEN is_active THEN ' (active)' ELSE '' END AS label FROM attendance.academic_years WHERE college_id = ${w.p(scope.collegeId)} ORDER BY start_date DESC`,
  semesters: (w, scope) => `SELECT s.semester_id AS value, ay.label || ' - Semester ' || s.semester_no AS label FROM attendance.semesters s
                            JOIN attendance.academic_years ay ON ay.academic_year_id = s.academic_year_id WHERE ay.college_id = ${w.p(scope.collegeId)} ORDER BY ay.start_date DESC, s.semester_no`,
  staff: (w, scope) => `SELECT st.staff_id AS value, st.staff_code || ' - ' || btrim(concat_ws(' ', u.first_name, u.last_name)) AS label FROM attendance.staff st
                        JOIN attendance.users u ON u.user_id = st.user_id WHERE st.college_id = ${w.p(scope.collegeId)} AND st.status = 'active' ORDER BY st.staff_code`,
  classrooms: (w, scope) => `SELECT classroom_id AS value, concat_ws(' ', block_name, room_number) AS label FROM attendance.classrooms WHERE college_id = ${w.p(scope.collegeId)} ORDER BY block_name NULLS FIRST, room_number`,
  categories: () => `SELECT category_id AS value, category_name AS label FROM attendance.subject_categories ORDER BY category_name`,
  periods: (w, scope) => `SELECT period_id AS value, 'Period ' || period_no || ' (' || to_char(start_time, 'HH24:MI') || '-' || to_char(end_time, 'HH24:MI') || ')' AS label FROM attendance.periods WHERE college_id = ${w.p(scope.collegeId)} ORDER BY period_no`,
  all_subjects: (w, scope) => `SELECT subject_id AS value, subject_code || COALESCE(' (' || short_name || ')', '') || ' - ' || subject_name AS label FROM attendance.subjects WHERE college_id = ${w.p(scope.collegeId)} ORDER BY subject_code`,
  sections: (w, scope) => `SELECT sec.section_id AS value, d.department_code || ' ' || pr.program_code || ' Sem ' || sem.semester_no || ' ' || sec.section_name || ' (' || ay.label || ')' AS label
                           FROM attendance.sections sec JOIN attendance.departments d ON d.department_id = sec.department_id JOIN attendance.programs pr ON pr.program_id = sec.program_id
                           JOIN attendance.semesters sem ON sem.semester_id = sec.semester_id JOIN attendance.academic_years ay ON ay.academic_year_id = sec.academic_year_id
                           WHERE d.college_id = ${w.p(scope.collegeId)} ${scope.role === 'hod' ? `AND sec.department_id = ${w.p(scope.departmentId || 0)}` : ''}
                           ORDER BY ay.start_date DESC, d.department_code, sem.semester_no, sec.section_name`,
  subjects: (w, scope) => `SELECT subject_id AS value, subject_code || ' - ' || subject_name AS label FROM attendance.subjects WHERE college_id = ${w.p(scope.collegeId)}
                           ${scope.role === 'hod' ? `AND department_id = ${w.p(scope.departmentId || 0)}` : ''} ORDER BY subject_code`,
};

async function options(scope, source) {
  const w = new Where();
  return db.many(OPTION_SQL[source](w, scope), w.params);
}

function entity(key) {
  const e = entities[key];
  if (!e) throw notFound('Unknown list.');
  return e;
}

function scopedWhere(e, scope) {
  const w = new Where();
  const col = e.college === 'direct' ? 'x.college_id' : e.college;
  if (scope.collegeId) w.add(`${col} = ?`, scope.collegeId);
  if (scope.role === 'hod') {
    if (e.departmentCol) w.add(`x.${e.departmentCol} = ?`, scope.departmentId || 0);
    else if (e.hodFilter) w.add(`${e.hodFilter} = ?`, scope.departmentId || 0);
  }
  return w;
}

/** The filter boxes of a list with their choices: fixed, from an option source, or the distinct values in scope. */
async function filterOptions(key, scope) {
  const e = entity(key);
  const out = [];
  for (const f of e.filters || []) {
    let options;
    if (f.choices) options = f.choices.map((c) => ({ value: c, label: c.replace(/_/g, ' ') }));
    else if (f.options) options = scope.collegeId ? await module.exports.options(scope, f.options) : [];
    else {
      const w = scopedWhere(e, scope);
      w.parts.push(`${f.column} IS NOT NULL`);
      options = (await db.many(`SELECT DISTINCT ${f.column} AS value FROM ${e.table} x ${e.joins || ''} ${w} ORDER BY 1`, w.params)).map((r) => ({ value: r.value, label: String(r.value) }));
    }
    out.push({ name: f.name, label: f.label, options });
  }
  return out;
}

async function list(key, scope, pg, q, filters = {}) {
  const e = entity(key);
  const w = scopedWhere(e, scope);
  for (const f of e.filters || []) {
    const v = filters[f.name];
    if (v === undefined || v === null || v === '') continue;
    if (f.int && !/^-?\d+$/.test(String(v))) continue;
    w.add(`${f.column} = ?`, f.int ? parseInt(v, 10) : String(v));
  }
  const cols = e.columns.map(([sql], i) => `${sql} AS c${i}`).join(', ');
  if (q) {
    const like = `%${q}%`;
    w.parts.push('(' + e.columns.map(([sql]) => `(${sql})::text ILIKE ${w.p(like)}`).join(' OR ') + ')');
  }
  const from = `FROM ${e.table} x ${e.joins || ''} ${w}`;
  const total = (await db.one(`SELECT count(*)::int AS n ${from}`, w.params)).n;
  const rows = await db.many(`SELECT x.${e.pk} AS id, ${cols} ${from} ORDER BY ${e.order} LIMIT ${pg.limit} OFFSET ${pg.offset}`, w.params);
  return { rows, total, headers: e.columns.map((c) => c[1]) };
}

async function get(key, scope, id) {
  const e = entity(key);
  if (e.table === 'identity.students' && !/^[0-9a-f-]{36}$/i.test(String(id))) throw notFound(`That ${e.one} does not exist.`);
  const w = scopedWhere(e, scope).add(`x.${e.pk} = ?`, e.pkText ? String(id) : parseInt(id, 10) || 0);
  // extraSelect: values the form shows that live in a joined table (a student's mobile is on the sign-in account).
  const row = await db.one(`SELECT x.*${e.extraSelect ? ', ' + e.extraSelect : ''} FROM ${e.table} x ${e.joins || ''} ${w}`, w.params);
  if (!row) throw notFound(`That ${e.one} does not exist.`);
  return row;
}

/** HODs can write only the entities that belong to a department, and only their own. */
function assertWritable(e, scope) {
  if (scope.role === 'hod' && !e.departmentCol && !e.hodWritable) throw forbidden(`Only the college admin can change ${e.title.toLowerCase()}.`);
}

/** Coerce and validate posted values against the entity's field list. */
async function clean(key, scope, body, isCreate) {
  const e = entity(key);
  const values = {};
  const errors = [];
  for (const f of e.fields) {
    if (f.onCreateOnly && !isCreate) continue;
    let v = body[f.name];
    if (typeof v === 'string') v = v.trim();
    if (f.type === 'bool') {
      values[f.name] = v === true || v === 'true' || v === 'on' || v === '1';
      continue;
    }
    if (v === undefined || v === null || v === '') {
      if (f.required) errors.push({ field: f.name, message: `${f.label} is required` });
      values[f.name] = f.default !== undefined && isCreate ? f.default : null;
      continue;
    }
    if (f.type === 'int' || f.type === 'number') {
      const n = f.type === 'int' ? parseInt(v, 10) : parseFloat(v);
      if (Number.isNaN(n) || (f.type === 'int' && !/^-?\d+$/.test(String(v)))) errors.push({ field: f.name, message: `${f.label} must be a number` });
      else if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) errors.push({ field: f.name, message: `${f.label} must be from ${f.min} to ${f.max}` });
      values[f.name] = n;
    } else if (f.type === 'date') {
      if (!isDate(v)) errors.push({ field: f.name, message: `${f.label} must be a date` });
      values[f.name] = v;
    } else if (f.type === 'time') {
      if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v)) errors.push({ field: f.name, message: `${f.label} must be a time like 09:00` });
      values[f.name] = v;
    } else if (f.type === 'select') {
      if (f.choices) {
        if (!f.choices.includes(v)) errors.push({ field: f.name, message: `${f.label}: choose one of the listed values` });
        values[f.name] = v;
      } else {
        const allowed = await options(scope, f.options);
        const hit = allowed.find((o) => String(o.value) === String(v));
        if (!hit) errors.push({ field: f.name, message: `${f.label}: choose one of the listed values` });
        values[f.name] = hit ? hit.value : null;
      }
    } else {
      if (f.max && v.length > f.max) errors.push({ field: f.name, message: `${f.label} is longer than ${f.max} characters` });
      if (f.pattern && !new RegExp(f.pattern).test(v)) errors.push({ field: f.name, message: `${f.label} is not in the expected form` });
      values[f.name] = f.upper ? v.toUpperCase() : v;
    }
  }
  if (values.start_date && values.end_date && values.end_date <= values.start_date) errors.push({ field: 'end_date', message: 'End date must be after start date' });
  if (errors.length) throw invalid(errors.map((x) => x.message).join('. '), errors);
  if (e.beforeSave) e.beforeSave(values, scope);
  return values;
}

async function save(key, scope, id, body) {
  const e = entity(key);
  assertWritable(e, scope);
  const isCreate = id === null;
  if (isCreate && e.noCreate) throw forbidden(`Add ${e.title.toLowerCase()} through Uploads or Users.`);
  if (!isCreate) await get(key, scope, id); // 404 outside scope
  const values = await clean(key, scope, body, isCreate);
  // Virtual fields are checked like the others but are not columns of this table:
  // the entity's afterSave stores them. Only the ones actually sent are passed on.
  const extra = {};
  for (const f of e.fields.filter((x) => x.virtual)) {
    if (body[f.name] !== undefined) extra[f.name] = values[f.name];
    delete values[f.name];
  }
  if (e.college === 'direct') values.college_id = scope.collegeId;
  const names = Object.keys(values);
  return db.tx(async (c) => {
    let row;
    if (isCreate) {
      const r = await c.query(
        `INSERT INTO ${e.table} (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        names.map((n) => values[n])
      );
      row = r.rows[0];
    } else {
      const r = await c.query(
        `UPDATE ${e.table} SET ${names.map((n, i) => `${n} = $${i + 2}`).join(', ')} WHERE ${e.pk} = $1 RETURNING *`,
        [e.pkText ? String(id) : parseInt(id, 10), ...names.map((n) => values[n])]
      );
      row = r.rows[0];
    }
    if (e.afterSave) {
      await e.afterSave(c, row, scope, extra);
      row = (await c.query(`SELECT * FROM ${e.table} WHERE ${e.pk} = $1`, [row[e.pk]])).rows[0]; // the hook may have changed it
    }
    return row;
  });
}

async function remove(key, scope, id) {
  const e = entity(key);
  assertWritable(e, scope);
  if (e.noDelete) throw forbidden(`${e.title} are not deleted. Change the status instead.`);
  const row = await get(key, scope, id);
  await db.query(`DELETE FROM ${e.table} WHERE ${e.pk} = $1`, [row[e.pk]]);
  return row;
}

module.exports = { entity, options, list, get, save, remove, filterOptions };
