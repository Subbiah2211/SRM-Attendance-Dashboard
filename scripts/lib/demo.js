'use strict';
// Demo data and a stand-in for the recognition pipeline. The real pipeline (Phase 1)
// writes identity.identification_events; these helpers write the same rows so the
// dashboard can be tried without cameras.
const db = require('../../src/config/db');
const permissions = require('../../src/services/permissions');
const engine = require('../../src/services/engine');
const { hashPassword } = require('../../src/utils/crypto');
const { todayIn, addDays } = require('../../src/utils/dates');

const PASSWORDS = { superadmin: 'Super@12345', admin: 'Admin@12345', hod: 'Hod@12345', staff: 'Staff@12345', student: 'Student@12345' };

const COLLEGES = [
  { code: 'srm-vec', name: 'SRM VEC', campus: 'Kattankulathur', full: true },
  { code: 'srmist-ktr', name: 'SRM IST', campus: 'Kattankulathur', full: false },
  { code: 'srmist-rmp', name: 'SRMIST Ramapuram', campus: 'Ramapuram', full: false },
];

const PERIODS = [['09:00', '09:50'], ['09:50', '10:40'], ['10:55', '11:45'], ['11:45', '12:35'], ['13:30', '14:20'], ['14:20', '15:10']];
const FIRST = ['Aarav', 'Aditi', 'Akash', 'Ananya', 'Arjun', 'Bhavana', 'Deepak', 'Divya', 'Gokul', 'Harini', 'Ishaan', 'Janani', 'Karthik', 'Kavya', 'Lokesh', 'Meera', 'Naveen', 'Nithya', 'Pranav', 'Priya', 'Rahul', 'Sandhya', 'Varun', 'Yamini'];
const LAST = ['Kumar', 'Raman', 'Iyer', 'Nair', 'Reddy', 'Pillai', 'Menon', 'Babu'];

