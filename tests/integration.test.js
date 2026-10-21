'use strict';
// End-to-end tests against a real PostgreSQL database.
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/srm_attendance_test npm test
// The database is wiped and rebuilt, so its name must contain "test". Without the
// variable these tests are skipped and only the unit tests run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'set TEST_DATABASE_URL to run the integration tests' : false;
if (url) {
  if (!/test/i.test(new URL(url).pathname)) throw new Error('TEST_DATABASE_URL must point at a database whose name contains "test"');
  process.env.DATABASE_URL = url;
  process.env.NODE_ENV = 'test';
  process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'att-test-'));
  process.env.PHOTO_DIR = path.join(process.env.STORAGE_DIR, 'var', 'photos');
}

let app, db, request, ExcelJS, PW, today, addDays;
const S = {}; // state shared between tests

async function signIn(college, username, password) {
  const agent = request.agent(app);
  const r = await agent.post('/api/v1/auth/login').send({ college_code: college, username, password });
  const csrf = r.body.csrf_token;
  return {
    status: r.status, body: r.body, agent,
    get: (u) => agent.get('/api/v1' + u),
    post: (u) => agent.post('/api/v1' + u).set('x-csrf-token', csrf),
    put: (u) => agent.put('/api/v1' + u).set('x-csrf-token', csrf),
  };
}
async function workbook(name, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  rows.forEach((r) => ws.addRow(r));
  const file = path.join(process.env.STORAGE_DIR, name);
  await wb.xlsx.writeFile(file);
  return file;
}
async function upload(who, type, file, fields = {}) {
  let req = who.post('/imports').field('import_type', type);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  const up = await req.attach('file', file);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  return (await who.get(`/imports/${up.body.batch_id}`)).body;
}

test.before(async () => {
  if (skip) return;
  const { Client } = require('pg');
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA IF EXISTS attendance CASCADE; DROP SCHEMA IF EXISTS identity CASCADE;');
  await c.end();
  await require('../scripts/migrate').migrate(url, { withBase: true, log: () => {} });
  db = require('../src/config/db');
  const demo = require('../scripts/lib/demo');
  await demo.seedDemo({ log: () => {} });
  PW = demo.PASSWORDS;
  request = require('supertest');
  ExcelJS = require('exceljs');
  ({ addDays } = require('../src/utils/dates'));
  today = require('../src/utils/dates').todayIn('Asia/Kolkata');
  app = require('../src/app').createApp();
  S.admin = await signIn('srm-vec', 'admin', PW.admin);
  S.hod = await signIn('srm-vec', 'hod.cse', PW.hod);
  S.staff = await signIn('srm-vec', 'cse.staff1', PW.staff);
  S.other = await signIn('srmist-ktr', 'admin', PW.admin);
  S.sup = await signIn('', 'superadmin', PW.superadmin);
  S.vec = (await db.one(`SELECT college_id FROM attendance.colleges WHERE college_code = 'srm-vec'`)).college_id;
  S.range = `from=${addDays(today, -10)}&to=${today}`;
});
test.after(async () => { if (db) await db.end(); });

test('login: wrong password is refused, and five failures lock the account', { skip }, async () => {
  const student = (await db.one(`SELECT u.username FROM attendance.users u JOIN identity.students s ON s.user_id = u.user_id WHERE u.college_id = $1 ORDER BY u.username DESC LIMIT 1`, [S.vec])).username;
  for (let i = 0; i < 5; i++) assert.equal((await signIn('srm-vec', student, 'wrong-password')).status, 401);
  assert.equal((await signIn('srm-vec', student, PW.student)).status, 423);
  assert.equal((await signIn('srmist-ktr', 'hod.cse', PW.hod)).status, 401, 'a username is valid only in its own college');
  assert.equal((await signIn('', 'admin', PW.admin)).status, 401, 'group login is for the superadmin only');
});

test('pages: an HTML form post needs the CSRF token', { skip }, async () => {
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ college_code: 'srm-vec', username: 'cse.staff2', password: PW.staff });
  assert.equal((await agent.post('/notifications/read').type('form').send({})).status, 403);
  const page = await agent.get('/notifications');
  const token = page.text.match(/name="_csrf" value="([0-9a-f]+)"/)[1];
  assert.equal((await agent.post('/notifications/read').type('form').send({ _csrf: token })).status, 303);
  assert.equal((await request(app).get('/dashboard')).status, 302, 'signed-out users go to the login page');
  for (const asset of ['/static/css/app.css', '/static/js/app.js', '/vendor/chart.js']) assert.equal((await request(app).get(asset)).status, 200, asset);
  const hod = request.agent(app);
  await hod.post('/login').type('form').send({ college_code: 'srm-vec', username: 'hod.cse', password: PW.hod });
  const dash = await hod.get('/dashboard');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /class="register"|No classes match/);
  assert.match(dash.text, /data-chart=/);
});

test('scope: one college never sees another college\'s data', { skip }, async () => {
  const list = (await S.hod.get(`/attendance?${S.range}`)).body;
  assert.ok(list.pager.total > 20);
  S.session = list.sessions.find((s) => s.status === 'closed' && s.absent >= 3); // later tests correct one absentee and flip another
  const u = `/attendance/sessions/${S.session.timetable_id}/${S.session.session_date}`;
  assert.equal((await S.hod.get(u)).status, 200);
  assert.equal((await S.other.get(u)).status, 404);
  assert.equal((await S.other.get(`/attendance?${S.range}`)).body.pager.total, 0);
  const dept = (await db.one(`SELECT department_id FROM attendance.departments WHERE college_id = $1 LIMIT 1`, [S.vec])).department_id;
  assert.equal((await S.other.post(`/master/departments/${dept}`).send({ department_code: 'HACK', department_name: 'x' })).status, 404);
  assert.equal((await S.other.get('/users')).body.users.length, 1, 'only its own admin');
});

test('scope: an HOD sees one department, staff only their own classes', { skip }, async () => {
  const all = (await S.admin.get(`/attendance?${S.range}`)).body.pager.total;
  const cse = (await S.hod.get(`/attendance?${S.range}`)).body.pager.total;
  const mine = (await S.staff.get(`/attendance?${S.range}`)).body;
  assert.ok(all > cse && cse > mine.pager.total && mine.pager.total > 0);
  assert.ok(mine.sessions.every((s) => s.staff_code === 'CSE002'));
  const foreign = (await S.hod.get(`/attendance?${S.range}`)).body.sessions.find((s) => s.staff_code !== 'CSE002');
  assert.equal((await S.staff.get(`/attendance/sessions/${foreign.timetable_id}/${foreign.session_date}`)).status, 404);
});

test('HOD filters: class, subject, staff and period narrow the same list', { skip }, async () => {
  const s = S.session;
  const total = (await S.hod.get(`/attendance?${S.range}`)).body.pager.total;
  const sections = [...new Set((await S.hod.get(`/attendance?${S.range}&page_size=200`)).body.sessions.map((x) => x.section_id))];
  let sum = 0;
  for (const id of sections) sum += (await S.hod.get(`/attendance?${S.range}&section_id=${id}`)).body.pager.total;
  assert.equal(sum, total, 'per-class counts add up to the department');
  const one = (await S.hod.get(`/attendance?date=${s.session_date}&section_id=${s.section_id}&period_id=${s.period_id}`)).body;
  assert.equal(one.pager.total, 1);
  assert.equal(one.sessions[0].timetable_id, s.timetable_id);
  const byStaff = (await S.hod.get(`/attendance?${S.range}&staff_id=${s.staff_id}`)).body.sessions;
  assert.ok(byStaff.length > 0 && byStaff.every((x) => x.staff_id === s.staff_id));
  const bySubject = (await S.hod.get(`/attendance?${S.range}&subject_id=${s.subject_id}`)).body.sessions;
  assert.ok(bySubject.every((x) => x.subject_id === s.subject_id));
  const grid = (await S.hod.get(`/dashboard/period-grid?date=${s.session_date}`)).body;
  assert.ok(grid.rows.length >= 1 && grid.periods.length >= 3);
  assert.equal((await S.hod.get(`/attendance?from=2020-01-01&to=${today}`)).status, 422, 'ranges are capped');
});

