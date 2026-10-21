'use strict';
const db = require('../config/db');
const model = require('../models/users');
const master = require('../models/master');
const timetable = require('../models/timetable');
const { hashPassword, randomPassword } = require('../utils/crypto');
const { invalid, forbidden, notFound } = require('../utils/errors');

// Which roles each role may create.
const CAN_CREATE = {
  superadmin: ['superadmin', 'admin', 'hod', 'staff', 'student'],
  admin: ['hod', 'staff', 'student'],
  hod: ['staff', 'student'],
};
const creatable = (scope) => (CAN_CREATE[scope.role] || []).filter((r) => scope.collegeId || r === 'superadmin');

const USERNAME = /^[a-z0-9._@-]{3,60}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const t = (v) => String(v === null || v === undefined ? '' : v).trim();

function common(body) {
  const v = { first_name: t(body.first_name), last_name: t(body.last_name) || null, email: t(body.email).toLowerCase() || null, mobile: t(body.mobile) || null };
  if (!v.first_name) throw invalid('First name is required.');
  if (v.email && !EMAIL.test(v.email)) throw invalid('Email is not valid.');
  return v;
}

/** Create a user and, for staff / HOD / student, the matching staff or student row. Returns the one-time password. */
async function create(scope, body) {
  const role = t(body.role);
  if (!creatable(scope).includes(role)) throw forbidden('You cannot create a user with that role.');
  const v = common(body);
  v.username = t(body.username).toLowerCase();
  if (!USERNAME.test(v.username)) throw invalid('Username must be 3 to 60 letters, digits, dot, dash, underscore or @.');
  v.college_id = role === 'superadmin' ? null : scope.collegeId;

  let departmentId = null, sectionId = null;
  if (['hod', 'staff'].includes(role)) {
    const d = (await master.options(scope, 'departments')).find((o) => String(o.value) === t(body.department_id));
    if (!d) throw invalid('Choose a department.');
    departmentId = d.value;
    if (!t(body.staff_code)) throw invalid('Staff code is required.');
  }
  if (role === 'student') {
    const s = (await timetable.sections(scope, { all: true })).find((o) => String(o.value) === t(body.section_id));
    if (!s) throw invalid('Choose a section.');
    sectionId = s.value;
    departmentId = s.department_id;
    if (!t(body.university_id) || !t(body.register_no)) throw invalid('University id and register number are required.');
  }
  const password = t(body.password) || randomPassword();
  if (password.length < 8) throw invalid('Password must be at least 8 characters.');

  const userId = await db.tx(async (c) => {
    const id = await model.insertUser(c, {
      ...v, department_id: departmentId, role_id: await model.roleId(role, c),
      password_hash: await hashPassword(password, { temporary: true }), must_change_password: true,
    });
    if (['hod', 'staff'].includes(role)) {
      const st = await c.one(
        `INSERT INTO attendance.staff (user_id, staff_code, designation, department_id, employee_type, college_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING staff_id`,
        [id, t(body.staff_code).toUpperCase(), t(body.designation) || null, departmentId, t(body.employee_type) || 'regular', scope.collegeId]
      );
      if (role === 'hod') await c.query('UPDATE attendance.departments SET hod_staff_id = $2 WHERE department_id = $1', [departmentId, st.staff_id]);
    }
    if (role === 'student') {
      await c.query(
        `INSERT INTO identity.students (university_id, full_name, user_id, section_id, register_no, roll_no, batch_year, college_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [t(body.university_id).toUpperCase(), [v.first_name, v.last_name].filter(Boolean).join(' '), id, sectionId,
          t(body.register_no).toUpperCase(), t(body.roll_no) || null, parseInt(body.batch_year, 10) || null, scope.collegeId]
      );
    }
    return id;
  });
  return { userId, password, role };
}

async function update(scope, id, body) {
  const user = await model.get(scope, id);
  if (!user) throw notFound('That user does not exist.');
  const v = common(body);
  await db.tx(async (c) => {
    await model.updateUser(c, user.user_id, { ...v, department_id: user.department_id });
    if (user.staff_id) {
      await c.query('UPDATE attendance.staff SET designation = $2 WHERE staff_id = $1', [user.staff_id, t(body.designation) || user.designation]);
    }
    if (user.student_id) {
      await c.query('UPDATE identity.students SET full_name = $2, roll_no = $3 WHERE student_id = $1',
        [user.student_id, [v.first_name, v.last_name].filter(Boolean).join(' '), t(body.roll_no) || user.roll_no]);
    }
  });
  return user;
}

/** Deactivate or reactivate. Users are never deleted. */
async function setStatus(scope, actorId, id, status) {
  const user = await model.get(scope, id);
  if (!user) throw notFound('That user does not exist.');
  if (user.user_id === actorId) throw invalid('You cannot deactivate your own account.');
  if (!['active', 'inactive'].includes(status)) throw invalid('Unknown status.');
  await model.setStatus(user.user_id, status);
  if (status === 'inactive') await model.endSessions(user.user_id);
  return user;
}

async function resetPassword(scope, id) {
  const user = await model.get(scope, id);
  if (!user) throw notFound('That user does not exist.');
  const password = randomPassword();
  await model.setPassword(user.user_id, await hashPassword(password, { temporary: true }), true);
  await model.endSessions(user.user_id);
  return { user, password };
}

module.exports = { creatable, create, update, setStatus, resetPassword };