/** Small seeded generator so the demo looks the same on every run. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const q = (c, text, params) => c.query(text, params).then((r) => r.rows[0]);

async function addUser(c, collegeId, role, username, first, last, departmentId, hash, email) {
  return (await q(c,
    `INSERT INTO attendance.users (username, password_hash, role_id, department_id, first_name, last_name, email, college_id, must_change_password)
     SELECT $1, $2, role_id, $3, $4, $5, $6, $7, false FROM attendance.roles WHERE role_name = $8 RETURNING user_id`,
    [username, hash, departmentId, first, last, email || null, collegeId, role])).user_id;
}

async function seedCollege(c, col, hashes, today) {
  const college = await q(c, `INSERT INTO attendance.colleges (college_code, college_name, campus) VALUES ($1, $2, $3) RETURNING *`, [col.code, col.name, col.campus]);
  const cid = college.college_id;
  await permissions.seedDefaults(cid, null, c);
  await addUser(c, cid, 'admin', 'admin', 'College', 'Admin', null, hashes.admin, `admin@${col.code}.example.edu`);

  // Academic year around today; the odd term runs June to November.
  const y = parseInt(today.slice(0, 4), 10), m = parseInt(today.slice(5, 7), 10);
  const startYear = m >= 6 ? y : y - 1;
  const odd = m >= 6 && m <= 11;
  const ay = await q(c, `INSERT INTO attendance.academic_years (college_id, label, start_date, end_date, is_active) VALUES ($1, $2, $3, $4, true) RETURNING *`,
    [cid, `${startYear}-${String(startYear + 1).slice(2)}`, `${startYear}-06-01`, `${startYear + 1}-05-31`]);
  const sem = {};
  for (let n = 1; n <= 8; n++) {
    const isOdd = n % 2 === 1;
    sem[n] = await q(c, `INSERT INTO attendance.semesters (academic_year_id, semester_no, start_date, end_date) VALUES ($1, $2, $3, $4) RETURNING *`,
      [ay.academic_year_id, n, isOdd ? `${startYear}-06-01` : `${startYear}-12-01`, isOdd ? `${startYear}-11-30` : `${startYear + 1}-05-31`]);
  }
  for (const [name, date] of [['Independence Day', `${startYear}-08-15`], ['Gandhi Jayanti', `${startYear}-10-02`], ['Republic Day', `${startYear + 1}-01-26`]]) {
    await c.query(`INSERT INTO attendance.holidays (academic_year_id, holiday_name, holiday_date, holiday_type) VALUES ($1, $2, $3, 'government')`, [ay.academic_year_id, name, date]);
  }
  const periods = [];
  for (let i = 0; i < PERIODS.length; i++) {
    periods.push(await q(c, `INSERT INTO attendance.periods (college_id, period_no, start_time, end_time, duration_minutes) VALUES ($1, $2, $3, $4, 50) RETURNING *`, [cid, i + 1, PERIODS[i][0], PERIODS[i][1]]));
  }
  const program = await q(c, `INSERT INTO attendance.programs (college_id, program_code, program_name, duration_years) VALUES ($1, 'BTECH', 'Bachelor of Technology', 4) RETURNING *`, [cid]);
  const dept = {};
  for (const [code, name] of [['CSE', 'Computer Science and Engineering'], ['ECE', 'Electronics and Communication Engineering']]) {
    dept[code] = await q(c, `INSERT INTO attendance.departments (college_id, department_code, department_name) VALUES ($1, $2, $3) RETURNING *`, [cid, code, name]);
  }
  if (!col.full) return { college, students: 0 };

  // Rooms, one camera each.
  const room = {};
  for (const [no, floor] of [['LH-101', 1], ['LH-102', 1], ['LH-201', 2], ['LH-202', 2]]) {
    room[no] = await q(c, `INSERT INTO attendance.classrooms (college_id, room_number, block_name, floor_no, capacity) VALUES ($1, $2, 'Main Block', $3, 60) RETURNING *`, [cid, no, floor]);
    await c.query(`INSERT INTO identity.cameras (camera_id, location_label, source_ref, classroom_id) VALUES ($1, $2, $3, $4)`,
      [`${col.code}-${no.toLowerCase()}`, `Main Block ${no}`, `secret/cameras/${col.code}/${no.toLowerCase()}`, room[no].classroom_id]);
    await c.query(`INSERT INTO attendance.camera_health_logs (camera_id, status, network_latency_ms, recorded_at) VALUES ($1, 'online', 18, now() - interval '30 days')`, [`${col.code}-${no.toLowerCase()}`]);
  }

  // Staff: an HOD and teaching staff per department.
  const staff = {};
  const STAFF = [
    ['CSE', 'hod', 'hod.cse', 'CSE001', 'Lakshmi', 'Narayanan', 'Professor and Head'],
    ['CSE', 'staff', 'cse.staff1', 'CSE002', 'Priya', 'Raman', 'Associate Professor'],
    ['CSE', 'staff', 'cse.staff2', 'CSE003', 'Suresh', 'Babu', 'Assistant Professor'],
    ['CSE', 'staff', 'cse.staff3', 'CSE004', 'Anitha', 'Menon', 'Assistant Professor'],
    ['CSE', 'staff', 'cse.staff4', 'CSE005', 'Vignesh', 'Iyer', 'Assistant Professor'],
    ['CSE', 'staff', 'cse.staff5', 'CSE006', 'Revathi', 'Pillai', 'Assistant Professor'],
    ['CSE', 'staff', 'cse.staff6', 'CSE007', 'Manoj', 'Reddy', 'Assistant Professor'],
    ['ECE', 'hod', 'hod.ece', 'ECE001', 'Ramesh', 'Krishnan', 'Professor and Head'],
    ['ECE', 'staff', 'ece.staff1', 'ECE002', 'Sangeetha', 'Nair', 'Associate Professor'],
    ['ECE', 'staff', 'ece.staff2', 'ECE003', 'Dinesh', 'Kumar', 'Assistant Professor'],
    ['ECE', 'staff', 'ece.staff3', 'ECE004', 'Kalpana', 'Rao', 'Assistant Professor'],
  ];
  for (const [d, role, username, code, first, last, designation] of STAFF) {
    const uid = await addUser(c, cid, role, username, first, last, dept[d].department_id, hashes[role], `${username}@${col.code}.example.edu`);
    staff[code] = await q(c, `INSERT INTO attendance.staff (user_id, staff_code, designation, department_id, college_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [uid, code, designation, dept[d].department_id, cid]);
    if (role === 'hod') await c.query('UPDATE attendance.departments SET hod_staff_id = $2 WHERE department_id = $1', [dept[d].department_id, staff[code].staff_id]);
  }

  // Sections of the running term, each with its subjects, staff and home room.
  const [semA, semB] = odd ? [3, 5] : [4, 6];
  const PLAN = [
    { dept: 'CSE', sem: semA, name: 'A', room: 'LH-101', shift: 0, subjects: [['CS301', 'Data Structures', 'CSE002'], ['CS302', 'Digital Logic Design', 'CSE003'], ['CS303', 'Object Oriented Programming', 'CSE004'], ['MA301', 'Discrete Mathematics', 'CSE005']] },
    { dept: 'CSE', sem: semA, name: 'B', room: 'LH-102', shift: 1, subjects: [['CS301', 'Data Structures', 'CSE002'], ['CS302', 'Digital Logic Design', 'CSE003'], ['CS303', 'Object Oriented Programming', 'CSE004'], ['MA301', 'Discrete Mathematics', 'CSE005']] },
    { dept: 'CSE', sem: semB, name: 'A', room: 'LH-201', shift: 0, subjects: [['CS501', 'Operating Systems', 'CSE006'], ['CS502', 'Computer Networks', 'CSE007'], ['CS503', 'Database Systems', 'CSE001']] },
    { dept: 'ECE', sem: semA, name: 'A', room: 'LH-202', shift: 0, subjects: [['EC301', 'Signals and Systems', 'ECE002'], ['EC302', 'Electronic Circuits', 'ECE003'], ['EC303', 'Network Analysis', 'ECE004'], ['EC304', 'Electromagnetic Fields', 'ECE001']] },
  ];
  const subject = {};
  let students = 0, studentNo = 0;
  for (const p of PLAN) {
    const section = await q(c,
      `INSERT INTO attendance.sections (department_id, program_id, academic_year_id, semester_id, section_name, strength) VALUES ($1, $2, $3, $4, $5, 60) RETURNING *`,
      [dept[p.dept].department_id, program.program_id, ay.academic_year_id, sem[p.sem].semester_id, p.name]);
    for (const [code, name] of p.subjects) {
      if (!subject[code]) {
        subject[code] = await q(c, `INSERT INTO attendance.subjects (college_id, subject_code, subject_name, department_id, semester_no, credits, total_hours) VALUES ($1, $2, $3, $4, $5, 4, 60) RETURNING *`,
          [cid, code, name, dept[p.dept].department_id, p.sem]);
      }
    }
    // Monday to Friday periods 1-5, Saturday periods 1-3. Section B is shifted one subject so staff never clash.
    for (let day = 1; day <= 6; day++) {
      for (let pi = 0; pi < (day === 6 ? 3 : 5); pi++) {
        const [code, , staffCode] = p.subjects[(day + pi + p.shift) % p.subjects.length];
        await c.query(
          `INSERT INTO attendance.timetable (academic_year_id, semester_id, section_id, subject_id, staff_id, classroom_id, day_of_week, period_id, effective_from)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [ay.academic_year_id, sem[p.sem].semester_id, section.section_id, subject[code].subject_id, staff[staffCode].staff_id, room[p.room].classroom_id, day, periods[pi].period_id, sem[p.sem].start_date]);
      }
    }
    // 24 students per section. Two are "manual only": one opted out, one with no registered face.
    for (let i = 0; i < 24; i++) {
      studentNo++;
      const reg = `VEC${String(startYear).slice(2)}${p.dept}${p.sem}${p.name}${String(i + 1).padStart(3, '0')}`;
      const name = `${FIRST[i % FIRST.length]} ${LAST[(i + studentNo) % LAST.length]}`;
      const uid = await addUser(c, cid, 'student', reg.toLowerCase(), name, null, dept[p.dept].department_id, hashes.student);
      await c.query(
        `INSERT INTO identity.students (university_id, full_name, user_id, section_id, register_no, roll_no, batch_year, enrollment_status, consent_granted_at, face_registered, college_id)
         VALUES ($1, $2, $3, $4, $1, $5, $6, $7, $8, $9, $10)`,
        [reg, name, uid, section.section_id, String(i + 1).padStart(2, '0'), startYear - Math.ceil(p.sem / 2) + 1,
          i === 22 ? 'opted_out' : 'active', i === 22 ? null : new Date(), i < 22, cid]);
      students++;
    }
  }
  // A few unresolved detections for the review queue.
  for (let i = 0; i < 3; i++) {
    await c.query(
      `INSERT INTO identity.unresolved_detections (camera_id, frame_captured_at, track_id, stage, reason, detector_score, box, best_similarity, margin, model_version)
       VALUES ($1, now() - make_interval(hours => $2), $3, 'match', 'below_match_threshold', 0.91, '{120,80,220,210}', 0.41, 0.03, 'demo-1')`,
      [`${col.code}-lh-101`, 3 + i * 5, 100 + i]);
  }
  return { college, students };
}

/**
 * Write identification events for every class of a college between two dates,
 * as the recognition pipeline would. Only events up to "now" are written, and
 * students who already have a record for a class are skipped.
 * skip: optional fn(session) => true to leave a class without events.
 */
