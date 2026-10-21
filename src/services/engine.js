'use strict';
// The automatic attendance engine. Two jobs call it from the worker:
//   ingestBatch()       identification events -> attendance records
//   closeDuePeriods()   after each period: mark absentees, or flag the period for manual marking
const db = require('../config/db');
const notifications = require('./notifications');

const secs = (t) => {
  const [h, m, s] = String(t).split(':').map((x) => parseInt(x, 10) || 0);
  return h * 3600 + m * 60 + s;
};

/**
 * Decide what one event means. Pure, so it is unit-tested without a database.
 * ev:         { classroom_id, confidence, min_confidence, non_working, enrollment_status,
 *               student_section_id, local_time, late_after }
 * candidates: timetable slots in the camera's room whose period window (including the
 *             early-entry window) contains the event:
 *             [{ timetable_id, slot_section_id, start_time, end_time, eligible, enrolled }]
 *             eligible: the student is on the roll of the slot's subject (electives);
 *             enrolled: the student is listed for it by name.
 * Returns { ignore: reason } or { timetable_id, status }.
 */
function decide(ev, candidates) {
  if (!ev.classroom_id) return { ignore: 'camera_unmapped' };
  if (Number(ev.confidence) < Number(ev.min_confidence || 0)) return { ignore: 'low_confidence' };
  if (ev.non_working) return { ignore: 'non_working_day' };
  const slots = candidates.filter((c) => c.timetable_id);
  if (!slots.length) return { ignore: 'no_class_scheduled' };
  if (!ev.student_section_id || ev.enrollment_status !== 'active') return { ignore: 'student_not_active' };
  const own = slots.filter((c) => c.slot_section_id === ev.student_section_id);
  if (!own.length) return { ignore: 'student_not_in_section' };
  const open = own.filter((c) => c.eligible !== false);
  if (!open.length) return { ignore: 'student_not_enrolled' };
  const t = secs(ev.local_time);
  // A period that is running wins over the next period's early-entry window. When two
  // classes of the section share the room in one period, the one the student is listed for wins.
  const rank = (c) => (t >= secs(c.start_time) ? 0 : 2) + (c.enrolled ? 0 : 1);
  const slot = open.slice().sort((a, b) => rank(a) - rank(b) || a.timetable_id - b.timetable_id)[0];
  const late = t > secs(slot.start_time) + Number(ev.late_after || 0) * 60;
  return { timetable_id: slot.timetable_id, status: late ? 'late' : 'present' };
}

const CANDIDATES_SQL = `
  WITH base AS (
    SELECT e.event_id, e.student_id, e.confidence, e.frame_captured_at,
           cam.classroom_id, cl.college_id,
           (e.frame_captured_at AT TIME ZONE col.timezone)::date AS local_date,
           (e.frame_captured_at AT TIME ZONE col.timezone)::time AS local_time,
           stu.section_id AS student_section_id, stu.enrollment_status
      FROM identity.identification_events e
      JOIN identity.cameras cam ON cam.camera_id = e.camera_id
      LEFT JOIN attendance.classrooms cl ON cl.classroom_id = cam.classroom_id
      LEFT JOIN attendance.colleges col ON col.college_id = cl.college_id
      LEFT JOIN identity.students stu ON stu.student_id = e.student_id
     WHERE e.event_id = ANY($1::uuid[])
  )
  SELECT b.*,
         attendance.setting(b.college_id, 'min_confidence', '0')::real AS min_confidence,
         attendance.setting(b.college_id, 'late_after_minutes', '10')::int AS late_after,
         (EXISTS (SELECT 1 FROM attendance.holidays h JOIN attendance.academic_years ay ON ay.academic_year_id = h.academic_year_id
                   WHERE ay.college_id = b.college_id AND h.holiday_date = b.local_date)
          OR EXISTS (SELECT 1 FROM attendance.working_days wd JOIN attendance.academic_years ay ON ay.academic_year_id = wd.academic_year_id
                      WHERE ay.college_id = b.college_id AND wd.work_date = b.local_date AND NOT wd.is_working)) AS non_working,
         p.start_time, p.end_time, t.timetable_id, t.section_id AS slot_section_id,
         CASE WHEN t.timetable_id IS NULL THEN NULL
              ELSE attendance.takes_subject(b.student_id, t.subject_id, t.semester_id, t.section_id) END AS eligible,
         EXISTS (SELECT 1 FROM attendance.student_subjects e
                  WHERE e.student_id = b.student_id AND e.subject_id = t.subject_id AND e.semester_id = t.semester_id) AS enrolled
    FROM base b
    LEFT JOIN attendance.periods p
      ON p.college_id = b.college_id
     AND b.local_time >= p.start_time - make_interval(mins => attendance.setting(b.college_id, 'early_entry_minutes', '5')::int)
     AND b.local_time < p.end_time
    LEFT JOIN attendance.timetable t
      ON t.classroom_id = b.classroom_id AND t.period_id = p.period_id
     AND t.day_of_week = EXTRACT(ISODOW FROM b.local_date)::int
     AND t.effective_from <= b.local_date AND (t.effective_to IS NULL OR t.effective_to >= b.local_date)
     AND EXISTS (SELECT 1 FROM attendance.semesters sem
                  WHERE sem.semester_id = t.semester_id AND b.local_date BETWEEN sem.start_date AND sem.end_date)
   ORDER BY b.event_id, p.start_time, t.timetable_id`;