test('permissions: only the superadmin assigns module access, and it takes effect at once', { skip }, async () => {
  const before = (await S.sup.get(`/colleges/${S.vec}/permissions`)).body.matrix;
  assert.equal((await S.staff.get('/attendance')).status, 200);
  const matrix = JSON.parse(JSON.stringify(before));
  matrix.staff.attendance = { view: false, edit: false, delete: false, export: false };
  assert.equal((await S.admin.put(`/colleges/${S.vec}/permissions`).send({ matrix })).status, 403);
  assert.equal((await S.admin.get('/permissions')).status, 200, 'an admin can view the matrix');
  assert.equal((await S.sup.put(`/colleges/${S.vec}/permissions`).send({ matrix })).body.changed, 1);
  assert.equal((await S.staff.get('/attendance')).status, 403);
  assert.equal((await S.sup.get('/attendance')).status, 200, 'superadmin access is never removed');
  // The HTML form posts perm[role][module][action]=on; export without view is dropped.
  const form = await S.sup.post(`/colleges/${S.vec}/permissions`).type('form').send('perm[student][dashboard][view]=on&perm[student][reports][export]=on');
  assert.equal(form.status, 200);
  assert.deepEqual(form.body.matrix.student.reports, { view: false, edit: false, delete: false, export: false });
  assert.equal((await S.sup.post(`/colleges/${S.vec}/permissions`).send({ reset: 1 })).status, 200);
  assert.deepEqual((await S.sup.get(`/colleges/${S.vec}/permissions`)).body.matrix, before);
  assert.equal((await S.staff.get('/attendance')).status, 200);
  const log = (await S.admin.get('/audit-logs?action=permissions_changed')).body.rows;
  assert.ok(log.length >= 1 && log[0].old_values && log[0].new_values);
});

test('correction: needs a reason, keeps old and new status, updates the percentage', { skip }, async () => {
  const s = S.session;
  const students = (await S.hod.get(`/attendance/sessions/${s.timetable_id}/${s.session_date}`)).body.students;
  const absent = students.find((x) => x.status === 'absent');
  assert.equal((await S.hod.post(`/attendance/${absent.attendance_id}`).send({ status: 'excused' })).status, 422);
  const pctBefore = (await db.one(`SELECT percentage FROM attendance.subject_summary WHERE student_id = $1 AND subject_id = $2`, [absent.student_id, s.subject_id])).percentage;
  assert.equal((await S.hod.post(`/attendance/${absent.attendance_id}`).send({ status: 'excused', reason: 'On duty: symposium' })).status, 200);
  const rec = (await S.hod.get(`/attendance/records/${absent.attendance_id}`)).body;
  assert.equal(rec.record.status, 'excused');
  assert.equal(rec.record.attendance_source, 'manual');
  assert.deepEqual([rec.corrections[0].old_status, rec.corrections[0].new_status], ['absent', 'excused']);
  assert.equal(rec.history.length, 1, 'the status-history trigger logged it');
  const pctAfter = (await db.one(`SELECT percentage FROM attendance.subject_summary WHERE student_id = $1 AND subject_id = $2`, [absent.student_id, s.subject_id])).percentage;
  assert.ok(pctAfter > pctBefore);
  assert.equal((await S.other.post(`/attendance/${absent.attendance_id}`).send({ status: 'present', reason: 'other college' })).status, 404);
});

test('manual marking: a period the camera missed is marked by hand and closed', { skip }, async () => {
  const pending = (await S.admin.get(`/attendance?${S.range}&status=needs_manual`)).body.sessions;
  assert.equal(pending.length, 1, 'the demo has one period with its camera offline');
  const u = `/attendance/sessions/${pending[0].timetable_id}/${pending[0].session_date}`;
  const roster = (await S.admin.get(u)).body.students;
  assert.ok(roster.every((x) => !x.status), 'nobody was marked absent automatically');
  const status = Object.fromEntries(roster.map((x, i) => [x.student_id, i % 6 === 0 ? 'absent' : 'present']));
  assert.equal((await S.admin.post(`${u}/manual`).send({ status })).body.changed, roster.length);
  const after = (await S.admin.get(u)).body;
  assert.equal(after.session.status, 'closed');
  assert.ok(after.students.every((x) => x.attendance_source === 'manual'));
});

test('engine: a late event flips an absent mark, twice-delivered events count once, hand marks stay', { skip }, async () => {
  const engine = require('../src/services/engine');
  const s = S.session;
  const row = (await S.hod.get(`/attendance/sessions/${s.timetable_id}/${s.session_date}`)).body.students.find((x) => x.status === 'absent' && x.attendance_source === 'ai');
  const cam = (await db.one('SELECT camera_id FROM identity.cameras WHERE classroom_id = $1', [s.classroom_id])).camera_id;
  const insert = (studentId) => db.query(
    `INSERT INTO identity.identification_events (student_id, camera_id, confidence, frame_captured_at, model_version)
     VALUES ($1, $2, 0.93, $3::timestamptz + interval '2 minutes', 'test')`, [studentId, cam, s.starts_at]);
  await insert(row.student_id);
  await insert(row.student_id);
  const r = await engine.ingestBatch(100);
  assert.deepEqual([r.events, r.marked], [2, 2]);
  const rec = await db.one('SELECT status, attendance_source FROM attendance.records WHERE attendance_id = $1', [row.attendance_id]);
  assert.deepEqual([rec.status, rec.attendance_source], ['present', 'ai']);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM attendance.records WHERE student_id = $1 AND timetable_id = $2 AND attendance_date = $3', [row.student_id, s.timetable_id, s.session_date])).n, 1);
  // The record corrected by hand in the earlier test is not touched by a new detection.
  const manual = await db.one(`SELECT student_id FROM attendance.records WHERE timetable_id = $1 AND attendance_date = $2 AND attendance_source = 'manual'`, [s.timetable_id, s.session_date]);
  await insert(manual.student_id);
  assert.deepEqual(await engine.ingestBatch(100), { events: 1, marked: 0, ignored: 1 });
  assert.equal((await db.one(`SELECT ignored_reason FROM attendance.ingested_events ORDER BY ingest_id DESC LIMIT 1`)).ignored_reason, 'manual_record');
  // A student seen in another section's room is ignored with the reason kept.
  const stranger = await db.one(`SELECT student_id FROM identity.students WHERE section_id <> $1 AND enrollment_status = 'active' AND college_id = $2 LIMIT 1`, [s.section_id, S.vec]);
  await insert(stranger.student_id);
  await engine.ingestBatch(100);
  assert.equal((await db.one(`SELECT ignored_reason FROM attendance.ingested_events ORDER BY ingest_id DESC LIMIT 1`)).ignored_reason, 'student_not_in_section');
  assert.deepEqual(await engine.closeDuePeriods(), { closed: 0, needsManual: 0 }, 'closing is idempotent');
});

test('uploads: staff and students from Excel, preview, fix, commit, first sign-in', { skip }, async () => {
  const staffFile = await workbook('staff.xlsx', [
    ['Staff Code', 'First Name', 'Last Name', 'Department', 'Designation', 'Email'],
    ['CSE050', 'Meena', 'Sundar', 'CSE', 'Assistant Professor', 'meena@example.edu'],
    ['CSE002', 'Priya', 'Raman', 'CSE', 'Professor', ''],          // existing: updated
    ['ECE050', 'Nikhil', 'Das', 'ECE', 'Assistant Professor', ''],
    ['XXX001', 'No', 'Dept', 'NOPE', '', ''],
  ]);
  let b = await upload(S.admin, 'staff', staffFile);
  assert.deepEqual([b.batch.total_rows, b.batch.error_rows], [4, 1]);
  const bad = b.rows.find((r) => r.status === 'invalid');
  assert.match(bad.errors[0], /does not exist/);
  assert.equal((await S.admin.post(`/imports/${b.batch.batch_id}/commit`).send({})).status, 422, 'errors block the commit');
  assert.equal((await S.admin.post(`/imports/${b.batch.batch_id}/rows/${bad.row_id}`).send({ raw: { department_code: 'ECE' } })).body.batch.error_rows, 0);
  const done = (await S.admin.post(`/imports/${b.batch.batch_id}/commit`).send({})).body;
  assert.deepEqual([done.inserted, done.updated], [3, 1]);
  assert.equal((await S.admin.post(`/imports/${b.batch.batch_id}/commit`).send({})).status, 422, 'a batch commits once');

  const hodFile = await workbook('hod-staff.xlsx', [['staff_code', 'first_name', 'department_code'], ['ECE060', 'Wrong', 'ECE'], ['CSE060', 'Right', 'CSE']]);
  b = await upload(S.hod, 'staff', hodFile);
  assert.equal(b.batch.error_rows, 1, 'an HOD can upload only for the own department');
  await S.hod.post(`/imports/${b.batch.batch_id}/cancel`).send({});

  const year = (await db.one(`SELECT substr(register_no, 1, 5) AS p FROM identity.students WHERE college_id = $1 LIMIT 1`, [S.vec])).p;
  const sem = (await db.one(`SELECT min(sem.semester_no) AS n FROM attendance.sections sec JOIN attendance.semesters sem ON sem.semester_id = sec.semester_id JOIN attendance.departments d ON d.department_id = sec.department_id WHERE d.college_id = $1`, [S.vec])).n;
  const studentFile = await workbook('students.xlsx', [
    ['university_id', 'register_no', 'full_name', 'department_code', 'program_code', 'semester_no', 'section', 'roll_no', 'gender', 'dob', 'email'],
    ['NEW0001', 'NEW0001', 'Tara Venkat', 'CSE', 'BTECH', sem, 'A', '25', 'F', '18-04-2007', 'tara@example.edu'],
    ['NEW0002', 'NEW0002', 'Uday Shankar', 'CSE', 'BTECH', sem, 'B', '25', 'M', new Date('2007-05-09T00:00:00Z'), ''],
    [`${year}CSE${sem}A001`, `${year}CSE${sem}A001`, 'Renamed Student', 'CSE', 'BTECH', sem, 'A', '01', '', '', ''],
  ]);
  b = await upload(S.admin, 'students', studentFile);
  assert.equal(b.batch.error_rows, 0, JSON.stringify(b.rows.map((r) => r.errors)));
  assert.deepEqual((({ inserted, updated }) => [inserted, updated])((await S.admin.post(`/imports/${b.batch.batch_id}/commit`).send({})).body), [2, 1]);
  const st = await db.one(`SELECT dob, gender, college_id, section_id FROM identity.students WHERE university_id = 'NEW0002'`);
  assert.deepEqual([st.dob, st.gender, st.college_id], ['2007-05-09', 'male', S.vec]);

  // The new student signs in with the register number and must change the password first.
  const fresh = await signIn('srm-vec', 'new0001', 'new0001');
  assert.equal(fresh.body.must_change_password, true);
  assert.equal((await fresh.get('/dashboard/summary')).status, 403);
  assert.equal((await fresh.post('/auth/password').send({ current_password: 'new0001', new_password: 'short', confirm_password: 'short' })).status, 422);
  assert.equal((await fresh.post('/auth/password').send({ current_password: 'new0001', new_password: 'Better#2026', confirm_password: 'Better#2026' })).status, 200);
  // The password is changed; the next gate is face enrolment.
  const gated = await fresh.get('/dashboard/summary');
  assert.deepEqual([gated.status, gated.body.code], [403, 'face_enrolment_required']);
  assert.equal((await fresh.get('/auth/me')).body.user.mustEnrolFace, true);
  assert.equal((await fresh.agent.get('/dashboard')).headers.location, '/enroll', 'the browser is sent to the enrolment page');
  S.fresh = fresh;
  assert.equal((await fresh.get('/users')).status, 403);
});