async function generateEvents(collegeCode, from, to, { seed = 7, skip = null, presentRate = 0.9 } = {}) {
  const college = await db.one('SELECT * FROM attendance.colleges WHERE college_code = $1', [collegeCode]);
  if (!college) throw new Error(`No college with code ${collegeCode}`);
  const rand = rng(seed + parseInt(from.replace(/-/g, ''), 10));
  const sessions = await db.many(
    `SELECT s.session_date, s.timetable_id, s.section_id, p.start_time, cam.camera_id
       FROM attendance.sessions_between($1::date, $2::date, $3) s
       JOIN attendance.periods p ON p.period_id = s.period_id
       JOIN identity.cameras cam ON cam.classroom_id = s.classroom_id AND cam.enabled
      WHERE s.status = 'scheduled'
        AND ((s.session_date + p.start_time) AT TIME ZONE $4) <= now()
      ORDER BY s.session_date, p.start_time`,
    [from, to, college.college_id, college.timezone]);
  const roster = await db.many(
    `SELECT x.student_id, x.section_id, x.roll_no FROM identity.students x
      WHERE x.college_id = $1 AND x.enrollment_status = 'active' AND x.face_registered`, [college.college_id]);
  const done = new Set((await db.many(
    `SELECT r.student_id || '|' || r.timetable_id || '|' || r.attendance_date AS k FROM attendance.records r
      WHERE r.attendance_date BETWEEN $1 AND $2`, [from, to])).map((r) => r.k));
  const events = [];
  const add = (d, hhmm, offsetSec) => {
    const [h, m] = hhmm.split(':').map(Number);
    const t = h * 3600 + m * 60 + offsetSec;
    const pad = (n) => String(Math.floor(n)).padStart(2, '0');
    return `${d} ${pad(t / 3600)}:${pad((t % 3600) / 60)}:${pad(t % 60)}`;
  };
  for (const s of sessions) {
    if (skip && skip(s)) continue;
    for (const st of roster.filter((r) => r.section_id === s.section_id)) {
      if (done.has(`${st.student_id}|${s.timetable_id}|${s.session_date}`)) continue;
      const roll = parseInt(st.roll_no, 10) || 0;
      const rate = roll % 8 === 0 ? 0.55 : presentRate; // a few students attend poorly, to fill the defaulter list
      if (rand() > rate) continue;
      const late = rand() < 0.08;
      const entry = late ? 12 * 60 + rand() * 600 : -180 + rand() * 540;
      const start = String(s.start_time).slice(0, 5);
      events.push({ student_id: st.student_id, camera_id: s.camera_id, confidence: 0.8 + rand() * 0.19, ts: add(s.session_date, start, entry) });
      events.push({ student_id: st.student_id, camera_id: s.camera_id, confidence: 0.8 + rand() * 0.19, ts: add(s.session_date, start, 38 * 60 + rand() * 600) });
    }
  }
  for (let i = 0; i < events.length; i += 2000) {
    await db.query(
      `INSERT INTO identity.identification_events (student_id, camera_id, confidence, frame_captured_at, model_version)
       SELECT v.student_id, v.camera_id, v.confidence, (v.ts::timestamp AT TIME ZONE $2), 'demo-1'
         FROM jsonb_to_recordset($1::jsonb) AS v(student_id uuid, camera_id text, confidence real, ts text)
        WHERE (v.ts::timestamp AT TIME ZONE $2) <= now()`,
      [JSON.stringify(events.slice(i, i + 2000)), college.timezone]);
  }
  return events.length;
}

