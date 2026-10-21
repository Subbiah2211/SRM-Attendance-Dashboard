'use strict';
const db = require('../config/db');

const list = () =>
  db.many(`
    SELECT c.*,
           (SELECT count(*)::int FROM attendance.users u WHERE u.college_id = c.college_id AND u.status = 'active') AS users,
           (SELECT count(*)::int FROM attendance.departments x WHERE x.college_id = c.college_id) AS departments,
           (SELECT count(*)::int FROM identity.students s WHERE s.college_id = c.college_id AND s.enrollment_status = 'active') AS students
      FROM attendance.colleges c ORDER BY c.college_name`);

const get = (id) => db.one('SELECT * FROM attendance.colleges WHERE college_id = $1', [id]);

const create = (v, client = db) =>
  client.query(
    `INSERT INTO attendance.colleges (college_code, college_name, campus, timezone, is_active)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [v.college_code, v.college_name, v.campus || null, v.timezone || 'Asia/Kolkata', v.is_active !== false]
  ).then((r) => r.rows[0]);

const update = (id, v) =>
  db.one(
    `UPDATE attendance.colleges SET college_code = $2, college_name = $3, campus = $4, timezone = $5, is_active = $6
      WHERE college_id = $1 RETURNING *`,
    [id, v.college_code, v.college_name, v.campus || null, v.timezone || 'Asia/Kolkata', v.is_active !== false]
  );

const setContext = (sessionId, collegeId) =>
  db.query('UPDATE attendance.user_sessions SET context_college_id = $2 WHERE session_id = $1', [sessionId, collegeId]);

module.exports = { list, get, create, update, setContext };