test('uploads: a timetable grid replaces a section\'s week from a date, and clashes are blocked', { skip }, async () => {
  const sec = (await db.one(
    `SELECT sec.section_id, sem.semester_no FROM attendance.sections sec JOIN attendance.semesters sem ON sem.semester_id = sec.semester_id
       JOIN attendance.departments d ON d.department_id = sec.department_id WHERE d.college_id = $1 AND d.department_code = 'ECE' LIMIT 1`, [S.vec]));
  // A CSE class on Tuesday period 1: its staff member and room cannot also take ECE then.
  const busy = await db.one(
    `SELECT st.staff_code, c.room_number FROM attendance.timetable t JOIN attendance.staff st ON st.staff_id = t.staff_id
       JOIN attendance.classrooms c ON c.classroom_id = t.classroom_id JOIN attendance.periods p ON p.period_id = t.period_id
       JOIN attendance.sections sec ON sec.section_id = t.section_id JOIN attendance.departments d ON d.department_id = sec.department_id
      WHERE d.college_id = $1 AND d.department_code = 'CSE' AND t.day_of_week = 2 AND p.period_no = 1 AND t.is_active LIMIT 1`, [S.vec]);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Grid');
  [['department_code', 'ECE'], ['program_code', 'BTECH'], ['semester_no', sec.semester_no], ['section', 'A'], [],
    ['Day', 'P1', 'P2', 'P6'],
    ['Monday', 'EC301 / ECE002 / LH-202', 'EC302 / ECE003 / LH-202', 'EC303 / ECE004 / LH-202'],
    ['Tuesday', `EC301 / ${busy.staff_code} / ${busy.room_number}`, '', '']].forEach((r) => ws.addRow(r)); // that staff member and room are busy then
  const file = path.join(process.env.STORAGE_DIR, 'grid.xlsx');
  await wb.xlsx.writeFile(file);
  const from = addDays(today, 3);
  let b = await upload(S.admin, 'timetable', file, { effective_from: from });
  assert.deepEqual([b.batch.layout, b.batch.total_rows, b.batch.error_rows], ['grid', 4, 1]);
  const clash = b.rows.find((r) => r.status === 'invalid');
  assert.ok(clash.errors.some((e) => /already teaches/.test(e)) && clash.errors.some((e) => /already used/.test(e)));
  await S.admin.post(`/imports/${b.batch.batch_id}/rows/${clash.row_id}/delete`).send({});
  const oldCount = (await db.one('SELECT count(*)::int AS n FROM attendance.timetable WHERE section_id = $1 AND is_active', [sec.section_id])).n;
  const done = (await S.admin.post(`/imports/${b.batch.batch_id}/commit`).send({})).body;
  assert.deepEqual([done.inserted, done.updated], [3, oldCount]);
  const rows = await db.many('SELECT is_active, effective_from, effective_to FROM attendance.timetable WHERE section_id = $1', [sec.section_id]);
  assert.equal(rows.filter((r) => r.is_active).length, 3);
  assert.ok(rows.filter((r) => !r.is_active).every((r) => r.effective_to === addDays(from, -1)), 'old slots end the day before');
  // Yesterday still resolves to the old timetable; next week to the new one.
  const past = (await S.admin.get(`/attendance?${S.range}&section_id=${sec.section_id}`)).body.pager.total;
  assert.ok(past > 10, 'past attendance is kept');
});

test('timetable: editing a slot checks clashes; a substitution shows the substitute for that date', { skip }, async () => {
  const slots = await db.many(
    `SELECT t.*, st.staff_code FROM attendance.timetable t JOIN attendance.staff st ON st.staff_id = t.staff_id
       JOIN attendance.sections sec ON sec.section_id = t.section_id JOIN attendance.departments d ON d.department_id = sec.department_id
      WHERE d.department_code = 'CSE' AND d.college_id = $1 AND t.is_active ORDER BY t.section_id, t.day_of_week, t.period_id`, [S.vec]);
  const a = slots[0];
  const busy = slots.find((x) => x.section_id !== a.section_id && x.day_of_week === a.day_of_week && x.period_id === a.period_id);
  const clash = await S.hod.post('/timetable/slots').send({ section_id: a.section_id, day_of_week: a.day_of_week, period_id: a.period_id, subject_id: a.subject_id, staff_id: busy.staff_id, classroom_id: a.classroom_id });
  assert.equal(clash.status, 409);
  assert.match(clash.body.message, /already teaches/);
  const free = await db.one(`SELECT staff_id FROM attendance.staff WHERE staff_code = 'CSE050'`);
  const ok = await S.hod.post('/timetable/slots').send({ timetable_id: a.timetable_id, section_id: a.section_id, day_of_week: a.day_of_week, period_id: a.period_id, subject_id: a.subject_id, staff_id: free.staff_id, classroom_id: a.classroom_id });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await db.one('SELECT is_active, effective_to FROM attendance.timetable WHERE timetable_id = $1', [a.timetable_id])).is_active, false);

  // Substitution: cse.staff1 asks for one of their classes next week; the HOD approves.
  const mine = slots.find((x) => x.staff_code === 'CSE002' && x.timetable_id !== a.timetable_id);
  let date = addDays(today, 1);
  while (require('../src/utils/dates').isoDow(date) !== mine.day_of_week) date = addDays(date, 1);
  const holiday = await db.one('SELECT 1 FROM attendance.holidays WHERE holiday_date = $1', [date]);
  if (holiday) date = addDays(date, 7);
  const reqd = await S.staff.post('/class-swaps').send({ timetable_id: mine.timetable_id, swap_date: date, replacement_staff_id: free.staff_id, reason: 'Conference' });
  assert.equal(reqd.status, 200, JSON.stringify(reqd.body));
  assert.equal((await S.staff.post(`/class-swaps/${reqd.body.swap.swap_id}/decision`).send({ decision: 'approve' })).status, 403);
  assert.equal((await S.hod.post(`/class-swaps/${reqd.body.swap.swap_id}/decision`).send({ decision: 'approve' })).status, 200);
  const day = await db.many('SELECT staff_id, scheduled_staff_id FROM attendance.sessions_between($1::date, $1::date, $2) WHERE timetable_id = $3', [date, S.vec, mine.timetable_id]);
  assert.deepEqual([day[0].staff_id, day[0].scheduled_staff_id], [free.staff_id, mine.staff_id]);
});

