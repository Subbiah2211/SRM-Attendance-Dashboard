'use strict';
const nodemailer = require('nodemailer');
const db = require('../config/db');
const config = require('../config/env');

let transport = null;
function getTransport() {
  if (!config.smtp.host) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transport;
}

/** Send queued emails. With no SMTP host configured the queue simply waits. */
module.exports = async function sendEmails() {
  const t = getTransport();
  if (!t) return { sent: 0, skipped: true };
  const batch = await db.many(`SELECT email_id, email, subject, message FROM attendance.email_queue WHERE status = 'pending' ORDER BY created_at LIMIT 20`);
  let sent = 0;
  for (const m of batch) {
    try {
      await t.sendMail({ from: config.smtp.from, to: m.email, subject: m.subject, text: m.message });
      await db.query(`UPDATE attendance.email_queue SET status = 'sent', sent_at = now() WHERE email_id = $1`, [m.email_id]);
      sent++;
    } catch (err) {
      console.error('[email] failed', m.email_id, err.message);
      await db.query(`UPDATE attendance.email_queue SET status = 'failed' WHERE email_id = $1`, [m.email_id]);
    }
  }
  return { sent };
};
