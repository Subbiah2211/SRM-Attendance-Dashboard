'use strict';
const db = require('../config/db');
const notifications = require('../services/notifications');

/**
 * Hourly: recompute defaulter alerts from the subject summaries, tell students whose
 * alert is new or has moved to another level, and tidy old sessions.
 */
module.exports = async function refreshSummaries() {
  // Remember the alerts that exist, so only new or worsened ones produce a notification.
  const key = (a) => `${a.student_id}|${a.subject_id}|${a.semester_id}`;
  const before = new Map((await db.many('SELECT student_id, subject_id, semester_id, alert_type FROM attendance.alerts')).map((a) => [key(a), a.alert_type]));
  await db.query('SELECT attendance.refresh_defaulter_alerts()');
  const now = await db.many(
    `SELECT a.student_id, a.subject_id, a.semester_id, a.alert_type, a.percentage, x.user_id, sub.subject_code, sub.subject_name
       FROM attendance.alerts a
       JOIN identity.students x ON x.student_id = a.student_id
       JOIN attendance.subjects sub ON sub.subject_id = a.subject_id`
  );
  const fresh = now.filter((a) => before.get(key(a)) !== a.alert_type);
  for (const a of fresh) {
    const message = `Your attendance in ${a.subject_code} ${a.subject_name} is ${a.percentage}%.`;
    await notifications.notify(a.user_id, { title: 'Attendance below the required level', message, type: 'attendance' });
  }
  await db.query(`DELETE FROM attendance.user_sessions WHERE COALESCE(logout_at, last_seen_at) < now() - interval '30 days'`);
  if (fresh.length) console.log(`[alerts] ${fresh.length} new or changed defaulter alerts`);
  return { alerts: now.length, notified: fresh.length };
};
