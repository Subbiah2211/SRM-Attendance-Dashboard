'use strict';
const db = require('../config/db');
const { Where } = require('../utils/sql');

function health(scope) {
  const w = new Where();
  if (scope.collegeId) w.add('cam.college_id = ?', scope.collegeId);
  return db.many(
    `SELECT cam.camera_id, cam.location_label, cam.enabled, concat_ws(' ', cl.block_name, cl.room_number) AS room,
            h.status, h.network_latency_ms, h.recorded_at,
            (SELECT max(e.frame_captured_at) FROM identity.identification_events e WHERE e.camera_id = cam.camera_id) AS last_event_at
       FROM identity.cameras cam
       LEFT JOIN attendance.classrooms cl ON cl.classroom_id = cam.classroom_id
       LEFT JOIN LATERAL (
         SELECT status, network_latency_ms, recorded_at FROM attendance.camera_health_logs
          WHERE camera_id = cam.camera_id ORDER BY recorded_at DESC LIMIT 1) h ON true
       ${w} ORDER BY cam.camera_id`,
    w.params
  );
}

/** Why events were ignored in the last 7 days: the admin's cue that a timetable or mapping is out of date. */
function ignoredReasons(scope) {
  const w = new Where();
  w.parts.push('ie.ignored_reason IS NOT NULL', "ie.ingested_at > now() - interval '7 days'");
  if (scope.collegeId) w.add('cam.college_id = ?', scope.collegeId);
  return db.many(
    `SELECT ie.ignored_reason, count(*)::int AS events, max(ie.ingested_at) AS last_at
       FROM attendance.ingested_events ie
       JOIN identity.identification_events e ON e.event_id = ie.event_id
       JOIN identity.cameras cam ON cam.camera_id = e.camera_id
       ${w} GROUP BY ie.ignored_reason ORDER BY events DESC`,
    w.params
  );
}

async function unknown(scope, reviewed, pg) {
  const w = new Where();
  if (scope.collegeId) w.add('cam.college_id = ?', scope.collegeId);
  w.add('v.reviewed = ?', !!reviewed);
  const from = `FROM attendance.vw_unknown_reviews v JOIN identity.cameras cam ON cam.camera_id = v.camera_id ${w}`;
  const total = (await db.one(`SELECT count(*)::int AS n ${from}`, w.params)).n;
  const rows = await db.many(
    `SELECT v.detection_id, v.camera_id, cam.location_label, v.frame_captured_at, v.stage, v.reason, v.best_similarity, v.reviewed, v.remarks
       ${from} ORDER BY v.frame_captured_at DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`,
    w.params
  );
  return { rows, total };
}

async function review(scope, detectionId, userId, remarks) {
  const w = new Where().add('u.detection_id = ?', detectionId);
  if (scope.collegeId) w.add('cam.college_id = ?', scope.collegeId);
  const hit = await db.one(`SELECT u.detection_id FROM identity.unresolved_detections u JOIN identity.cameras cam ON cam.camera_id = u.camera_id ${w}`, w.params);
  if (!hit) return false;
  await db.query(
    `INSERT INTO attendance.unknown_reviews (detection_id, reviewed, reviewed_by, remarks, reviewed_at) VALUES ($1, true, $2, $3, now())
     ON CONFLICT (detection_id) DO UPDATE SET reviewed = true, reviewed_by = EXCLUDED.reviewed_by, remarks = EXCLUDED.remarks, reviewed_at = now()`,
    [detectionId, userId, remarks || null]
  );
  return true;
}

/**
 * Cameras a user may open in the camera view. Admin: the college's cameras. HOD: cameras in rooms
 * the department's classes use. Staff: cameras in rooms of their own classes. Students: none.
 */
