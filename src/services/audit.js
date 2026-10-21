'use strict';
const db = require('../config/db');

/** Write one audit row. Never throws: an audit failure must not break the request. */
async function log(req, action, { table = null, recordId = null, oldValues = null, newValues = null, collegeId, userId } = {}) {
  try {
    const scope = (req && req.scope) || {};
    await db.query(
      `INSERT INTO attendance.audit_logs (user_id, action, table_name, record_id, ip_address, college_id, old_values, new_values)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId !== undefined ? userId : (req && req.user ? req.user.userId : null),
        action,
        table,
        recordId === null || recordId === undefined ? null : String(recordId),
        req && req.ip ? req.ip.replace(/^::ffff:/, '') : null,
        collegeId !== undefined ? collegeId : scope.collegeId || null,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
      ]
    );
  } catch (err) {
    console.error('[audit] failed to write', action, err.message);
  }
}

module.exports = { log };
