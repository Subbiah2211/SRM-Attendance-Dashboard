'use strict';
const db = require('../config/db');
const { Where } = require('../utils/sql');

async function list(scope, f, pg) {
  const w = new Where();
  if (scope.collegeId) w.add('a.college_id = ?', scope.collegeId);
  w.opt('a.action = ?', f.action);
  w.opt('a.table_name = ?', f.table_name);
  w.opt('a.action_time >= ?::date', f.from);
  w.opt("a.action_time < (?::date + 1)", f.to);
  if (f.q) w.add("(u.username ILIKE ? OR a.record_id ILIKE ?)", `%${f.q}%`, `%${f.q}%`);
  const from = `FROM attendance.audit_logs a LEFT JOIN attendance.users u ON u.user_id = a.user_id ${w}`;
  const total = (await db.one(`SELECT count(*)::int AS n ${from}`, w.params)).n;
  const rows = await db.many(
    `SELECT a.audit_id, a.action, a.table_name, a.record_id, a.action_time, host(a.ip_address) AS ip, a.old_values, a.new_values, u.username
       ${from} ORDER BY a.action_time DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`,
    w.params
  );
  return { rows, total };
}

const actions = (scope) =>
  db.many(
    `SELECT DISTINCT action FROM attendance.audit_logs WHERE ($1::int IS NULL OR college_id = $1) ORDER BY action`,
    [scope.collegeId || null]
  );

module.exports = { list, actions };