test('calendar: a new holiday removes that day\'s classes', { skip }, async () => {
  let date = addDays(today, 8);
  while (require('../src/utils/dates').isoDow(date) === 7) date = addDays(date, 1);
  const before = (await db.one('SELECT count(*)::int AS n FROM attendance.sessions_between($1::date, $1::date, $2)', [date, S.vec])).n;
  assert.ok(before > 0);
  const ay = (await db.one('SELECT academic_year_id FROM attendance.academic_years WHERE college_id = $1', [S.vec])).academic_year_id;
  const r = await S.admin.post('/master/holidays').send({ academic_year_id: ay, holiday_name: 'Founder\'s day', holiday_date: date, holiday_type: 'college' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await db.one('SELECT count(*)::int AS n FROM attendance.sessions_between($1::date, $1::date, $2)', [date, S.vec])).n, 0);
  assert.equal((await S.hod.post('/master/holidays').send({ academic_year_id: ay, holiday_name: 'x', holiday_date: date })).status, 403, 'academic setup is read-only for an HOD');
  assert.equal((await S.admin.post('/master/holidays').send({ academic_year_id: 999999, holiday_name: 'x', holiday_date: date })).status, 422);
});

test('users: create, one-time password, deactivate', { skip }, async () => {
  const dept = (await db.one(`SELECT department_id FROM attendance.departments WHERE college_id = $1 AND department_code = 'CSE'`, [S.vec])).department_id;
  const made = await S.admin.post('/users').send({ role: 'staff', username: 'temp.staff', first_name: 'Temp', department_id: dept, staff_code: 'TMP1' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal((await S.hod.post('/users').send({ role: 'hod', username: 'second.hod', first_name: 'X', department_id: dept, staff_code: 'TMP2' })).status, 403);
  assert.equal((await S.admin.post('/users').send({ role: 'admin', username: 'second.admin', first_name: 'X' })).status, 403);
  const first = await signIn('srm-vec', 'temp.staff', made.body.temporary_password);
  assert.equal(first.body.must_change_password, true);
  assert.equal((await S.admin.post(`/users/${made.body.user_id}/status`).send({ status: 'inactive' })).status, 200);
  assert.equal((await signIn('srm-vec', 'temp.staff', made.body.temporary_password)).status, 401);
  assert.equal((await first.get('/auth/me')).status, 401, 'open sessions end when a user is deactivated');
});

test('exports and settings', { skip }, async () => {
  const xlsx = await S.hod.get(`/attendance/export?format=xlsx&${S.range}`);
  assert.equal(xlsx.status, 200);
  assert.match(xlsx.headers['content-type'], /spreadsheetml/);
  const pdf = await S.hod.get(`/attendance/sessions/${S.session.timetable_id}/${S.session.session_date}/export?format=pdf`);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal((await S.hod.get('/reports/defaulters/export?format=xlsx')).status, 200);
  const student = await signIn('srm-vec', (await db.one(`SELECT u.username FROM attendance.users u JOIN identity.students s ON s.user_id = u.user_id WHERE u.college_id = $1 AND u.username LIKE 'vec%' ORDER BY u.username LIMIT 1`, [S.vec])).username, PW.student);
  assert.equal((await student.get('/attendance/export?format=xlsx')).status, 403, 'students have no export permission');
  assert.ok((await db.one('SELECT count(*)::int AS n FROM attendance.report_exports')).n >= 3);

  assert.equal((await S.admin.post('/settings').send({ defaulter_threshold_pct: 150 })).status, 422);
  assert.equal((await S.admin.post('/settings').send({ defaulter_threshold_pct: 80, late_after_minutes: 15 })).status, 200);
  assert.equal((await db.one(`SELECT attendance.setting($1, 'defaulter_threshold_pct', '75') AS v`, [S.vec])).v, '80');
  assert.equal((await db.one(`SELECT attendance.setting(NULL, 'defaulter_threshold_pct', '75') AS v`)).v, '75', 'other colleges keep the group default');
  assert.equal((await S.hod.post('/settings').send({ late_after_minutes: 1 })).status, 403);
});

/** A class timetable sheet as a PDF, laid out like the ones departments publish. */
function classSheetPdf(file, { semester, yearStart, legend, grid, programme = 'BTECH', hall = 'LH-201', section = 'C' }) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 30 });
    const out = fs.createWriteStream(file);
    out.on('finish', resolve);
    doc.pipe(out);
    doc.fontSize(8);
    const at = (text, x, y) => doc.text(String(text), x, y, { lineBreak: false });
    const centre = (text, cx, y) => at(text, cx - doc.widthOfString(String(text)) / 2, y);
    at('DEPARTMENT OF COMPUTER SCIENCE AND ENGINEERING', 180, 40);
    at(`Academic Year : ${yearStart}-${yearStart + 1} (ODD Semester)`, 220, 52);
    at('PROGRAMME', 60, 70); at(':', 115, 70); at(programme, 120, 70); at(`Hall No : ${hall}`, 320, 70);
    at('SEMESTER', 60, 82); at(`: ${semester} - CSE ${section}`, 115, 82); at('CLASS ADVISOR:', 320, 82); at('Ms. Priya Raman / A.P', 390, 82);
    const cols = [150, 200, 250, 300, 400, 450]; // a wider gap after hour 4: the lunch break
    at('HOUR', 100, 100);
    cols.forEach((cx, i) => { centre(i + 1, cx, 100); centre(`${8 + i}.00am-`, cx, 110); centre(`${8 + i}.50am`, cx, 119); });
    at('DAY', 60, 119);
    grid.forEach(([day, cells], r) => {
      const y = 140 + r * 22;
      at(day, 60, y);
      // [text, hour] puts the text in one hour; [text, hour, hour + 1] centres it across two, as a merged cell does.
      cells.forEach(([text, h1, h2]) => centre(text, h2 ? (cols[h1 - 1] + cols[h2 - 1]) / 2 : cols[h1 - 1], y));
    });
    const top = 150 + grid.length * 22;
    at('S.', 62, top - 4); at('No', 62, top + 5); at('Subject', 82, top - 4); at('Code', 86, top + 5);
    centre('Subject Name', 190, top); at('L', 322, top); at('T', 338, top); at('P', 353, top); centre('Staff Incharge', 440, top); at('Dept', 538, top);
    legend.forEach(([code, name, short, l, t, p, staff], i) => {
      const y = top + 26 + i * 24;
      at(i + 1, 64, y); if (code) at(code, 82, y);
      name.forEach((line, k) => at(line, 124, y - (name.length - 1) * 5 + k * 10));
      centre(short, 297, y); at(l, 322, y); at(t, 338, y); at(p, 353, y);
      staff.forEach((line, k) => at(line, 364, y - (staff.length - 1) * 5 + k * 10));
      at('CSE', 538, y);
    });
    doc.end();
  });
}

