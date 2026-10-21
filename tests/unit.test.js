'use strict';
// Pure logic: no database needed.  npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../src/services/engine');
const matrix = require('../src/importers/matrix');
const { specs, dateVal, bool } = require('../src/services/imports/specs');
const permissions = require('../src/services/permissions');
const { pct } = require('../src/models/common');
const { parseDay, isoDow, addDays, daysBetween } = require('../src/utils/dates');
const db = require('../src/config/db');

test.after(() => db.end());

const ev = (over = {}) => ({ classroom_id: 1, confidence: 0.9, min_confidence: 0.5, non_working: false, enrollment_status: 'active', student_section_id: 7, local_time: '09:03:00', late_after: 10, ...over });
const slot = (over = {}) => ({ timetable_id: 11, slot_section_id: 7, start_time: '09:00:00', end_time: '09:50:00', ...over });

test('engine: a detection inside the period marks present', () => {
  assert.deepEqual(decide(ev(), [slot()]), { timetable_id: 11, status: 'present' });
});
test('engine: a first detection after the late limit marks late', () => {
  assert.equal(decide(ev({ local_time: '09:10:01' }), [slot()]).status, 'late');
  assert.equal(decide(ev({ local_time: '09:10:00' }), [slot()]).status, 'present');
});
test('engine: early entry counts for the coming period, but a running period wins', () => {
  assert.deepEqual(decide(ev({ local_time: '08:57:00' }), [slot()]), { timetable_id: 11, status: 'present' });
  const running = slot({ timetable_id: 10, start_time: '08:10:00', end_time: '09:00:00' });
  assert.equal(decide(ev({ local_time: '08:57:00' }), [running, slot()]).timetable_id, 10);
});
test('engine: every ignore reason', () => {
  assert.equal(decide(ev({ classroom_id: null }), [slot()]).ignore, 'camera_unmapped');
  assert.equal(decide(ev({ confidence: 0.3 }), [slot()]).ignore, 'low_confidence');
  assert.equal(decide(ev({ non_working: true }), [slot()]).ignore, 'non_working_day');
  assert.equal(decide(ev(), [{ timetable_id: null }]).ignore, 'no_class_scheduled');
  assert.equal(decide(ev({ enrollment_status: 'withdrawn' }), [slot()]).ignore, 'student_not_active');
  assert.equal(decide(ev({ student_section_id: 8 }), [slot()]).ignore, 'student_not_in_section');
});
test('engine: two sections share a room in back-to-back periods; the student goes to their own', () => {
  const other = slot({ timetable_id: 10, slot_section_id: 8, start_time: '08:10:00', end_time: '09:00:00' });
  assert.equal(decide(ev({ local_time: '08:57:00' }), [other, slot()]).timetable_id, 11);
});

test('engine: electives and parallel classes', () => {
  // Not on the roll of an elective held in this room: ignored with its own reason.
  assert.equal(decide(ev(), [slot({ eligible: false })]).ignore, 'student_not_enrolled');
  // Two classes of the section share the room in one period: the one the student is listed for wins.
  const a = slot({ timetable_id: 20, eligible: true, enrolled: false });
  const b = slot({ timetable_id: 21, eligible: true, enrolled: true });
  assert.equal(decide(ev(), [a, b]).timetable_id, 21);
  assert.equal(decide(ev(), [a, slot({ timetable_id: 22 })]).timetable_id, 20, 'otherwise the first, every time');
});