// First event sets entry and status; later events extend exit time and keep the best
// confidence. A record set by hand is never touched (the WHERE makes the upsert a no-op).
const UPSERT_SQL = `
  INSERT INTO attendance.records AS r
    (student_id, timetable_id, attendance_date, entry_time, exit_time, duration_minutes, attendance_source, confidence, status)
  VALUES ($1, $2, $3, $4, $4, 0, 'ai', $5, $6)
  ON CONFLICT (student_id, timetable_id, attendance_date) DO UPDATE SET
    entry_time = LEAST(COALESCE(r.entry_time, EXCLUDED.entry_time), EXCLUDED.entry_time),
    exit_time = GREATEST(COALESCE(r.exit_time, EXCLUDED.exit_time), EXCLUDED.exit_time),
    duration_minutes = (EXTRACT(EPOCH FROM (
        GREATEST(COALESCE(r.exit_time, EXCLUDED.exit_time), EXCLUDED.exit_time)
      - LEAST(COALESCE(r.entry_time, EXCLUDED.entry_time), EXCLUDED.entry_time))) / 60)::int,
    confidence = GREATEST(COALESCE(r.confidence, 0), EXCLUDED.confidence),
    status = CASE
               WHEN r.status = 'absent' THEN EXCLUDED.status
               WHEN r.status = 'late' AND EXCLUDED.status = 'present' AND EXCLUDED.entry_time < r.entry_time THEN 'present'
               ELSE r.status
             END
  WHERE r.attendance_source <> 'manual'
  RETURNING attendance_id`;

// Parallel classes: the other slots of the same section, day and period.
const SIBLING_ABSENT_SQL = `
  DELETE FROM attendance.records r
   USING attendance.timetable sib, attendance.timetable me
   WHERE me.timetable_id = $3
     AND sib.section_id = me.section_id AND sib.day_of_week = me.day_of_week AND sib.period_id = me.period_id
     AND sib.timetable_id <> me.timetable_id
     AND r.timetable_id = sib.timetable_id AND r.student_id = $1 AND r.attendance_date = $2
     AND r.status = 'absent' AND r.attendance_source = 'ai'`;

