'use strict';
const db = require('../config/db');

/** Create an in-app notification; skips an identical unread one so jobs can re-run safely. */
async function notify(userId, { title, message, type = 'system' }, client = db) {
  if (!userId) return;
  await client.query(
    `INSERT INTO attendance.notifications (user_id, title, message, notification_type)
     SELECT $1, $2, $3, $4
      WHERE NOT EXISTS (SELECT 1 FROM attendance.notifications
                         WHERE user_id = $1 AND title = $2 AND message = $3 AND NOT is_read)`,
    [userId, title, message, type]
  );
}

const unreadCount = async (userId) =>
  (await db.one('SELECT count(*)::int AS n FROM attendance.notifications WHERE user_id = $1 AND NOT is_read', [userId])).n;

const list = (userId, limit, offset) =>
  db.many(
    `SELECT notification_id, title, message, notification_type, is_read, created_at
       FROM attendance.notifications WHERE user_id = $1
      ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [userId, limit, offset]
  );

const markRead = (userId, id) =>
  db.query(
    `UPDATE attendance.notifications SET is_read = true
      WHERE user_id = $1 AND ($2::bigint IS NULL OR notification_id = $2)`,
    [userId, id || null]
  );

function queueEmail({ email, subject, message, studentId = null }, client = db) {
  if (!email) return Promise.resolve();
  return client.query(
    'INSERT INTO attendance.email_queue (student_id, email, subject, message) VALUES ($1, $2, $3, $4)',
    [studentId, email, subject, message]
  );
}

module.exports = { notify, unreadCount, list, markRead, queueEmail };