test('class timetable sheet (PDF): allocation and timetable from one file, parallel classes, electives', { skip }, async () => {
  const dates = require('../src/utils/dates');
  const engine = require('../src/services/engine');
  const model = require('../src/models/attendance');
  const info = await db.one(
    `SELECT min(sem.semester_no) AS sem, EXTRACT(YEAR FROM min(ay.start_date))::int AS year
       FROM attendance.sections sec JOIN attendance.semesters sem ON sem.semester_id = sec.semester_id
       JOIN attendance.academic_years ay ON ay.academic_year_id = sec.academic_year_id
       JOIN attendance.departments d ON d.department_id = sec.department_id WHERE d.college_id = $1`, [S.vec]);
  // A new class, CSE section C, with four students.
  let b = await upload(S.admin, 'sections', await workbook('sec-c.xlsx', [['department_code', 'program_code', 'semester_no', 'section'], ['CSE', 'BTECH', info.sem, 'C']]));
  await S.admin.post(`/imports/${b.batch.batch_id}/commit`).send({});
  b = await upload(S.admin, 'students', await workbook('stu-c.xlsx', [['university_id', 'register_no', 'full_name', 'department_code', 'program_code', 'semester_no', 'section'],
    ...[1, 2, 3, 4].map((i) => [`SECC${i}`, `SECC${i}`, `Class C Student ${i}`, 'CSE', 'B.TECH', info.sem, 'C'])]));
  assert.equal(b.batch.error_rows, 0, 'program codes match with or without dots');
  await S.admin.post(`/imports/${b.batch.batch_id}/commit`).send({});
  await db.query(`UPDATE identity.students SET face_registered = true WHERE university_id LIKE 'SECC%'`);
  const stu = Object.fromEntries((await db.many(`SELECT university_id, student_id FROM identity.students WHERE university_id LIKE 'SECC%'`)).map((r) => [r.university_id, r.student_id]));

  // The sheet: period 6 on weekdays and Saturday afternoon are free for every room and staff member in the demo.
  const file = path.join(process.env.STORAGE_DIR, 'class-c.pdf');
  await classSheetPdf(file, {
    semester: info.sem, yearStart: info.year,
    grid: [['Monday', [['E1/E2', 6]]], ['Tuesday', [['DS', 6]]], ['Saturday', [['DS', 4], ['L1 / L2', 5, 6]]]],
    legend: [
      [(await db.one(`SELECT subject_code FROM attendance.subjects WHERE college_id = $1 AND department_id = (SELECT department_id FROM attendance.departments WHERE college_id = $1 AND department_code = 'CSE') ORDER BY subject_code LIMIT 1`, [S.vec])).subject_code, ['Data Structures'], 'DS', 4, 0, 0, ['Ms. Priya Raman / A.P - O.G.']],
      ['EL701', ['(Professional Elective - I)', 'Elective One'], 'E1', 3, 0, 0, ['Mr.Suresh Babu / A.P']],
      ['EL702', ['(Professional Elective - I)', 'Elective Two'], 'E2', 3, 0, 0, ['Ms. A. Menon / A.P (Hall No.LH-102)']],   // an initial instead of the first name
      ['LB701', ['Lab One'], 'L1', 0, 0, 4, ['Mr. Vignesh Iyer / A.P (Hall No.LH-101)']],
      ['', ['Lab Two'], 'L2', 0, 0, 4, ['New Staff 9']],
    ],
  });
  const up = await S.admin.post('/imports').field('import_type', 'timetable').attach('file', file);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.import_type, 'allocation', 'the subject and staff table comes first');
  const allocId = up.body.batch_id, ttId = up.body.linked_batch_id;

  const alloc = (await S.admin.get(`/imports/${allocId}`)).body;
  assert.deepEqual([alloc.batch.layout, alloc.batch.total_rows, alloc.batch.error_rows], ['class_sheet', 5, 2]);
  const row = (short) => alloc.rows.find((r) => r.raw.short_name === short);
  assert.deepEqual([row('E1').raw.subject_name, row('E1').raw.category, row('E2').raw.room_number], ['Elective One', 'Professional Elective - I', 'LH-102']);
  assert.match(row('E2').errors[0], /not in the staff master/, 'an initial alone does not identify Anitha Menon');
  assert.match(row('L2').errors[0], /New Staff 9/);
  assert.equal(row('L2').raw.subject_code, 'L2', 'no code on the sheet: the short name stands in');
  assert.equal((await S.admin.get(`/imports/${ttId}`)).body.batch.error_rows, 6, 'rows for the new subjects wait for the allocation');
  const staff = Object.fromEntries((await db.many(`SELECT staff_code, staff_id FROM attendance.staff WHERE college_id = $1`, [S.vec])).map((r) => [r.staff_code, r.staff_id]));
  await S.admin.post(`/imports/${allocId}/rows/${row('E2').row_id}`).send({ raw: { staff_code: 'CSE004' } });
  assert.equal((await S.admin.post(`/imports/${allocId}/rows/${row('L2').row_id}`).send({ raw: { staff_code: 'CSE006', room_number: 'LH-102' } })).body.batch.error_rows, 0);
  const done = await S.admin.post(`/imports/${allocId}/commit`).send({});
  assert.deepEqual([done.body.inserted, done.body.next_batch_id], [5, ttId]);
  const e1 = await db.one(`SELECT s.subject_id, s.short_name, s.is_lab, c.category_name FROM attendance.subjects s LEFT JOIN attendance.subject_categories c ON c.category_id = s.category_id WHERE s.subject_code = 'EL701'`);
  assert.deepEqual([e1.short_name, e1.is_lab, e1.category_name], ['E1', false, 'Professional Elective - I']);
  assert.equal((await db.one(`SELECT is_lab FROM attendance.subjects WHERE subject_code = 'LB701'`)).is_lab, true);
  assert.equal((await S.hod.get('/master/allocations?q=EL70')).body.rows.length, 2, 'the allocation is listed under Master data');

  // Step 2: the grid. Staff and rooms now come from the committed allocation.
  const tt = (await S.admin.get(`/imports/${ttId}`)).body;
  assert.deepEqual([tt.batch.total_rows, tt.batch.error_rows], [8, 0], JSON.stringify(tt.rows.map((r) => r.errors)));
  assert.equal((await S.admin.post(`/imports/${ttId}/commit`).send({})).body.inserted, 8);
  const slots = await db.many(
    `SELECT t.timetable_id, t.day_of_week AS d, p.period_no AS p, sub.short_name AS s, st.staff_code AS f, c.room_number AS r, t.section_id
       FROM attendance.timetable t JOIN attendance.periods p ON p.period_id = t.period_id JOIN attendance.subjects sub ON sub.subject_id = t.subject_id
       JOIN attendance.staff st ON st.staff_id = t.staff_id JOIN attendance.classrooms c ON c.classroom_id = t.classroom_id
       JOIN attendance.sections sec ON sec.section_id = t.section_id WHERE sec.section_name = 'C' AND t.is_active ORDER BY 2, 3, 4`);
  assert.deepEqual(slots.map((x) => `${x.d}.${x.p} ${x.s} ${x.f} ${x.r}`), [
    '1.6 E1 CSE003 LH-201', '1.6 E2 CSE004 LH-102', '2.6 DS CSE002 LH-201', '6.4 DS CSE002 LH-201',
    '6.5 L1 CSE005 LH-101', '6.5 L2 CSE006 LH-102', '6.6 L1 CSE005 LH-101', '6.6 L2 CSE006 LH-102',
  ], 'split cells give parallel classes; the merged cell covers both hours');

  // Attendance for the elective period: two halls, one period.
  const [slotE1, slotE2] = slots;
  await db.query(`UPDATE attendance.timetable SET effective_from = (SELECT start_date FROM attendance.semesters WHERE semester_id = attendance.timetable.semester_id) WHERE section_id = $1`, [slotE1.section_id]);
  await S.admin.post('/settings').send({ close_catchup_days: 14 });
  const day = (await db.one(`SELECT max(session_date) AS d FROM attendance.sessions_between($1::date, $2::date, $3) WHERE timetable_id = $4`, [dates.addDays(today, -13), dates.addDays(today, -1), S.vec, slotE1.timetable_id])).d;
  const seen = (uni, room) => db.query(
    `INSERT INTO identity.identification_events (student_id, camera_id, confidence, frame_captured_at, model_version)
     SELECT $1, cam.camera_id, 0.9, (($3::date + p.start_time) AT TIME ZONE 'Asia/Kolkata') + interval '3 minutes', 'test'
       FROM identity.cameras cam JOIN attendance.classrooms c ON c.classroom_id = cam.classroom_id, attendance.periods p
      WHERE c.room_number = $2 AND c.college_id = $4 AND p.college_id = $4 AND p.period_no = 6`, [stu[uni], room, day, S.vec]);
  await seen('SECC1', 'LH-201');
  await seen('SECC2', 'LH-102');
  while ((await engine.ingestBatch(200)).events) { /* drain */ }
  await engine.closeDuePeriods();
  const marks = await db.many(
    `SELECT x.university_id AS u, r.timetable_id AS t, r.status FROM attendance.records r JOIN identity.students x ON x.student_id = r.student_id
      WHERE r.attendance_date = $1 AND r.timetable_id = ANY($2) ORDER BY 1`, [day, [slotE1.timetable_id, slotE2.timetable_id]]);
  assert.deepEqual(marks.map((m) => `${m.u} ${m.t === slotE1.timetable_id ? 'E1' : 'E2'} ${m.status}`),
    ['SECC1 E1 present', 'SECC2 E2 present', 'SECC3 E1 absent', 'SECC4 E1 absent'], 'present where seen; absent once, not in both classes');

  // Elective choices put the absentee on the right roll.
  b = await upload(S.admin, 'electives', await workbook('electives.xlsx', [['register_no', 'subject_code'], ['SECC1', 'EL701'], ['SECC2', 'E2'], ['SECC3', 'E2'], ['SECC4', 'EL701']]));
  assert.equal(b.batch.error_rows, 0, JSON.stringify(b.rows.map((r) => r.errors)));
  assert.equal((await S.admin.post(`/imports/${b.batch.batch_id}/commit`).send({})).body.inserted, 4);
  const sE2 = await model.session({ role: 'admin', collegeId: S.vec }, slotE2.timetable_id, day);
  assert.deepEqual((await model.sessionStudents(sE2)).map((x) => x.register_no), ['SECC2', 'SECC3'], 'the roll of an elective is the students who chose it');
  await db.query('DELETE FROM attendance.class_sessions WHERE timetable_id = ANY($1)', [[slotE1.timetable_id, slotE2.timetable_id]]);
  await db.query(`DELETE FROM attendance.records WHERE timetable_id = ANY($1) AND status = 'absent'`, [[slotE1.timetable_id, slotE2.timetable_id]]);
  await engine.closeDuePeriods();
  const again = await db.many(`SELECT x.university_id AS u, r.timetable_id AS t FROM attendance.records r JOIN identity.students x ON x.student_id = r.student_id WHERE r.attendance_date = $1 AND r.timetable_id = ANY($2) AND r.status = 'absent' ORDER BY 1`, [day, [slotE1.timetable_id, slotE2.timetable_id]]);
  assert.ok(again.some((m) => m.u === 'SECC3' && m.t === slotE2.timetable_id) && again.some((m) => m.u === 'SECC4' && m.t === slotE1.timetable_id));

  // The allocation can also be uploaded on its own, in Excel: it replaces the class's allocation.
  b = await upload(S.admin, 'allocation', await workbook('alloc.xlsx', [
    ['department_code', 'program_code', 'semester_no', 'section', 'subject_code', 'short_name', 'staff_code', 'room_number'],
    ['CSE', 'BTECH', info.sem, 'C', 'EL701', 'E1', 'CSE007', ''], ['CSE', 'BTECH', info.sem, 'C', 'EL702', 'E2', 'CSE004', 'LH-102']]));
  assert.equal(b.batch.error_rows, 0, JSON.stringify(b.rows.map((r) => r.errors)));
  const rep = (await S.admin.post(`/imports/${b.batch.batch_id}/commit`).send({})).body;
  assert.deepEqual([rep.inserted, rep.updated], [2, 5]);
  assert.equal((await db.one(`SELECT staff_id FROM attendance.staff_subjects WHERE section_id = $1 AND subject_id = $2`, [slotE1.section_id, e1.subject_id])).staff_id, staff.CSE007);

  // A sheet for another academic year is refused outright.
  const old = path.join(process.env.STORAGE_DIR, 'old-year.pdf');
  await classSheetPdf(old, { semester: info.sem, yearStart: info.year - 3, grid: [['Monday', [['DS', 6]]]], legend: [['CS999', ['Old'], 'DS', 1, 0, 0, ['Ms. Priya Raman']]] });
  const refused = await S.admin.post('/imports').field('import_type', 'timetable').attach('file', old);
  assert.equal(refused.status, 422);
  assert.match(refused.body.message, /academic year/);
});