/** Process up to `limit` unconsumed events. Returns { events, marked, ignored }. */
async function ingestBatch(limit = 500) {
  return db.tx(async (c) => {
    const claimed = await c.many(
      `SELECT event_id FROM identity.identification_events
        WHERE NOT consumed ORDER BY matched_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    if (!claimed.length) return { events: 0, marked: 0, ignored: 0 };
    const ids = claimed.map((r) => r.event_id);
    const rows = await c.many(CANDIDATES_SQL, [ids]);
    const byEvent = new Map();
    for (const r of rows) {
      if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, []);
      byEvent.get(r.event_id).push(r);
    }
    let marked = 0, ignored = 0;
    const touched = new Map(); // "timetable|date" -> Set(student)
    const results = [];
    for (const id of ids) {
      const cands = byEvent.get(id) || [];
      const ev = cands[0];
      // An event from a camera that is not registered has no row here at all.
      const d = ev ? decide(ev, cands) : { ignore: 'camera_unmapped' };
      let attendanceId = null, reason = d.ignore || null;
      if (!reason) {
        const up = await c.query(UPSERT_SQL, [ev.student_id, d.timetable_id, ev.local_date, ev.frame_captured_at, ev.confidence, d.status]);
        if (up.rowCount) {
          attendanceId = up.rows[0].attendance_id;
          // Seen in this class: an automatic "absent" in a parallel class of the same period no longer holds.
          await c.query(SIBLING_ABSENT_SQL, [ev.student_id, ev.local_date, d.timetable_id]);
          const key = `${d.timetable_id}|${ev.local_date}`;
          if (!touched.has(key)) touched.set(key, new Set());
          touched.get(key).add(ev.student_id);
        } else reason = 'manual_record';
      }
      if (reason) ignored++; else marked++;
      results.push({ event_id: id, attendance_id: attendanceId, ignored_reason: reason });
    }
    await c.query(
      `INSERT INTO attendance.ingested_events (event_id, attendance_id, ignored_reason)
       SELECT v.event_id, v.attendance_id, v.ignored_reason
         FROM jsonb_to_recordset($1::jsonb) AS v(event_id uuid, attendance_id bigint, ignored_reason text)
       ON CONFLICT (event_id) DO NOTHING`,
      [JSON.stringify(results)]
    );
    await c.query('UPDATE identity.identification_events SET consumed = true, consumed_at = now() WHERE event_id = ANY($1::uuid[])', [ids]);

    // Events that arrive after a period was closed change records the summaries already counted.
    for (const [key, students] of touched) {
      const [timetableId, date] = key.split('|');
      const closed = await c.one(
        `SELECT t.semester_id FROM attendance.class_sessions cs JOIN attendance.timetable t ON t.timetable_id = cs.timetable_id
          WHERE cs.timetable_id = $1 AND cs.session_date = $2 AND cs.status = 'closed'`,
        [timetableId, date]
      );
      if (closed) {
        await c.query('SELECT attendance.refresh_daily_summary($1)', [date]);
        await c.query('SELECT attendance.refresh_subject_summary($1, $2::uuid[])', [closed.semester_id, [...students]]);
      }
    }
    return { events: ids.length, marked, ignored };
  });
}

const DUE_SQL = `
  SELECT s.*, p.end_time, col.timezone,
         ((s.session_date + p.start_time) AT TIME ZONE col.timezone) AS starts_at,
         ((s.session_date + p.end_time) AT TIME ZONE col.timezone) AS ends_at,
         attendance.setting(col.college_id, 'min_presence_minutes', '0')::int AS min_presence
    FROM attendance.colleges col
   CROSS JOIN LATERAL attendance.sessions_between(
           ((now() AT TIME ZONE col.timezone)::date - attendance.setting(col.college_id, 'close_catchup_days', '2')::int),
           (now() AT TIME ZONE col.timezone)::date,
           col.college_id) s
    JOIN attendance.periods p ON p.period_id = s.period_id
   WHERE col.is_active AND s.status = 'scheduled'
     AND (s.session_date + p.end_time + make_interval(mins => attendance.setting(col.college_id, 'absent_grace_minutes', '5')::int))
         <= (now() AT TIME ZONE col.timezone)
   ORDER BY s.session_date, p.end_time, s.timetable_id`;

/** Why a period cannot be closed automatically, or null when it can. */
async function manualReason(c, s) {
  // A camera counts as offline for the period when it was offline as the period began,
  // or reported offline at any moment inside it.
  const cams = await c.many(
    `SELECT cam.camera_id,
            (COALESCE((SELECT h.status FROM attendance.camera_health_logs h
                        WHERE h.camera_id = cam.camera_id AND h.recorded_at < $2
                        ORDER BY h.recorded_at DESC LIMIT 1), 'online') = 'offline'
             OR EXISTS (SELECT 1 FROM attendance.camera_health_logs h
                         WHERE h.camera_id = cam.camera_id AND h.status = 'offline'
                           AND h.recorded_at >= $2 AND h.recorded_at <= $3)) AS was_offline
       FROM identity.cameras cam WHERE cam.classroom_id = $1 AND cam.enabled`,
    [s.classroom_id, s.starts_at, s.ends_at]
  );
  if (!cams.length) return 'No enabled camera is mapped to this classroom.';
  if (cams.every((x) => x.was_offline)) return 'The classroom camera was offline during the period.';
  // Lab batches and electives split a section over several classes in one period, so look at all of them.
  const seen = await c.one(
    `SELECT count(*)::int AS n FROM attendance.records r JOIN attendance.timetable t ON t.timetable_id = r.timetable_id
      WHERE r.attendance_date = $1 AND t.section_id = $2 AND t.period_id = $3`,
    [s.session_date, s.section_id, s.period_id]);
  if (!seen.n) return 'No student of the section was detected in the period.';
  return null;
}

/** Close every period whose end time plus grace has passed. Returns { closed, needsManual }. */
async function closeDuePeriods() {
  const due = await db.many(DUE_SQL);
  let closed = 0, needsManual = 0;
  const dates = new Set();
  for (const s of due) {
    await db.tx(async (c) => {
      // The roll of this class: the section, or for an elective only the students listed for it.
      const roster = await c.many(
        `SELECT student_id, enrollment_status, face_registered FROM identity.students x
          WHERE x.section_id = $1 AND x.enrollment_status IN ('active', 'opted_out')
            AND attendance.takes_subject(x.student_id, $2, $3, $1)`,
        [s.section_id, s.subject_id, s.semester_id]
      );
      const reason = roster.length ? await manualReason(c, s) : null;
      const status = reason ? 'needs_manual' : 'closed';
      const up = await c.query(
        `INSERT INTO attendance.class_sessions (timetable_id, session_date, status, staff_id, closed_at, note)
         VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'closed' THEN now() END, $5)
         ON CONFLICT (timetable_id, session_date) DO NOTHING RETURNING class_session_id`,
        [s.timetable_id, s.session_date, status, s.staff_id, reason]
      );
      if (!up.rowCount) return; // another worker got there first
      if (reason) {
        needsManual++;
        const who = await c.many(
          `SELECT st.user_id FROM attendance.staff st WHERE st.staff_id = $1
           UNION
           SELECT hs.user_id FROM attendance.departments d JOIN attendance.staff hs ON hs.staff_id = d.hod_staff_id WHERE d.department_id = $2`,
          [s.staff_id, s.department_id]
        );
        for (const u of who) {
          await notifications.notify(u.user_id, {
            title: 'A period needs manual marking',
            message: `${s.session_date}, slot ${s.timetable_id}: ${reason} Open Attendance and mark it by hand.`,
            type: 'attendance',
          }, c);
        }
        return;
      }
      // Absent for everyone who can be recognised and was not. Opted-out students and
      // students with no registered face are left unmarked for staff ("manual only").
      // With parallel classes a student belongs to one of them: absent is recorded once, against the
      // first class that closes, and only for students with no mark in any class of the period.
      await c.query(
        `INSERT INTO attendance.records (student_id, timetable_id, attendance_date, attendance_source, status)
         SELECT x.student_id, $1, $2, 'ai', 'absent' FROM identity.students x
          WHERE x.section_id = $3 AND x.enrollment_status = 'active' AND x.face_registered
            AND attendance.takes_subject(x.student_id, $4, $5, $3)
            AND NOT EXISTS (
                  SELECT 1 FROM attendance.records r JOIN attendance.timetable t ON t.timetable_id = r.timetable_id
                   WHERE r.student_id = x.student_id AND r.attendance_date = $2
                     AND t.section_id = $3 AND t.period_id = $6)
         ON CONFLICT (student_id, timetable_id, attendance_date) DO NOTHING`,
        [s.timetable_id, s.session_date, s.section_id, s.subject_id, s.semester_id, s.period_id]
      );
      if (s.min_presence > 0) {
        await c.query(
          `UPDATE attendance.records SET status = 'absent'
            WHERE timetable_id = $1 AND attendance_date = $2 AND attendance_source = 'ai'
              AND status IN ('present', 'late') AND COALESCE(duration_minutes, 0) < $3`,
          [s.timetable_id, s.session_date, s.min_presence]
        );
      }
      await c.query('SELECT attendance.refresh_subject_summary($1, $2::uuid[])', [s.semester_id, roster.map((r) => r.student_id)]);
      closed++;
      dates.add(s.session_date);
    });
  }
  for (const d of dates) await db.query('SELECT attendance.refresh_daily_summary($1)', [d]);
  return { closed, needsManual };
}

module.exports = { decide, ingestBatch, closeDuePeriods };
