'use strict';
const db = require('../config/db');
const { Where } = require('../utils/sql');
const { personName } = require('./common');

// A user's department: set on the user (HOD), or through the staff row, or the student's section.
const USER_FROM = `
  FROM attendance.users u
  JOIN attendance.roles r ON r.role_id = u.role_id
  LEFT JOIN attendance.staff st ON st.user_id = u.user_id
  LEFT JOIN identity.students stu ON stu.user_id = u.user_id
  LEFT JOIN attendance.sections sec ON sec.section_id = stu.section_id
  LEFT JOIN attendance.departments d ON d.department_id = COALESCE(u.department_id, st.department_id, sec.department_id)`;

function scoped(scope) {
  const w = new Where();
  if (scope.isSuper && !scope.collegeId) w.parts.push("r.role_name IN ('superadmin', 'admin')");
  else if (scope.isSuper) w.add('(u.college_id = ? OR u.college_id IS NULL)', scope.collegeId);
  else w.add('u.college_id = ?', scope.collegeId);
  if (scope.role === 'hod') {
    w.add('d.department_id = ?', scope.departmentId || 0);
    w.parts.push("r.role_name IN ('staff', 'student')");
  }
  return w;
}

async function list(scope, f, pg) {
  const w = scoped(scope);
  w.opt('r.role_name = ?', f.role);
  w.opt('d.department_id = ?', f.department_id);
  w.opt('u.status = ?', f.status);
  if (f.q) w.add(`(u.username ILIKE ? OR ${personName('u')} ILIKE ? OR st.staff_code ILIKE ? OR stu.register_no ILIKE ?)`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
  const total = (await db.one(`SELECT count(*)::int AS n ${USER_FROM} ${w}`, w.params)).n;
  const rows = await db.many(
    `SELECT u.user_id, u.username, ${personName('u')} AS name, u.email, u.mobile, u.status, u.last_login_at,
            u.locked_until, r.role_name, d.department_code, st.staff_code, stu.register_no
       ${USER_FROM} ${w}
      ORDER BY r.role_id, u.username LIMIT ${pg.limit} OFFSET ${pg.offset}`,
    w.params
  );
  return { rows, total };
}

async function get(scope, id) {
  const w = scoped(scope).add('u.user_id = ?', id);
  return db.one(
    `SELECT u.user_id, u.username, u.first_name, u.last_name, u.email, u.mobile, u.status, u.college_id, u.role_id,
            r.role_name, d.department_id, st.staff_id, st.staff_code, st.designation, st.employee_type,
            stu.student_id, stu.university_id, stu.register_no, stu.roll_no, stu.section_id, stu.batch_year
       ${USER_FROM} ${w}`,
    w.params
  );
}

const roleId = async (name, client = db) =>
  (await client.query('SELECT role_id FROM attendance.roles WHERE role_name = $1', [name])).rows[0].role_id;

async function insertUser(client, v) {
  const r = await client.query(
    `INSERT INTO attendance.users (username, password_hash, role_id, department_id, first_name, last_name, email, mobile, college_id, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING user_id`,
    [v.username, v.password_hash, v.role_id, v.department_id || null, v.first_name, v.last_name || null, v.email || null, v.mobile || null, v.college_id || null, v.must_change_password !== false]
  );
  return r.rows[0].user_id;
}

const updateUser = (client, id, v) =>
  client.query(
    `UPDATE attendance.users SET first_name = $2, last_name = $3, email = $4, mobile = $5, department_id = $6 WHERE user_id = $1`,
    [id, v.first_name, v.last_name || null, v.email || null, v.mobile || null, v.department_id || null]
  );

const setStatus = (id, status) => db.query('UPDATE attendance.users SET status = $2 WHERE user_id = $1', [id, status]);

const setPassword = (id, hash, mustChange) =>
  db.query(
    `UPDATE attendance.users SET password_hash = $2, must_change_password = $3, failed_attempts = 0, locked_until = NULL WHERE user_id = $1`,
    [id, hash, mustChange]
  );

const endSessions = (id) => db.query('UPDATE attendance.user_sessions SET logout_at = now() WHERE user_id = $1 AND logout_at IS NULL', [id]);

module.exports = { list, get, roleId, insertUser, updateUser, setStatus, setPassword, endSessions };