/** Run the engine until every waiting event is consumed and every due period is closed. */
async function runEngine() {
  let events = 0;
  for (;;) {
    const r = await engine.ingestBatch(1000);
    events += r.events;
    if (!r.events) break;
  }
  const closed = await engine.closeDuePeriods();
  await db.query('SELECT attendance.refresh_defaulter_alerts()');
  return { events, ...closed };
}

async function seedDemo({ log = console.log, days = 10 } = {}) {
  if (await db.one(`SELECT 1 FROM attendance.colleges WHERE college_code = ANY($1)`, [COLLEGES.map((c) => c.code)])) {
    throw new Error('Demo colleges already exist in this database. Use an empty database for the demo.');
  }
  const hashes = {};
  for (const [role, pw] of Object.entries(PASSWORDS)) hashes[role] = await hashPassword(pw);
  const today = todayIn('Asia/Kolkata');
  let main = null;
  await db.tx(async (c) => {
    if (!(await q(c, `SELECT 1 AS x FROM attendance.users WHERE college_id IS NULL AND lower(username) = 'superadmin'`))) {
      await addUser(c, null, 'superadmin', 'superadmin', 'Group', 'Administrator', null, hashes.superadmin, 'superadmin@example.edu');
    }
    for (const col of COLLEGES) {
      const r = await seedCollege(c, col, hashes, today);
      if (col.full) main = r;
      log(`  ${col.name}: ${r.students || 'no'} students`);
    }
  });
  permissions.invalidate(main.college.college_id);

  // Past attendance: the period-close job only looks back close_catchup_days, so widen it for the backfill.
  const cid = main.college.college_id;
  await db.query(`INSERT INTO attendance.system_settings (college_id, setting_key, setting_value) VALUES ($1, 'close_catchup_days', $2)`, [cid, String(days)]);
  // One period yesterday (or the last class day) with its camera offline, to show manual marking.
  const offline = await db.one(
    `SELECT s.session_date, s.timetable_id, p.start_time, p.end_time, cam.camera_id
       FROM attendance.sessions_between($1::date, $2::date, $3) s
       JOIN attendance.periods p ON p.period_id = s.period_id
       JOIN identity.cameras cam ON cam.classroom_id = s.classroom_id
       JOIN attendance.departments d ON d.department_id = s.department_id
      WHERE d.department_code = 'ECE' AND p.period_no = 2 ORDER BY s.session_date DESC LIMIT 1`,
    [addDays(today, -days), addDays(today, -1), cid]);
  if (offline) {
    await db.query(
      `INSERT INTO attendance.camera_health_logs (camera_id, status, recorded_at) VALUES
         ($1, 'offline', (($2::date + $3::time) AT TIME ZONE 'Asia/Kolkata') + interval '30 seconds'),
         ($1, 'online',  (($2::date + $4::time) AT TIME ZONE 'Asia/Kolkata') + interval '3 minutes')`,
      [offline.camera_id, offline.session_date, offline.start_time, offline.end_time]);
  }
  const n = await generateEvents('srm-vec', addDays(today, -days), today, {
    skip: (s) => offline && s.timetable_id === offline.timetable_id && s.session_date === offline.session_date,
  });
  log(`  ${n} identification events written; running the attendance engine ...`);
  const r = await runEngine();
  await db.query(`DELETE FROM attendance.system_settings WHERE college_id = $1 AND setting_key = 'close_catchup_days'`, [cid]);
  log(`  ${r.events} events processed, ${r.closed} periods closed, ${r.needsManual} need manual marking`);
  return { ...r, eventsWritten: n };
}

module.exports = { seedDemo, generateEvents, runEngine, PASSWORDS, COLLEGES };