test('class sheet: staff cells, times and the header block', () => {
  const cs = require('../src/importers/classSheet');
  assert.deepEqual(cs.staffEntries(['Ms.S.Anslam Sibi / A.P - Sr. G.(Hall No.502)', 'Ms. M. Priyadharshini / A.P - O.G.(Hall', 'No.504)', 'New Staff 5']), [
    { name: 'Ms.S.Anslam Sibi', designation: 'A.P - Sr. G.', halls: ['502'] },
    { name: 'Ms. M. Priyadharshini', designation: 'A.P - O.G.', halls: ['504'] },
    { name: 'New Staff 5', designation: null, halls: [] },
  ]);
  assert.deepEqual(cs.staffEntry('Dr. C. Pabitha / Asso. Prof. (Hall No.: 404,402)').halls, ['404', '402']);
  assert.equal(cs.parseTime('12.45pm'), '12:45');
  assert.equal(cs.parseTime('1.30pm'), '13:30');
  assert.equal(cs.parseTime('8.15am-'), '08:15');
  const meta = cs.parseMeta(['Academic Year : 2026-2027 (ODD Semester)', 'PROGRAMME : B.E. Hall No : 504', 'SEMESTER : V - CSE 3 CLASS ADVISOR: Ms.S.Balaswathy / A.P - O.G.']);
  assert.deepEqual([meta.programme, meta.semester_no, meta.department_code, meta.section, meta.hall, meta.year_start, meta.term, meta.class_advisor], ['BE', 5, 'CSE', '3', '504', 2026, 'ODD', 'Ms.S.Balaswathy']);
});

test('class sheet: staff names match whatever the title or the order of initials', () => {
  const { nameKey } = require('../src/services/imports/specs');
  assert.equal(nameKey('Ms.S.Balaswathy / A.P - O.G.'), nameKey('Balaswathy S'));
  assert.equal(nameKey('Dr. C. Pabitha'), nameKey('C Pabitha'));
  assert.notEqual(nameKey('New Staff 4'), nameKey('New Staff 5'));
});

test('class sheet: the Excel layout in the template is read, merged double periods included', async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const imports = require('../src/services/imports');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'att-unit-')), 'sheet.xlsx');
  await (await imports.templateWorkbook('timetable')).xlsx.writeFile(file);
  const sheet = await imports.readClassSheets(file, 'xlsx');
  assert.equal(sheet.sheets, 1);
  assert.deepEqual([sheet.meta.programme, sheet.meta.semester_no, sheet.meta.department_code, sheet.meta.section, sheet.meta.hall], ['BE', 5, 'CSE', '3', '504']);
  const at = (day, period) => sheet.timetable.filter((r) => r.raw.day === String(day) && r.raw.period_no === String(period)).map((r) => r.raw.subject_code).sort();
  assert.deepEqual(at(1, 3), ['CS3565', 'CS3566'], 'AIMLL / CNL, first hour of the merged cell');
  assert.deepEqual(at(1, 4), ['CS3565', 'CS3566'], 'and the second');
  assert.deepEqual(at(1, 6), ['TP'], 'a subject with no code uses its short name');
  assert.deepEqual(at(2, 1), ['PCY302', 'PIT202'], 'two electives in one cell');
  const cnl = sheet.allocation.find((r) => r.raw.short_name === 'CNL').raw;
  assert.deepEqual([cnl.subject_code, cnl.practical_hours, cnl.staff_name, cnl.room_number], ['CS3565', '4', 'Ms. S. Balaswathy', 'LAB-2']);
  assert.equal(sheet.allocation.find((r) => r.raw.short_name === 'DW').raw.category, 'Professional Elective - I');
});

test('import: table layout finds the header through aliases', () => {
  const cols = specs.subjects.columns;
  const t = matrix.fromTable([['Subjects of CSE'], [], ['Code', 'Subject Name', 'Dept', 'Sem', 'Credits'], ['CS301', 'Data Structures', 'CSE', '3', '4'], ['', '', '', '', '']], cols);
  assert.equal(t.rows.length, 1);
  assert.deepEqual(t.missing, []);
  assert.equal(t.rows[0].raw.subject_code, 'CS301');
  assert.equal(t.rows[0].raw.department_code, 'CSE');
});
test('import: a class list takes its class from the heading and college-style column names', () => {
  const cols = specs.students.columns;
  const t = matrix.fromTable([
    ['DEPARTMENT OF COMPUTER SCIENCE AND ENGINEERING'], ['PROGRAMME : B.E.'], ['SEMESTER : V - CSE 3'], [],
    ['S.No', 'Register Number', 'Name of the Student', "Father's Name", 'Parent Mobile'],
    ['1', '142221104001', 'Aarthi S', 'Selvam K', '9000011111'],
  ], cols);
  assert.deepEqual(t.missing, []);
  assert.deepEqual(t.meta, { department_code: 'CSE', program_code: 'BE', semester_no: '5', section: '3' });
  assert.deepEqual([t.rows[0].raw.register_no, t.rows[0].raw.full_name, t.rows[0].raw.father_name, t.rows[0].raw.father_mobile], ['142221104001', 'Aarthi S', 'Selvam K', '9000011111']);
  // A heading line that happens to hold two known words is not the header of the list.
  assert.equal(matrix.isHeader(['Department:', 'CSE', 'Section:', 'A'], cols), false);
  assert.equal(matrix.isHeader(['Reg. No.', 'Name'], cols), true);
  // A staff list headed only by its department.
  const st = matrix.fromTable([['Department of Mechanical Engineering'], ['Employee ID', 'Name of the Faculty', 'Designation']], specs.staff.columns);
  assert.equal(st.meta.department_code, 'Mechanical Engineering');
});

