'use strict';
const { invalid } = require('../utils/errors');
// Declarative description of the simple master tables. controllers/master.js and
// models/master.js turn each entry into list / add / edit / delete screens.
//
//   college:        'direct'  -> the table has college_id
//                   otherwise -> SQL column (through a join) that holds the college
//   departmentCol:  column an HOD is limited to; entities without it are read-only for HODs
//   fields[].options: name of an option source in models/master.js (always college-scoped)

const HOLIDAY_TYPES = ['government', 'college', 'exam', 'festival'];

module.exports = {
  departments: {
    title: 'Departments', one: 'department', module: 'master_data', group: 'master', upload: 'departments',
    table: 'attendance.departments', pk: 'department_id', college: 'direct', hodFilter: 'x.department_id',
    joins: `LEFT JOIN attendance.staff hs ON hs.staff_id = x.hod_staff_id LEFT JOIN attendance.users hu ON hu.user_id = hs.user_id`,
    columns: [['x.department_code', 'Code'], ['x.department_name', 'Name'], ["btrim(concat_ws(' ', hu.first_name, hu.last_name))", 'HOD']],
    order: 'x.department_code',
    fields: [
      { name: 'department_code', label: 'Code', type: 'text', required: true, max: 20, upper: true },
      { name: 'department_name', label: 'Name', type: 'text', required: true, max: 120 },
      { name: 'hod_staff_id', label: 'HOD', type: 'select', options: 'staff' },
    ],
  },
  programs: {
    title: 'Programs', one: 'program', module: 'master_data', group: 'master',
    table: 'attendance.programs', pk: 'program_id', college: 'direct',
    columns: [['x.program_code', 'Code'], ['x.program_name', 'Name'], ['x.duration_years', 'Years']],
    order: 'x.program_code',
    fields: [
      { name: 'program_code', label: 'Code', type: 'text', required: true, max: 20, upper: true },
      { name: 'program_name', label: 'Name', type: 'text', required: true, max: 120 },
      { name: 'duration_years', label: 'Duration (years)', type: 'int', required: true, min: 1, max: 8 },
    ],
  },
  subjects: {
    title: 'Subjects', one: 'subject', module: 'master_data', group: 'master', upload: 'subjects',
    table: 'attendance.subjects', pk: 'subject_id', college: 'direct', departmentCol: 'department_id',
    joins: `JOIN attendance.departments d ON d.department_id = x.department_id LEFT JOIN attendance.subject_categories sc ON sc.category_id = x.category_id`,
    columns: [['x.subject_code', 'Code'], ['x.short_name', 'Short name'], ['x.subject_name', 'Name'], ['d.department_code', 'Department'], ['x.semester_no', 'Semester'], ['x.credits', 'Credits'], ['sc.category_name', 'Category'], ["CASE WHEN x.is_lab THEN 'Lab' ELSE 'Theory' END", 'Type']],
    order: 'd.department_code, x.semester_no, x.subject_code',
    fields: [
      { name: 'subject_code', label: 'Code', type: 'text', required: true, max: 20, upper: true },
      { name: 'subject_name', label: 'Name', type: 'text', required: true, max: 160 },
      { name: 'short_name', label: 'Short name', type: 'text', max: 10, upper: true, hint: 'As written in timetable cells, for example CN' },
      { name: 'department_id', label: 'Department', type: 'select', options: 'departments', required: true },
      { name: 'semester_no', label: 'Semester', type: 'int', min: 1, max: 10 },
      { name: 'credits', label: 'Credits', type: 'number', min: 0, max: 20 },
      { name: 'total_hours', label: 'Total hours', type: 'int', min: 0, max: 500 },
      { name: 'lecture_hours', label: 'Lecture hours (L)', type: 'int', min: 0, max: 40 },
      { name: 'tutorial_hours', label: 'Tutorial hours (T)', type: 'int', min: 0, max: 40 },
      { name: 'practical_hours', label: 'Practical hours (P)', type: 'int', min: 0, max: 40 },
      { name: 'category_id', label: 'Category', type: 'select', options: 'categories' },
      { name: 'is_lab', label: 'Lab subject', type: 'bool' },
    ],
  },
  sections: {
    title: 'Sections', one: 'section', module: 'master_data', group: 'master', upload: 'sections',
    table: 'attendance.sections', pk: 'section_id', college: 'd.college_id', departmentCol: 'department_id',
    joins: `JOIN attendance.departments d ON d.department_id = x.department_id JOIN attendance.programs pr ON pr.program_id = x.program_id
            JOIN attendance.academic_years ay ON ay.academic_year_id = x.academic_year_id JOIN attendance.semesters sem ON sem.semester_id = x.semester_id`,
    columns: [['d.department_code', 'Department'], ['pr.program_code', 'Program'], ['ay.label', 'Academic year'], ['ceil(sem.semester_no / 2.0)::int', 'Year'], ['sem.semester_no', 'Semester'], ['x.section_name', 'Section'],
      ["(SELECT count(*) FROM identity.students s WHERE s.section_id = x.section_id AND s.enrollment_status = 'active')", 'Students']],
    order: 'ay.label DESC, d.department_code, sem.semester_no, x.section_name',
    fields: [
      { name: 'department_id', label: 'Department', type: 'select', options: 'departments', required: true },
      { name: 'program_id', label: 'Program', type: 'select', options: 'programs', required: true },
      { name: 'academic_year_id', label: 'Academic year', type: 'select', options: 'academic_years', required: true },
      { name: 'semester_id', label: 'Semester', type: 'select', options: 'semesters', required: true },
      { name: 'section_name', label: 'Section', type: 'text', required: true, max: 10, upper: true },
      { name: 'strength', label: 'Sanctioned strength', type: 'int', min: 0, max: 500, default: 0 },
    ],
  },
  allocations: {
    title: 'Subject allocation', one: 'allocation', module: 'master_data', group: 'master', upload: 'allocation',
    table: 'attendance.staff_subjects', pk: 'staff_subject_id', college: 'd.college_id', hodFilter: 'sec.department_id', hodWritable: true,
    joins: `JOIN attendance.sections sec ON sec.section_id = x.section_id JOIN attendance.departments d ON d.department_id = sec.department_id
            JOIN attendance.programs pr ON pr.program_id = sec.program_id JOIN attendance.semesters sem ON sem.semester_id = sec.semester_id
            JOIN attendance.academic_years ay ON ay.academic_year_id = x.academic_year_id JOIN attendance.subjects sub ON sub.subject_id = x.subject_id
            JOIN attendance.staff st ON st.staff_id = x.staff_id JOIN attendance.users su ON su.user_id = st.user_id
            LEFT JOIN attendance.classrooms cl ON cl.classroom_id = x.classroom_id`,
    columns: [['ay.label', 'Academic year'], ["d.department_code || ' ' || pr.program_code || ' Sem ' || sem.semester_no || ' ' || sec.section_name", 'Class'],
      ['sub.subject_code', 'Code'], ['sub.short_name', 'Short name'], ['sub.subject_name', 'Subject'],
      ["concat_ws('-', sub.lecture_hours, sub.tutorial_hours, sub.practical_hours)", 'L-T-P'],
      ["st.staff_code || ' ' || btrim(concat_ws(' ', su.first_name, su.last_name))", 'Staff'], ["concat_ws(' ', cl.block_name, cl.room_number)", 'Hall or lab']],
    order: 'ay.start_date DESC, d.department_code, sem.semester_no, sec.section_name, sub.subject_code',
    fields: [
      { name: 'section_id', label: 'Class', type: 'select', options: 'sections', required: true, hint: 'The academic year and semester follow the class' },
      { name: 'subject_id', label: 'Subject', type: 'select', options: 'all_subjects', required: true },
      { name: 'staff_id', label: 'Staff member', type: 'select', options: 'staff', required: true },
      { name: 'classroom_id', label: 'Hall or lab', type: 'select', options: 'classrooms', hint: 'Only when it is not the class\'s own hall' },
    ],
  },
  // Staff and student details. New people come in through Uploads (or Users > Add a user),
  // so these two lists have no Add or Delete of their own.
  'staff-list': {
    title: 'Staff details', one: 'staff member', module: 'users', group: 'people', noCreate: true, noDelete: true, upload: 'staff',
    table: 'attendance.staff', pk: 'staff_id', college: 'direct', departmentCol: 'department_id',
    joins: 'JOIN attendance.users u ON u.user_id = x.user_id JOIN attendance.departments d ON d.department_id = x.department_id',
    columns: [['x.staff_code', 'Staff code'], ["btrim(concat_ws(' ', u.first_name, u.last_name))", 'Name'], ['x.designation', 'Designation'], ['d.department_code', 'Department'],
      ['x.employee_type', 'Type'], ['x.joining_date', 'Joined'], ['u.email', 'Email'], ['u.mobile', 'Mobile'], ['u.username', 'Username'], ['x.status', 'Status']],
    order: 'd.department_code, x.staff_code',
    filters: [
      { name: 'department_id', label: 'Department', column: 'x.department_id', options: 'departments', int: true },
      { name: 'designation', label: 'Designation', column: 'x.designation', distinct: true },
      { name: 'employee_type', label: 'Type', column: 'x.employee_type', choices: ['regular', 'contract', 'visiting'] },
      { name: 'status', label: 'Status', column: 'x.status', choices: ['active', 'medical_leave', 'relieved'] },
    ],
    fields: [
      { name: 'designation', label: 'Designation', type: 'text', max: 80 },
      { name: 'employee_type', label: 'Employee type', type: 'select', choices: ['regular', 'contract', 'visiting'], required: true },
      { name: 'joining_date', label: 'Joining date', type: 'date' },
      { name: 'status', label: 'Status', type: 'select', choices: ['active', 'medical_leave', 'relieved'], required: true, hint: 'Name, email and mobile are changed under Users' },
    ],
  },
  students: {
    title: 'Student details', one: 'student', module: 'users', group: 'people', noCreate: true, noDelete: true, upload: 'students',
    table: 'identity.students', pk: 'student_id', pkText: true, college: 'direct', hodFilter: 'sec.department_id', hodWritable: true,
    joins: `LEFT JOIN attendance.sections sec ON sec.section_id = x.section_id LEFT JOIN attendance.departments d ON d.department_id = sec.department_id
            LEFT JOIN attendance.programs pr ON pr.program_id = sec.program_id LEFT JOIN attendance.semesters sem ON sem.semester_id = sec.semester_id
            LEFT JOIN attendance.users u ON u.user_id = x.user_id
            LEFT JOIN LATERAL (SELECT * FROM attendance.student_parents sp WHERE sp.student_id = x.student_id ORDER BY sp.parent_id LIMIT 1) par ON true`,
    columns: [['x.register_no', 'Register no'], ['x.roll_no', 'Roll'], ['x.full_name', 'Name'],
      ["d.department_code || ' ' || pr.program_code || ' Sem ' || sem.semester_no || ' ' || sec.section_name", 'Class'], ['x.batch_year', 'Batch'],
      ['x.gender', 'Gender'], ['x.dob', 'Date of birth'], ['u.mobile', 'Mobile'],
      ["concat_ws(', ', COALESCE(par.father_name, par.guardian_name, par.mother_name), COALESCE(par.father_mobile, par.guardian_mobile, par.mother_mobile))", 'Parent'],
      ["CASE WHEN x.face_registered THEN 'Yes' ELSE 'No' END", 'Face registered'], ["replace(x.enrollment_status, '_', ' ')", 'Status']],
    order: 'd.department_code, sem.semester_no, sec.section_name, x.roll_no NULLS LAST, x.register_no',
    filters: [
      { name: 'department_id', label: 'Department', column: 'sec.department_id', options: 'departments', int: true },
      { name: 'section_id', label: 'Class', column: 'x.section_id', options: 'sections', int: true },
      { name: 'semester_no', label: 'Semester', column: 'sem.semester_no', distinct: true, int: true },
      { name: 'batch_year', label: 'Batch', column: 'x.batch_year', distinct: true, int: true },
      { name: 'gender', label: 'Gender', column: 'x.gender', choices: ['male', 'female', 'other'] },
      { name: 'enrollment_status', label: 'Status', column: 'x.enrollment_status', choices: ['active', 'withdrawn', 'graduated', 'opted_out'] },
      { name: 'face', label: 'Face registered', column: "CASE WHEN x.face_registered THEN 'yes' ELSE 'no' END", choices: ['yes', 'no'] },
    ],
    fields: [
      { name: 'full_name', label: 'Full name', type: 'text', required: true, max: 120 },
      { name: 'register_no', label: 'Register number', type: 'text', required: true, max: 40, upper: true },
      { name: 'roll_no', label: 'Roll number', type: 'text', max: 20 },
      { name: 'admission_no', label: 'Admission number', type: 'text', max: 40 },
      { name: 'section_id', label: 'Class', type: 'select', options: 'sections', required: true },
      { name: 'batch_year', label: 'Batch year', type: 'int', min: 1990, max: 2100 },
      { name: 'gender', label: 'Gender', type: 'select', choices: ['male', 'female', 'other'] },
      { name: 'dob', label: 'Date of birth', type: 'date' },
      { name: 'mobile', label: 'Mobile number', type: 'text', max: 15, pattern: '^\\+?[0-9]{10,14}$', virtual: true, hint: '10 to 14 digits, with or without a leading +' },
      { name: 'enrollment_status', label: 'Status', type: 'select', choices: ['active', 'withdrawn', 'graduated', 'opted_out'], required: true, hint: 'Opted out: no camera attendance; staff mark by hand' },
      { name: 'face', label: 'Face registered', type: 'select', choices: ['yes', 'no'], virtual: true,
        hint: 'No: the stored face photos and face data are deleted and the student enrols again at next sign-in. Yes without enrolled photos: the student is not asked to enrol, but cameras cannot recognise them, so they are marked absent unless staff mark them by hand.' },
    ],
    // The mobile number is kept on the student's sign-in account; "face registered" is a switch with consequences.
    extraSelect: "u.mobile AS mobile, CASE WHEN x.face_registered THEN 'yes' ELSE 'no' END AS face",
    afterSave: async (client, row, scope, extra = {}) => {
      if (extra.mobile !== undefined) {
        if (row.user_id) await client.query('UPDATE attendance.users SET mobile = $2 WHERE user_id = $1', [row.user_id, extra.mobile]);
        else if (extra.mobile) throw invalid('This student has no sign-in account to keep a mobile number on. Add the student again through the Students upload.');
      }
      if (extra.face === 'yes' && !row.face_registered) {
        await client.query('UPDATE identity.students SET face_registered = true WHERE student_id = $1', [row.student_id]);
      }
      if (extra.face === 'no') {
        const gone = await client.query('DELETE FROM identity.face_embeddings WHERE student_id = $1', [row.student_id]);
        await client.query('UPDATE identity.students SET face_registered = false WHERE student_id = $1', [row.student_id]);
        if (row.face_registered || gone.rowCount) {
          const fs = require('fs');
          fs.rmSync(require('../services/enrolment').photoFolder(row), { recursive: true, force: true });
        }
      }
    },
  },
  'academic-years': {
    title: 'Academic years', one: 'academic year', module: 'academic_setup', group: 'academic',
    table: 'attendance.academic_years', pk: 'academic_year_id', college: 'direct',
    columns: [['x.label', 'Label'], ['x.start_date', 'Starts'], ['x.end_date', 'Ends'], ["CASE WHEN x.is_active THEN 'Active' ELSE '' END", 'Status']],
    order: 'x.start_date DESC',
    fields: [
      { name: 'label', label: 'Label', type: 'text', required: true, max: 20, hint: 'For example 2026-27' },
      { name: 'start_date', label: 'Start date', type: 'date', required: true },
      { name: 'end_date', label: 'End date', type: 'date', required: true },
      { name: 'is_active', label: 'Active year (uploads and new sections use it)', type: 'bool' },
    ],
    // Only one active year per college.
    afterSave: (client, row, scope) => row.is_active
      ? client.query('UPDATE attendance.academic_years SET is_active = false WHERE college_id = $1 AND academic_year_id <> $2', [scope.collegeId, row.academic_year_id])
      : null,
  },
  semesters: {
    title: 'Semesters', one: 'semester', module: 'academic_setup', group: 'academic',
    table: 'attendance.semesters', pk: 'semester_id', college: 'ay.college_id',
    joins: 'JOIN attendance.academic_years ay ON ay.academic_year_id = x.academic_year_id',
    columns: [['ay.label', 'Academic year'], ['x.semester_no', 'Semester'], ['ceil(x.semester_no / 2.0)::int', 'Year of study'], ['x.start_date', 'Starts'], ['x.end_date', 'Ends']],
    order: 'ay.start_date DESC, x.semester_no',
    fields: [
      { name: 'academic_year_id', label: 'Academic year', type: 'select', options: 'academic_years', required: true },
      { name: 'semester_no', label: 'Semester number', type: 'int', required: true, min: 1, max: 10 },
      { name: 'start_date', label: 'Start date', type: 'date', required: true },
      { name: 'end_date', label: 'End date', type: 'date', required: true },
    ],
  },
  periods: {
    title: 'Periods', one: 'period', module: 'academic_setup', group: 'academic',
    table: 'attendance.periods', pk: 'period_id', college: 'direct',
    columns: [['x.period_no', 'Period'], ["to_char(x.start_time, 'HH24:MI')", 'Starts'], ["to_char(x.end_time, 'HH24:MI')", 'Ends'], ['x.duration_minutes', 'Minutes']],
    order: 'x.period_no',
    fields: [
      { name: 'period_no', label: 'Period number', type: 'int', required: true, min: 1, max: 20 },
      { name: 'start_time', label: 'Start time', type: 'time', required: true },
      { name: 'end_time', label: 'End time', type: 'time', required: true },
    ],
    beforeSave: (v) => {
      const mins = (t) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);
      v.duration_minutes = mins(v.end_time) - mins(v.start_time);
      if (v.duration_minutes <= 0) throw Object.assign(new Error('End time must be after start time.'), { status: 422 });
    },
  },
  classrooms: {
    title: 'Classrooms', one: 'classroom', module: 'academic_setup', group: 'academic', upload: 'classrooms',
    table: 'attendance.classrooms', pk: 'classroom_id', college: 'direct',
    columns: [['x.room_number', 'Room'], ['x.block_name', 'Block'], ['x.floor_no', 'Floor'], ['x.capacity', 'Capacity'], ["CASE WHEN x.has_cctv THEN 'Yes' ELSE 'No' END", 'Camera'],
      ['(SELECT count(*) FROM identity.cameras c WHERE c.classroom_id = x.classroom_id AND c.enabled)', 'Cameras mapped']],
    order: 'x.block_name NULLS FIRST, x.room_number',
    fields: [
      { name: 'room_number', label: 'Room number', type: 'text', required: true, max: 30, upper: true },
      { name: 'block_name', label: 'Block', type: 'text', max: 60 },
      { name: 'floor_no', label: 'Floor', type: 'int', min: -5, max: 100 },
      { name: 'capacity', label: 'Capacity', type: 'int', min: 0, max: 2000 },
      { name: 'has_cctv', label: 'Has a camera', type: 'bool', default: true },
      { name: 'remarks', label: 'Remarks', type: 'text', max: 200 },
    ],
  },
  holidays: {
    title: 'Holidays', one: 'holiday', module: 'academic_setup', group: 'academic',
    table: 'attendance.holidays', pk: 'holiday_id', college: 'ay.college_id',
    joins: 'JOIN attendance.academic_years ay ON ay.academic_year_id = x.academic_year_id',
    columns: [['x.holiday_date', 'Date'], ['x.holiday_name', 'Holiday'], ['x.holiday_type', 'Type'], ['ay.label', 'Academic year']],
    order: 'x.holiday_date DESC',
    fields: [
      { name: 'academic_year_id', label: 'Academic year', type: 'select', options: 'academic_years', required: true },
      { name: 'holiday_name', label: 'Holiday', type: 'text', required: true, max: 120 },
      { name: 'holiday_date', label: 'Date', type: 'date', required: true },
      { name: 'holiday_type', label: 'Type', type: 'select', choices: HOLIDAY_TYPES },
    ],
  },
  'working-days': {
    title: 'Working-day overrides', one: 'working-day override', module: 'academic_setup', group: 'academic',
    table: 'attendance.working_days', pk: 'working_day_id', college: 'ay.college_id',
    joins: 'JOIN attendance.academic_years ay ON ay.academic_year_id = x.academic_year_id',
    columns: [['x.work_date', 'Date'], ["CASE WHEN x.is_working THEN 'Working' ELSE 'Not working' END", 'Day is'], ['ay.label', 'Academic year']],
    order: 'x.work_date DESC',
    fields: [
      { name: 'academic_year_id', label: 'Academic year', type: 'select', options: 'academic_years', required: true },
      { name: 'work_date', label: 'Date', type: 'date', required: true },
      { name: 'is_working', label: 'Classes run on this date', type: 'bool' },
    ],
  },
  cameras: {
    title: 'Cameras', one: 'camera', module: 'cameras', group: 'cameras',
    table: 'identity.cameras', pk: 'camera_id', pkText: true, college: 'direct',
    joins: 'LEFT JOIN attendance.classrooms cl ON cl.classroom_id = x.classroom_id',
    columns: [['x.camera_id', 'Camera id'], ['x.location_label', 'Location'], ["concat_ws(' ', cl.block_name, cl.room_number)", 'Classroom'], ["CASE WHEN x.enabled THEN 'Enabled' ELSE 'Disabled' END", 'Status']],
    order: 'x.camera_id',
    fields: [
      { name: 'camera_id', label: 'Camera id', type: 'text', required: true, max: 60, onCreateOnly: true, hint: 'The id the recognition pipeline sends on each event' },
      { name: 'location_label', label: 'Location', type: 'text', required: true, max: 120 },
      { name: 'source_ref', label: 'Secret-store key', type: 'text', required: true, max: 200, hint: 'Lookup key only. Never a stream URL or password.' },
      { name: 'classroom_id', label: 'Classroom', type: 'select', options: 'classrooms' },
      { name: 'viewer_url', label: 'Live view address', type: 'text', max: 300, pattern: '^https?://[^@\\s]+$', hint: 'Optional. An http(s) address a browser can show: HLS (.m3u8), MJPEG, or a page of your video gateway. No user name or password in it.' },
      { name: 'enabled', label: 'Enabled', type: 'bool', default: true },
    ],
  },
};