function viewable(scope) {
  const w = new Where();
  w.parts.push('cam.enabled');
  if (scope.collegeId) w.add('cam.college_id = ?', scope.collegeId);
  if (scope.role === 'hod') {
    w.parts.push(`EXISTS (SELECT 1 FROM attendance.timetable t JOIN attendance.sections sec ON sec.section_id = t.section_id
                           WHERE t.classroom_id = cam.classroom_id AND t.is_active AND sec.department_id = ${w.p(scope.departmentId || 0)})`);
  }
  if (scope.role === 'staff') {
    w.parts.push(`EXISTS (SELECT 1 FROM attendance.timetable t WHERE t.classroom_id = cam.classroom_id AND t.is_active AND t.staff_id = ${w.p(scope.staffId || 0)})`);
  }
  if (scope.role === 'student') w.parts.push('false');
  return db.many(
    `SELECT cam.camera_id, cam.location_label, cam.classroom_id, cam.viewer_url, concat_ws(' ', cl.block_name, cl.room_number) AS room,
            h.status, h.recorded_at
       FROM identity.cameras cam
       LEFT JOIN attendance.classrooms cl ON cl.classroom_id = cam.classroom_id
       LEFT JOIN LATERAL (SELECT status, recorded_at FROM attendance.camera_health_logs
                           WHERE camera_id = cam.camera_id ORDER BY recorded_at DESC LIMIT 1) h ON true
       ${w} ORDER BY cl.room_number NULLS LAST, cam.camera_id`,
    w.params
  );
}

/** What one camera has seen today: the class in its room now, counts, and the latest recognitions. */
async function activity(cam, timezone, limit = 40) {
  const [now, counts, recent] = await Promise.all([
    cam.classroom_id ? db.many(
      `SELECT s.timetable_id, s.session_date, p.period_no, p.start_time, p.end_time, sub.subject_code, sub.short_name, sub.subject_name,
              d.department_code || ' Sem ' || sem.semester_no || ' ' || sec.section_name AS section_label,
              btrim(concat_ws(' ', u.first_name, u.last_name)) AS staff_name
         FROM attendance.sessions_between((now() AT TIME ZONE $2)::date, (now() AT TIME ZONE $2)::date, $3) s
         JOIN attendance.periods p ON p.period_id = s.period_id
         JOIN attendance.subjects sub ON sub.subject_id = s.subject_id
         JOIN attendance.sections sec ON sec.section_id = s.section_id
         JOIN attendance.departments d ON d.department_id = sec.department_id
         JOIN attendance.semesters sem ON sem.semester_id = sec.semester_id
         JOIN attendance.staff st ON st.staff_id = s.staff_id JOIN attendance.users u ON u.user_id = st.user_id
        WHERE s.classroom_id = $1 AND (now() AT TIME ZONE $2)::time BETWEEN p.start_time AND p.end_time`,
      [cam.classroom_id, timezone, cam.college_id || null]) : [],
    db.one(
      `SELECT count(*)::int AS events, count(DISTINCT e.student_id)::int AS students, max(e.frame_captured_at) AS last_at,
              (SELECT count(*)::int FROM identity.unresolved_detections u
                WHERE u.camera_id = $1 AND u.frame_captured_at >= ((now() AT TIME ZONE $2)::date::timestamp AT TIME ZONE $2)) AS unknown
         FROM identity.identification_events e
        WHERE e.camera_id = $1 AND e.frame_captured_at >= ((now() AT TIME ZONE $2)::date::timestamp AT TIME ZONE $2)`,
      [cam.camera_id, timezone]),
    db.many(
      `SELECT e.frame_captured_at, e.confidence, x.student_id, x.full_name, x.register_no, ie.ignored_reason, r.status
         FROM identity.identification_events e
         JOIN identity.students x ON x.student_id = e.student_id
         LEFT JOIN attendance.ingested_events ie ON ie.event_id = e.event_id
         LEFT JOIN attendance.records r ON r.attendance_id = ie.attendance_id
        WHERE e.camera_id = $1 AND e.frame_captured_at >= ((now() AT TIME ZONE $2)::date::timestamp AT TIME ZONE $2)
        ORDER BY e.frame_captured_at DESC LIMIT ${parseInt(limit, 10) || 40}`,
      [cam.camera_id, timezone]),
  ]);
  return { now, counts, recent };
}

module.exports = { health, ignoredReasons, unknown, review, viewable, activity };