test('import: a missing required column is reported', () => {
  const t = matrix.fromTable([['subject_code', 'subject_name', 'semester_no'], ['CS301', 'DS', '3']], specs.subjects.columns);
  assert.deepEqual(t.missing, ['department_code']);
});
test('import: timetable grid, two sections stacked on one sheet', () => {
  const g = matrix.fromGrid([
    ['Department', 'CSE'], ['Program', 'BTECH'], ['Semester', '3'], ['Section', 'A'], [],
    ['Day', 'P1', 'P2', 'Period 3'],
    ['Monday', 'CS301 / S1 / LH-1', 'Lunch', 'CS302/S2/LH-1'],
    ['Tue', '', 'CS301\nS1\nLH-1', ''],
    [],
    ['Department: CSE  Program: BTECH  Semester: 3  Section: B'],
    ['Day', '1', '2'],
    ['Saturday', 'CS303 / S3', '-'],
  ]);
  assert.equal(g.layout, 'grid');
  assert.equal(g.rows.length, 4);
  assert.deepEqual([g.rows[0].raw.section, g.rows[0].raw.day, g.rows[0].raw.period_no, g.rows[0].raw.staff_code], ['A', '1', '1', 'S1']);
  assert.deepEqual([g.rows[2].raw.day, g.rows[2].raw.period_no, g.rows[2].raw.room_number], ['2', '2', 'LH-1']);
  assert.deepEqual([g.rows[3].raw.section, g.rows[3].raw.day, g.rows[3].uncertain], ['B', '6', true]); // a cell without a room is flagged
});
test('import: value parsing', () => {
  assert.equal(dateVal('18-04-2007'), '2007-04-18');
  assert.equal(dateVal('2007-04-18'), '2007-04-18');
  assert.equal(dateVal('31/02/2007'), null);
  assert.equal(bool('Yes'), true);
  assert.equal(bool('', true), true);
  assert.equal(bool('maybe'), null);
});

test('dates: day names and arithmetic', () => {
  assert.equal(parseDay('Monday'), 1);
  assert.equal(parseDay('sat'), 6);
  assert.equal(parseDay('7'), 7);
  assert.equal(parseDay('P1'), null);
  assert.equal(isoDow('2026-10-04'), 7); // a Sunday
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(daysBetween('2026-09-28', '2026-10-03'), 5);
});

test('percentage: both rules for excused', () => {
  assert.equal(pct(8, 1, 10, true), 90);
  assert.equal(pct(8, 1, 10, false), 88.9);
  assert.equal(pct(0, 0, 0, true), null);
});

test('permissions: the default matrix matches the PRD', () => {
  const m = permissions.defaultMatrix();
  assert.deepEqual(m.admin.master_data, { view: true, edit: true, delete: false, export: false });
  assert.deepEqual(m.hod.permissions, { view: false, edit: false, delete: false, export: false });
  assert.equal(m.staff.corrections.edit, true);
  assert.ok(Object.values(m.student).every((c) => !c.edit && !c.delete && !c.export));
  assert.equal(permissions.diff(m, m).length, 0);
});