test('class timetable sheet: one step sets up the programme, class, hall and staff the sheet names', { skip }, async () => {
  const info = await db.one(
    `SELECT min(sem.semester_no) AS sem, EXTRACT(YEAR FROM min(ay.start_date))::int AS year
       FROM attendance.sections sec JOIN attendance.semesters sem ON sem.semester_id = sec.semester_id
       JOIN attendance.academic_years ay ON ay.academic_year_id = sec.academic_year_id
       JOIN attendance.departments d ON d.department_id = sec.department_id WHERE d.college_id = $1`, [S.vec]);
  const file = path.join(process.env.STORAGE_DIR, 'class-z.pdf');
  await classSheetPdf(file, {
    semester: info.sem, yearStart: info.year, programme: 'B.E.', hall: 'H-900', section: 'Z',
    grid: [['Monday', [['NS', 6]]]], legend: [['NS901', ['New Subject'], 'NS', 3, 0, 0, ['Dr. Q. Newperson / Professor']]],
  });
  const up = await S.admin.post('/imports').field('import_type', 'timetable').attach('file', file);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const id = up.body.batch_id, tt = up.body.linked_batch_id;
  const before = (await S.admin.get(`/imports/${id}`)).body;
  assert.equal(before.batch.error_rows, 1);
  assert.ok(before.rows[0].errors.includes('Program "BE" does not exist'));
  assert.ok(before.rows[0].errors.some((e) => /not in the staff master/.test(e)));
  assert.equal(before.missingCount, 4, 'programme, class, hall and one staff member');

  assert.notEqual((await S.hod.get(`/imports/${id}/setup`)).status, 200, 'setting up master data is for the college admin');
  const plan = (await S.admin.get(`/imports/${id}/setup`)).body;
  assert.deepEqual([plan.programs.map((x) => x.code), plan.rooms.map((x) => x.room_number), plan.sections.length, plan.periods.length], [['BE'], ['H-900'], 1, 0]);
  assert.deepEqual([plan.staff[0].name, plan.staff[0].department_code, plan.staff[0].designation], ['Q. Newperson', 'CSE', 'Professor']);
  assert.match(plan.staff[0].suggested_code, /^CSE\d{3}$/);

  const form = (code) => ({ program_name: { BE: 'Bachelor of Engineering' }, program_years: { BE: 4 }, create_sections: 'on', create_rooms: 'on', staff: { 0: { create: 'on', code, designation: 'Professor' } } });
  assert.equal((await S.admin.post(`/imports/${id}/setup`).send(form('CSE002'))).status, 422, 'a staff code already in use is refused, and nothing is written');
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM attendance.programs WHERE college_id = $1 AND program_code = 'BE'`, [S.vec])).n, 0);
  const done = await S.admin.post(`/imports/${id}/setup`).send(form('CSE900'));
  assert.deepEqual(done.body.made, { departments: 0, programs: 1, sections: 1, rooms: 1, periods: 0, staff: 1 });

  const after = (await S.admin.get(`/imports/${id}`)).body;
  assert.deepEqual([after.batch.error_rows, after.missingCount], [0, 0], JSON.stringify(after.rows.map((r) => r.errors)));
  assert.equal((await S.admin.post(`/imports/${id}/commit`).send({})).body.inserted, 1);
  assert.equal((await S.admin.get(`/imports/${tt}`)).body.batch.error_rows, 0);
  assert.equal((await S.admin.post(`/imports/${tt}/commit`).send({})).body.inserted, 1);
  const slot = await db.one(
    `SELECT st.staff_code, c.room_number, pr.program_code, sec.section_name FROM attendance.timetable t
       JOIN attendance.staff st ON st.staff_id = t.staff_id JOIN attendance.classrooms c ON c.classroom_id = t.classroom_id
       JOIN attendance.sections sec ON sec.section_id = t.section_id JOIN attendance.programs pr ON pr.program_id = sec.program_id
       JOIN attendance.subjects sub ON sub.subject_id = t.subject_id WHERE sub.subject_code = 'NS901'`);
  assert.deepEqual(slot, { staff_code: 'CSE900', room_number: 'H-900', program_code: 'BE', section_name: 'Z' });
  const fresh = await signIn('srm-vec', 'cse900', 'cse900');
  assert.equal(fresh.body.must_change_password, true, 'the new staff member signs in with the staff code and must change the password');
});

test('staff and student lists as the office prints them: PDF and Excel, class or department in the heading', { skip }, async () => {
  const PDFDocument = require('pdfkit');
  const sem = (await db.one(
    `SELECT min(sem.semester_no) AS n FROM attendance.sections sec JOIN attendance.semesters sem ON sem.semester_id = sec.semester_id
       JOIN attendance.departments d ON d.department_id = sec.department_id WHERE d.college_id = $1`, [S.vec])).n;
  // A nominal roll PDF: the class is in the heading, the columns are named the way colleges name them.
  const roll = path.join(process.env.STORAGE_DIR, 'nominal-roll.pdf');
  await new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 30 });
    const out = fs.createWriteStream(roll);
    out.on('finish', resolve);
    doc.pipe(out);
    doc.fontSize(9);
    const at = (t, x, y) => doc.text(String(t), x, y, { lineBreak: false });
    at('DEPARTMENT OF COMPUTER SCIENCE AND ENGINEERING', 150, 40);
    at('PROGRAMME', 40, 60); at(':', 100, 60); at('BTECH', 106, 60);
    at('SEMESTER', 40, 74); at(`: ${sem} - CSE A`, 100, 74);
    const xs = [40, 80, 190, 330, 450];
    [['S.No', 'Register Number', 'Name of the Student', "Father's Name", 'Parent Mobile'],
      [1, 'ROLL9001', 'Keerthana V', 'Venkat R', '9000090011'],
      [2, 'ROLL9002', 'Mohammed Irfan', 'Abdul K', '9000090022'],
      [3, 'ROLL9003', 'Sanjay Kumar P', '', '']].forEach((r, i) => r.forEach((c, k) => at(c, xs[k], 100 + i * 18)));
    doc.end();
  });
  let b = await upload(S.hod, 'students', roll);
  assert.deepEqual([b.batch.file_type, b.batch.total_rows, b.batch.error_rows], ['pdf', 3, 0], JSON.stringify(b.rows.map((r) => r.errors)));
  assert.deepEqual([b.rows[0].raw.department_code, b.rows[0].raw.program_code, b.rows[0].raw.semester_no, b.rows[0].raw.section], ['CSE', 'BTECH', String(sem), 'A'], 'the heading fills every row');
  assert.equal((await S.hod.post(`/imports/${b.batch.batch_id}/commit`).send({})).body.inserted, 3);
  const st = await db.one(
    `SELECT s.university_id, s.full_name, sec.section_name, p.father_name, p.father_mobile FROM identity.students s
       JOIN attendance.sections sec ON sec.section_id = s.section_id LEFT JOIN attendance.student_parents p ON p.student_id = s.student_id
      WHERE s.register_no = 'ROLL9001'`);
  assert.deepEqual(st, { university_id: 'ROLL9001', full_name: 'Keerthana V', section_name: 'A', father_name: 'Venkat R', father_mobile: '9000090011' });
  assert.equal((await db.one(`SELECT count(*)::int AS n FROM attendance.student_parents p JOIN identity.students s ON s.student_id = p.student_id WHERE s.register_no = 'ROLL9003'`)).n, 0, 'no parent row when the list gives none');
  assert.equal((await signIn('srm-vec', 'roll9002', 'roll9002')).body.must_change_password, true);

  // A staff list in Excel, headed by its department's full name.
  const list = await workbook('staff-list.xlsx', [
    ['SRM VEC'], ['DEPARTMENT OF ELECTRONICS AND COMMUNICATION ENGINEERING'], [],
    ['S.No', 'Employee ID', 'Name of the Faculty', 'Designation', 'Mobile Number', 'E-Mail'],
    [1, 'ECE070', 'Dr. K. Meenakshi', 'Professor', '9000000070', 'meenakshi@example.edu'],
    [2, 'ECE071', 'Mr. T. Vasanth', 'Assistant Professor', '', ''],
  ]);
  b = await upload(S.admin, 'staff', list);
  assert.deepEqual([b.batch.total_rows, b.batch.error_rows], [2, 0], JSON.stringify(b.rows.map((r) => r.errors)));
  assert.equal((await S.admin.post(`/imports/${b.batch.batch_id}/commit`).send({})).body.inserted, 2);
  const sf = await db.one(
    `SELECT d.department_code, st.designation, u.first_name, u.mobile, u.email FROM attendance.staff st
       JOIN attendance.departments d ON d.department_id = st.department_id JOIN attendance.users u ON u.user_id = st.user_id WHERE st.staff_code = 'ECE070'`);
  assert.deepEqual(sf, { department_code: 'ECE', designation: 'Professor', first_name: 'Dr. K. Meenakshi', mobile: '9000000070', email: 'meenakshi@example.edu' });

  // The details pages.
  const students = (await S.hod.get('/master/students?q=ROLL900')).body;
  assert.equal(students.rows.length, 3);
  assert.ok(students.headers.includes('Parent') && students.rows.some((r) => Object.values(r).includes('Venkat R, 9000090011')));
  assert.equal((await S.hod.get('/master/staff-list?q=ECE07')).body.rows.length, 0, 'an HOD sees the staff of the own department only');
  assert.equal((await S.admin.get('/master/staff-list?q=ECE07')).body.rows.length, 2);
  assert.equal((await S.staff.get('/master/students')).status, 403);
  const id = students.rows[0].id;
  const current = (await db.one('SELECT full_name, register_no, section_id FROM identity.students WHERE student_id = $1', [id]));
  const edit = await S.hod.post(`/master/students/${id}`).send({ ...current, enrollment_status: 'opted_out' });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal((await db.one('SELECT enrollment_status FROM identity.students WHERE student_id = $1', [id])).enrollment_status, 'opted_out');
  assert.equal((await S.admin.post('/master/students').send({ full_name: 'X', register_no: 'X1', section_id: current.section_id, enrollment_status: 'active' })).status, 403, 'students are added by upload, not by this form');
  assert.equal((await S.admin.post(`/master/students/${id}/delete`).send({})).status, 403);
  assert.equal((await S.other.get(`/master/students/${id}/edit`)).status, 404, 'another college cannot open the student');
});

test('dashboard filters by category, the AI camera view, and filters on the people lists', { skip }, async () => {
  // Period presets and the breakdown by a chosen category.
  const week = (await S.admin.get('/dashboard?range=week&by=subject')).body;
  assert.deepEqual([week.preset, week.by, week.single], ['week', 'subject', false]);
  assert.ok(week.breakdown.length >= 4);
  assert.equal(week.breakdown.reduce((n, r) => n + r.marked, 0), week.totals.marked, 'the groups add up to the total');
  const byDept = (await S.admin.get('/dashboard?range=week&by=department')).body;
  assert.ok(byDept.breakdown.some((r) => /^CSE/.test(r.label)) && byDept.breakdown.some((r) => /^ECE/.test(r.label)));
  const cse = byDept.options.departments.find((o) => /^CSE/.test(o.label));
  const onlyCse = (await S.admin.get(`/dashboard?range=week&by=department&department_id=${cse.value}`)).body;
  assert.equal(onlyCse.breakdown.length, 1);
  assert.ok(onlyCse.totals.sessions < byDept.totals.sessions);
  assert.equal((await S.admin.get(`/dashboard?from=2020-01-01&to=${today}`)).body.from > '2020-01-01', true, 'long ranges are shortened, not refused');
  const hodStaff = (await S.hod.get('/dashboard?range=month&by=staff')).body;
  assert.ok(hodStaff.breakdown.length >= 3 && !hodStaff.byOptions.includes('department'));
  assert.deepEqual((await S.staff.get('/dashboard?range=week&by=staff')).body.by, 'class', 'a category the role does not have falls back to its first');

  // AI camera: everyone except students; each role sees the cameras of its own rooms.
  const all = (await S.admin.get('/cameras/view')).body.cameras;
  assert.equal(all.length, 4);
  const mine = (await S.staff.get('/cameras/view')).body.cameras;
  assert.ok(mine.length >= 1 && mine.length < all.length, 'staff see the cameras of rooms they teach in');
  const foreign = all.find((c) => !mine.some((m) => m.camera_id === c.camera_id));
  assert.equal((await S.staff.get(`/cameras/view?camera_id=${foreign.camera_id}`)).status, 404);
  assert.equal((await S.other.get('/cameras/view')).body.cameras.length, 0, 'another college has none of them');
  const student = await signIn('srm-vec', (await db.one(`SELECT u.username FROM attendance.users u JOIN identity.students s ON s.user_id = u.user_id WHERE u.college_id = $1 AND u.username LIKE 'vec%' ORDER BY u.username LIMIT 1`, [S.vec])).username, PW.student);
  assert.equal((await student.get('/cameras/view')).status, 403);
  assert.equal((await student.get('/auth/me')).body.permissions.camera_view.view, false);
  const cam = mine[0];
  const seen = (await S.staff.get(`/cameras/view?camera_id=${cam.camera_id}`)).body;
  assert.ok(Array.isArray(seen.activity.recent) && seen.activity.counts.events >= 0 && seen.viewerKind === null);
  // Choosing a camera on the dashboard keeps only the classes held in its room.
  const inRoom = (await S.admin.get(`/dashboard?range=week&by=class&camera_id=${cam.camera_id}`)).body;
  assert.equal(inRoom.camera.camera_id, cam.camera_id);
  assert.ok(inRoom.totals.sessions > 0 && inRoom.totals.sessions < week.totals.sessions);

  // A live view address: no credentials in it, and the page picks the right player.
  const row = await db.one('SELECT location_label, source_ref, classroom_id FROM identity.cameras WHERE camera_id = $1', [cam.camera_id]);
  const save = (url) => S.admin.post(`/master/cameras/${cam.camera_id}`).send({ ...row, enabled: 'on', viewer_url: url });
  assert.equal((await save('https://viewer:secret@nvr.example.edu/live/1.m3u8')).status, 422);
  assert.equal((await save('rtsp://10.0.0.5/stream1')).status, 422);
  assert.equal((await save('https://nvr.example.edu/live/lh101.m3u8')).status, 200);
  assert.equal((await S.staff.get(`/cameras/view?camera_id=${cam.camera_id}`)).body.viewerKind, 'hls');
  const { viewerKind } = require('../src/controllers/cameras');
  assert.deepEqual(['http://cam.local/video.mjpg', 'https://nvr.example.edu/view?cam=3', 'https://x/y/clip.mp4'].map(viewerKind), ['image', 'page', 'video']);

  // Filters on Student details and Staff details.
  const students = (await S.admin.get('/master/students')).body;
  assert.deepEqual(students.filters.map((f) => f.name), ['department_id', 'section_id', 'semester_no', 'batch_year', 'gender', 'enrollment_status', 'face']);
  const optedOut = (await S.admin.get('/master/students?enrollment_status=opted_out&page_size=200')).body;
  assert.ok(optedOut.pager.total >= 4 && optedOut.pager.total < students.pager.total);
  const noFace = (await S.admin.get('/master/students?face=no&page_size=200')).body;
  assert.ok(noFace.pager.total > 0 && noFace.rows.every((r) => Object.values(r).includes('No')));
  const ece = (await S.admin.get('/master/staff-list')).body.filters.find((f) => f.name === 'department_id').options.find((o) => /^ECE/.test(o.label));
  const eceStaff = (await S.admin.get(`/master/staff-list?department_id=${ece.value}`)).body;
  assert.ok(eceStaff.pager.total >= 4 && eceStaff.rows.every((r) => Object.values(r).includes('ECE')));
  assert.ok((await S.admin.get('/master/staff-list')).body.filters.find((f) => f.name === 'designation').options.length >= 2, 'designations come from the data');
});

test('face enrolment at first sign-in: three JPEG photos, saved under the register number, stored as vectors', { skip }, async () => {
  const faceEmbed = require('../src/services/faceEmbed');
  // The Python model is replaced by a stand-in: byte 4 of a test photo says whose face it is,
  // byte 5 varies the pose a little, and face 250 means "no face in the picture".
  const jpeg = (who, pose = 0) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, who, pose]), Buffer.alloc(64, 1)]);
  faceEmbed.setBackend((paths) => ({
    model_version: 'test-model',
    results: paths.map((p) => {
      const b = fs.readFileSync(p);
      if (b[3] === 250) return { path: p, faces: 0, problem: 'no_face' };
      const e = new Array(512).fill(0);
      e[b[3]] = 1; e[300 + b[4]] = 0.2;
      const n = Math.hypot(...e);
      return { path: p, faces: 1, problem: null, width: 200, sharpness: 90, score: 0.9, embedding: e.map((x) => x / n) };
    }),
  }));
  const fresh = S.fresh; // NEW0001: password already changed, face not enrolled
  const send = (agent, photos, consent = true) => {
    let r = agent.post('/enroll');
    photos.forEach((buf, i) => { r = r.attach('photos', buf, `p${i}.jpg`); });
    return consent ? r.field('consent', 'on') : r;
  };
  const stored = async () => (await db.one(`SELECT count(*)::int AS n FROM identity.face_embeddings e JOIN identity.students s ON s.student_id = e.student_id WHERE s.register_no = 'NEW0001'`)).n;
  const folder = path.join(process.env.PHOTO_DIR, 'NEW0001');

  let r = await send(fresh, [jpeg(7), jpeg(7, 1)]);
  assert.equal(r.status, 422); assert.match(r.body.message, /at least 3 photos/);
  r = await send(fresh, [jpeg(7), jpeg(7, 1), Buffer.from('\x89PNG\r\n\x1a\n not a jpeg')]);
  assert.equal(r.status, 422); assert.match(r.body.message, /Photo 3 is not a JPEG/);
  r = await send(fresh, [jpeg(7), jpeg(7, 1), jpeg(7, 2)], false);
  assert.equal(r.status, 422); assert.match(r.body.message, /consent/);
  r = await send(fresh, [jpeg(7), jpeg(250), jpeg(7, 2)]);
  assert.equal(r.status, 422); assert.match(r.body.message, /2 of 3 photos could be used.*Photo 2: no face was found/);
  r = await send(fresh, [jpeg(7), jpeg(7, 1), jpeg(9)]);
  assert.equal(r.status, 422); assert.match(r.body.message, /Photo 3: this does not look like the same person/);
  assert.equal(await stored(), 0, 'a refused attempt stores nothing');
  assert.equal(fs.existsSync(folder), false, 'and leaves no photos behind');

  r = await send(fresh, [jpeg(7), jpeg(7, 1), jpeg(7, 2)]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.photos, 3);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['front.jpg', 'left.jpg', 'right.jpg'], 'JPEGs are in var/photos/<register no>/');
  assert.ok(fs.readFileSync(path.join(folder, 'left.jpg')).equals(jpeg(7, 1)));
  const rows = await db.many(
    `SELECT vector_dims(e.embedding) AS dims, e.model_version, e.source, s.face_registered, s.consent_granted_at IS NOT NULL AS consent
       FROM identity.face_embeddings e JOIN identity.students s ON s.student_id = e.student_id WHERE s.register_no = 'NEW0001'`);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { dims: 512, model_version: 'test-model', source: 'enrollment', face_registered: true, consent: true });
  assert.deepEqual((await db.many(`SELECT i.pose, i.storage_ref FROM attendance.registration_images i JOIN identity.students s ON s.student_id = i.student_id WHERE s.register_no = 'NEW0001' ORDER BY i.image_id`)).map((x) => `${x.pose} ${x.storage_ref}`),
    ['front NEW0001/front.jpg', 'left NEW0001/left.jpg', 'right NEW0001/right.jpg']);
  assert.equal((await fresh.get('/dashboard/summary')).status, 200, 'the gate is lifted');
  assert.equal((await send(fresh, [jpeg(7), jpeg(7, 1), jpeg(7, 2)])).status, 422, 'a second enrolment needs a reset first');

  // Another student cannot enrol with a face that is already taken.
  const second = await signIn('srm-vec', 'new0002', 'new0002');
  await second.post('/auth/password').send({ current_password: 'new0002', new_password: 'Better#2027', confirm_password: 'Better#2027' });
  r = await send(second, [jpeg(7), jpeg(7, 1), jpeg(7, 2)]);
  assert.equal(r.status, 422); assert.match(r.body.message, /already enrolled for another student/);
  assert.equal((await db.one(`SELECT new_values FROM attendance.audit_logs WHERE action = 'face_enrolment_refused' ORDER BY action_time DESC LIMIT 1`)).new_values.matches_register_no, 'NEW0001');

  // Who may see the photos, and who may reset.
  const id = (await db.one(`SELECT student_id FROM identity.students WHERE register_no = 'NEW0001'`)).student_id;
  const own = await fresh.agent.get('/students/me/photos/front.jpg');
  assert.deepEqual([own.status, own.headers['content-type']], [200, 'image/jpeg']);
  assert.equal((await S.hod.agent.get(`/students/${id}/photos/front.jpg`)).status, 200);
  assert.equal((await second.agent.get(`/students/${id}/photos/front.jpg`)).status, 302, 'a student who has not enrolled is sent to enrol');
  assert.equal((await S.other.agent.get(`/students/${id}/photos/front.jpg`)).status, 404);
  assert.equal((await S.hod.agent.get(`/students/${id}/photos/..%2F..%2Fsecret.jpg`)).status, 404);
  const page = await S.hod.agent.get(`/students/${id}/attendance`);
  assert.match(page.text, /Reset enrolment/); assert.match(page.text, new RegExp(`/students/${id}/photos/front.jpg`));
  assert.equal((await S.staff.post(`/students/${id}/enrolment/reset`).send({})).status, 403);
  assert.equal((await S.hod.post(`/students/${id}/enrolment/reset`).send({})).status, 200);
  assert.equal(await stored(), 0);
  assert.equal(fs.existsSync(folder), false);
  assert.equal((await fresh.get('/dashboard/summary')).body.code, 'face_enrolment_required', 'after a reset the student enrols again');

  // Admin and HOD edit a student's mobile number, date of birth and the face-registered switch.
  const cur = await db.one('SELECT full_name, register_no, section_id, enrollment_status FROM identity.students WHERE student_id = $1', [id]);
  const form = (await S.hod.get(`/master/students/${id}/edit`)).body;
  assert.deepEqual([form.row.face, form.fields.some((f) => f.name === 'mobile'), form.fields.some((f) => f.name === 'dob')], ['no', true, true]);
  assert.equal((await S.hod.post(`/master/students/${id}`).send({ ...cur, mobile: '98-abc' })).status, 422, 'a mobile number is digits only');
  let edit = await S.hod.post(`/master/students/${id}`).send({ ...cur, mobile: '9876543210', dob: '2007-03-14', face: 'yes' });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.deepEqual(await db.one(`SELECT u.mobile, s.dob::text, s.face_registered FROM identity.students s JOIN attendance.users u ON u.user_id = s.user_id WHERE s.student_id = $1`, [id]),
    { mobile: '9876543210', dob: '2007-03-14', face_registered: true });
  assert.equal((await fresh.get('/dashboard/summary')).status, 200, 'marked "yes" by the office: the student is no longer asked to enrol');
  assert.ok((await S.admin.get('/master/students?q=NEW0001')).body.rows.some((r) => Object.values(r).includes('9876543210')), 'the list shows the mobile number');
  // "No" clears whatever face data there is and asks the student to enrol again.
  await db.query(`INSERT INTO identity.face_embeddings (student_id, embedding, model_version, source) VALUES ($1, array_fill(0.04, ARRAY[512])::vector, 'test-model', 'enrollment')`, [id]);
  fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'front.jpg'), jpeg(7));
  edit = await S.admin.post(`/master/students/${id}`).send({ ...cur, dob: '2007-03-14', face: 'no' });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.deepEqual([await stored(), fs.existsSync(folder), edit.body.row.face_registered], [0, false, false]);
  assert.equal((await db.one('SELECT u.mobile FROM identity.students s JOIN attendance.users u ON u.user_id = s.user_id WHERE s.student_id = $1', [id])).mobile, '9876543210', 'a field that was not sent is left alone');
  assert.equal((await fresh.get('/dashboard/summary')).body.code, 'face_enrolment_required');
  assert.equal((await S.staff.post(`/master/students/${id}`).send({ ...cur, face: 'yes' })).status, 403, 'staff cannot edit student details');

  // A college can switch the requirement off.
  await S.admin.post('/settings').send({ require_face_enrolment: false });
  assert.equal((await fresh.get('/dashboard/summary')).status, 200);
  await S.admin.post('/settings').send({ require_face_enrolment: true });
  faceEmbed.setBackend(null);
});
