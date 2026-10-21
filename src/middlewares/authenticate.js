'use strict';
const db = require('../config/db');
const config = require('../config/env');
const settings = require('../services/settings');
const permissions = require('../services/permissions');
const { sha256 } = require('../utils/crypto');
const { HttpError } = require('../utils/errors');

const SESSION_SQL = `
  SELECT s.session_id, s.last_seen_at, s.context_college_id,
         u.user_id, u.username, u.first_name, u.last_name, u.email, u.status,
         u.college_id, u.department_id, u.must_change_password,
         r.role_name,
         c.college_id AS active_college_id, c.college_code, c.college_name, c.timezone, c.is_active AS college_active,
         st.staff_id, st.department_id AS staff_department_id,
         stu.student_id, stu.section_id AS student_section_id, stu.face_registered, stu.enrollment_status AS student_status
    FROM attendance.user_sessions s
    JOIN attendance.users u ON u.user_id = s.user_id
    JOIN attendance.roles r ON r.role_id = u.role_id
    LEFT JOIN attendance.colleges c ON c.college_id = COALESCE(u.college_id, s.context_college_id)
    LEFT JOIN attendance.staff st ON st.user_id = u.user_id
    LEFT JOIN identity.students stu ON stu.user_id = u.user_id
   WHERE s.session_token = $1 AND s.logout_at IS NULL`;

const COOKIE = 'sid';
const cookieOptions = () => ({ httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });

/** Load the session, the user and the data scope. Never rejects a request by itself. */
async function loadSession(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return next();
  const row = await db.one(SESSION_SQL, [sha256(token)]);
  const drop = () => {
    res.clearCookie(COOKIE, cookieOptions());
    return next();
  };
  if (!row || row.status !== 'active') return drop();
  if (row.college_id && !row.college_active) return drop();

  const idleMin = await settings.get(row.college_id, 'session_idle_minutes', 30);
  const idleMs = Date.now() - new Date(row.last_seen_at).getTime();
  if (idleMs > idleMin * 60000) {
    await db.query('UPDATE attendance.user_sessions SET logout_at = now() WHERE session_id = $1', [row.session_id]);
    return drop();
  }
  if (idleMs > 60000) {
    db.query('UPDATE attendance.user_sessions SET last_seen_at = now() WHERE session_id = $1', [row.session_id]).catch(() => {});
  }

  req.sessionToken = token;
  req.sessionId = row.session_id;
  req.user = {
    userId: row.user_id,
    username: row.username,
    name: [row.first_name, row.last_name].filter(Boolean).join(' '),
    email: row.email,
    role: row.role_name,
    collegeId: row.college_id,
    mustChangePassword: row.must_change_password,
    // An active student with no enrolled face goes to the enrolment page first (a college can switch this off).
    mustEnrolFace: row.role_name === 'student' && !!row.student_id && row.student_status === 'active' && !row.face_registered
      && !!(await settings.get(row.college_id, 'require_face_enrolment', true)),
  };
  // Scope is the only source of "whose data" for models. It is never read from the request.
  req.scope = {
    userId: row.user_id,
    role: row.role_name,
    isSuper: row.role_name === 'superadmin',
    collegeId: row.active_college_id || null,
    collegeCode: row.college_code || null,
    collegeName: row.college_name || null,
    timezone: row.timezone || 'Asia/Kolkata',
    departmentId: row.department_id || row.staff_department_id || null,
    staffId: row.staff_id || null,
    studentId: row.student_id || null,
    studentSectionId: row.student_section_id || null,
  };
  req.permissions = await permissions.forUser(req.user, req.scope);
  req.can = (moduleKey, action = 'view') => !!(req.permissions[moduleKey] && req.permissions[moduleKey][action]);
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) {
    if (req.isApi) throw new HttpError(401, 'not_signed_in', 'Sign in first.');
    return res.redirect('/login');
  }
  // With a one-time password the only things allowed are changing it and signing out.
  const open = ['/password', '/auth/password', '/logout', '/auth/logout', '/auth/me'];
  if (req.user.mustChangePassword && !open.includes(req.path)) {
    if (req.isApi) throw new HttpError(403, 'password_change_required', 'Change your password first.');
    return res.redirect('/password');
  }
  if (req.user.mustEnrolFace && !['/enroll', ...open].includes(req.path)) {
    if (req.isApi) throw new HttpError(403, 'face_enrolment_required', 'Enrol your face first (POST /enroll with at least three JPEG photos).');
    return res.redirect('/enroll');
  }
  next();
}

/** Most write screens need one college. A superadmin picks it from the Colleges page. */
function requireCollege(req, res, next) {
  if (req.scope && req.scope.collegeId) return next();
  if (req.isApi) throw new HttpError(400, 'college_required', 'Choose a college first (POST /colleges/:id/enter).');
  res.flash('error', 'Choose a college to work in first.');
  res.redirect('/colleges');
}

function requireSuperadmin(req, res, next) {
  if (req.user && req.user.role === 'superadmin') return next();
  throw new HttpError(403, 'forbidden', 'Only the superadmin can do this.');
}

module.exports = { loadSession, requireLogin, requireCollege, requireSuperadmin, COOKIE, cookieOptions };
