'use strict';
// One spec per import type: its columns, how a batch is validated, and how it is committed.
// validate() fills row.normalized and row.errors for every row (it sees the whole batch, so
// it can catch duplicates and clashes). commit() runs inside one transaction.
const usersModel = require('../../models/users');
const timetableService = require('../timetable');
const { hashPassword } = require('../../utils/crypto');
const { parseDay, DAY_NAMES, isDate } = require('../../utils/dates');

const up = (s) => String(s === null || s === undefined ? '' : s).trim().toUpperCase();
const low = (s) => String(s === null || s === undefined ? '' : s).trim().toLowerCase();
const txt = (s) => String(s === null || s === undefined ? '' : s).trim();

function int(v) {
  const s = txt(v);
  return /^-?\d+$/.test(s) ? parseInt(s, 10) : null;
}
function num(v) {
  const s = txt(v);
  return s !== '' && !Number.isNaN(Number(s)) ? Number(s) : null;
}
function bool(v, dflt = false) {
  const s = low(v);
  if (s === '') return dflt;
  if (['y', 'yes', 'true', '1', 'lab'].includes(s)) return true;
  if (['n', 'no', 'false', '0', 'theory'].includes(s)) return false;
  return null;
}
/** YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY or DD.MM.YYYY -> YYYY-MM-DD, else null. */
function dateVal(v) {
  const s = txt(v);
  if (isDate(s)) return s;
  const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isDate(iso) ? iso : null;
}
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const TITLES = new Set(['ms', 'mrs', 'mr', 'dr', 'prof', 'miss', 'er']);
/** "Ms.S.Balaswathy / A.P - O.G." and "Balaswathy S" give the same key: name parts, titles dropped, sorted. */
function nameKey(name, loose = false) {
  const parts = String(name || '').split(' / ')[0].toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !TITLES.has(t));
  return (loose ? parts.filter((t) => t.length > 1) : parts).sort().join(' ');
}
const codeKey = (v) => up(v).replace(/[^A-Z0-9]/g, '');

/** Find a staff member by code, else by name. Returns { staff, problem }. */
function findStaff(ctx, code, name) {
  if (up(code)) {
    const st = ctx.staff.get(up(code));
    return st ? { staff: st } : { problem: `Staff "${up(code)}" does not exist` };
  }
  if (!txt(name)) return {};
  const exact = ctx.staffByName.get(nameKey(name)) || [];
  if (exact.length === 1) return { staff: exact[0] };
  if (exact.length > 1) return { problem: `More than one staff member is called "${txt(name)}"; enter the staff code` };
  const loose = nameKey(name, true);
  const near = loose ? ctx.staffByLooseName.get(loose) || [] : [];
  if (near.length === 1) return { staff: near[0] };
  return {};
}

function need(raw, n, errs, name, label, max = 200) {
  const v = txt(raw[name]);
  if (!v) errs.push(`${label} is required`);
  else if (v.length > max) errs.push(`${label} is longer than ${max} characters`);
  n[name] = v;
  return v;
}

function dupes(rows, keyFn, label) {
  const seen = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!k) continue;
    if (seen.has(k)) r.errors.push(`${label} appears more than once in this file (also row ${seen.get(k)})`);
    else seen.set(k, r.row_no);
  }
}

function department(ctx, raw, n, errs) {
  const code = up(raw.department_code);
  // By code, or by full name (a heading such as "DEPARTMENT OF COMPUTER SCIENCE AND ENGINEERING").
  const d = ctx.departments.get(code) || (code ? ctx.departmentsByName.get(codeKey(code)) : null);
  n.department_code = d ? up(d.department_code) : code;
  if (!code) errs.push('Department code is required');
  else if (!d) errs.push(`Department "${code}" does not exist`);
  else if (ctx.hodDepartmentId && d.department_id !== ctx.hodDepartmentId) errs.push('You can upload only for your own department');
  n.department_id = d ? d.department_id : null;
  return d;
}

/** department + program + semester + section name -> ids. mustExist: the section row itself must exist. */
function section(ctx, raw, n, errs, mustExist) {
  const d = department(ctx, raw, n, errs);
  const pcode = up(raw.program_code);
  const p = ctx.programs.get(codeKey(pcode));
  n.program_code = pcode;
  if (!pcode) errs.push('Program code is required');
  else if (!p) errs.push(`Program "${pcode}" does not exist`);
  n.program_id = p ? p.program_id : null;
  const semNo = int(raw.semester_no);
  n.semester_no = semNo;
  let sem = null;
  if (!ctx.activeYear) errs.push('No academic year is set up for this college');
  else if (semNo === null) errs.push('Semester number is required');
  else {
    sem = ctx.semesters.get(semNo);
    if (!sem) errs.push(`Semester ${semNo} is not set up in academic year ${ctx.activeYear.label}`);
  }
  n.semester_id = sem ? sem.semester_id : null;
  if (txt(raw.year) && semNo !== null && int(raw.year) !== Math.ceil(semNo / 2)) errs.push(`Year ${txt(raw.year)} does not match semester ${semNo}`);
  const name = up(raw.section);
  n.section = name;
  if (!name) errs.push('Section is required');
  let sec = null;
  if (d && p && sem && name) {
    sec = ctx.sections.get(`${d.department_id}|${p.program_id}|${sem.semester_id}|${name}`);
    if (mustExist && !sec) errs.push(`Section ${d.department_code} ${p.program_code} semester ${semNo} ${name} does not exist. Upload sections first.`);
  }
  n.section_id = sec ? sec.section_id : null;
  return { d, p, sem, sec };
}

async function emailClashes(ctx, client, rows, ownUserId) {
  const emails = [...new Set(rows.map((r) => r.normalized.email).filter(Boolean))];
  if (!emails.length) return;
  const found = await client.many(
    'SELECT user_id, lower(email) AS email FROM attendance.users WHERE college_id = $1 AND lower(email) = ANY($2)',
    [ctx.collegeId, emails]
  );
  const owner = new Map(found.map((f) => [f.email, f.user_id]));
  for (const r of rows) {
    const e = r.normalized.email;
    if (e && owner.has(e) && owner.get(e) !== ownUserId(r)) r.errors.push(`Email ${e} is already used by another user`);
  }
}

async function usernameClashes(ctx, client, rows, ownUserId) {
  const names = [...new Set(rows.map((r) => r.normalized.username).filter(Boolean))];
  if (!names.length) return;
  const found = await client.many(
    'SELECT user_id, lower(username) AS username FROM attendance.users WHERE college_id = $1 AND lower(username) = ANY($2)',
    [ctx.collegeId, names]
  );
  const owner = new Map(found.map((f) => [f.username, f.user_id]));
  for (const r of rows) {
    const u = r.normalized.username;
    if (u && owner.has(u) && owner.get(u) !== ownUserId(r)) r.errors.push(`Username ${u} is already taken`);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const SECTION_COLS = [
  { name: 'department_code', required: true, aliases: ['department', 'dept', 'dept_code', 'branch'], example: 'CSE', note: 'Must exist under Departments' },
  { name: 'program_code', required: true, aliases: ['program', 'programme', 'course', 'degree'], example: 'BTECH', note: 'Must exist under Programs' },
  { name: 'semester_no', required: true, aliases: ['semester', 'sem'], example: '3', note: '1 to 10; the semester must be set up in the active academic year' },
  { name: 'section', required: true, aliases: ['section_name', 'sec'], example: 'A' },
];

const specs = {
  // ------------------------------------------------------------------ departments
  departments: {
    label: 'Departments', hodAllowed: false,
    columns: [
      { name: 'department_code', required: true, aliases: ['code', 'dept_code', 'dept'], example: 'CSE' },
      { name: 'department_name', required: true, aliases: ['name', 'department', 'dept_name'], example: 'Computer Science and Engineering' },
      { name: 'hod_staff_code', aliases: ['hod', 'hod_code'], example: '', note: 'Optional. Staff code of the HOD; the staff member must already exist' },
    ],
    async validate(ctx, rows) {
      for (const r of rows) {
        const n = {}, errs = [];
        n.department_code = up(need(r.raw, n, errs, 'department_code', 'Department code', 20));
        need(r.raw, n, errs, 'department_name', 'Department name', 120);
        const hod = up(r.raw.hod_staff_code);
        n.hod_staff_id = null;
        if (hod) {
          const s = ctx.staff.get(hod);
          if (!s) errs.push(`HOD staff code "${hod}" does not exist`);
          else n.hod_staff_id = s.staff_id;
        }
        r.normalized = n; r.errors = errs;
      }
      dupes(rows, (r) => r.normalized.department_code, 'Department code');
    },
    async commit(client, ctx, rows) {
      let inserted = 0, updated = 0;
      for (const { normalized: n } of rows) {
        const res = await client.one(
          `INSERT INTO attendance.departments (college_id, department_code, department_name, hod_staff_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (college_id, department_code) DO UPDATE
             SET department_name = EXCLUDED.department_name,
                 hod_staff_id = COALESCE(EXCLUDED.hod_staff_id, attendance.departments.hod_staff_id)
           RETURNING (xmax = 0) AS inserted`,
          [ctx.collegeId, n.department_code, n.department_name, n.hod_staff_id]
        );
        if (res.inserted) inserted++; else updated++;
      }
      return { inserted, updated };
    },
  },

  // ------------------------------------------------------------------ subjects
  subjects: {
    label: 'Subjects', hodAllowed: true,
    columns: [
      { name: 'subject_code', required: true, aliases: ['code', 'course_code'], example: 'CS301' },
      { name: 'subject_name', required: true, aliases: ['name', 'subject', 'course_name', 'course_title'], example: 'Data Structures' },
      { name: 'department_code', required: true, aliases: ['department', 'dept', 'dept_code'], example: 'CSE' },
      { name: 'semester_no', required: true, aliases: ['semester', 'sem'], example: '3', note: '1 to 10' },
      { name: 'credits', aliases: ['credit'], example: '4' },
      { name: 'total_hours', aliases: ['hours'], example: '60' },
      { name: 'category', aliases: ['category_name', 'type'], example: 'Core', note: 'Optional. Created if it is new' },
      { name: 'is_lab', aliases: ['lab'], example: 'No', note: 'Yes or No' },
    ],
    async validate(ctx, rows) {
      for (const r of rows) {
        const n = {}, errs = [];
        n.subject_code = up(need(r.raw, n, errs, 'subject_code', 'Subject code', 20));
        need(r.raw, n, errs, 'subject_name', 'Subject name', 160);
        department(ctx, r.raw, n, errs);
        n.semester_no = int(r.raw.semester_no);
        if (n.semester_no === null || n.semester_no < 1 || n.semester_no > 10) errs.push('Semester number must be 1 to 10');
        n.credits = txt(r.raw.credits) ? num(r.raw.credits) : null;
        if (txt(r.raw.credits) && (n.credits === null || n.credits < 0 || n.credits > 20)) errs.push('Credits must be a number from 0 to 20');
        n.total_hours = txt(r.raw.total_hours) ? int(r.raw.total_hours) : null;
        if (txt(r.raw.total_hours) && (n.total_hours === null || n.total_hours < 0)) errs.push('Total hours must be a whole number');
        n.category = txt(r.raw.category) || null;
        n.is_lab = bool(r.raw.is_lab, false);
        if (n.is_lab === null) errs.push('Lab must be Yes or No');
        const existing = ctx.subjects.get(n.subject_code);
        if (existing && ctx.hodDepartmentId && existing.department_id !== ctx.hodDepartmentId) errs.push('This subject code belongs to another department');
        r.normalized = n; r.errors = errs;
      }
      dupes(rows, (r) => r.normalized.subject_code, 'Subject code');
    },
    async commit(client, ctx, rows) {
      let inserted = 0, updated = 0;
      const cats = new Map();
      for (const { normalized: n } of rows) {
        let categoryId = null;
        if (n.category) {
          const key = low(n.category);
          if (!cats.has(key)) {
            const c = await client.one(
              `INSERT INTO attendance.subject_categories (category_name) VALUES ($1)
               ON CONFLICT (category_name) DO UPDATE SET category_name = EXCLUDED.category_name RETURNING category_id`,
              [n.category]
            );
            cats.set(key, c.category_id);
          }
          categoryId = cats.get(key);
        }
        const res = await client.one(
          `INSERT INTO attendance.subjects (college_id, subject_code, subject_name, category_id, department_id, semester_no, credits, total_hours, is_lab)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (college_id, subject_code) DO UPDATE
             SET subject_name = EXCLUDED.subject_name, category_id = EXCLUDED.category_id, department_id = EXCLUDED.department_id,
                 semester_no = EXCLUDED.semester_no, credits = EXCLUDED.credits, total_hours = EXCLUDED.total_hours, is_lab = EXCLUDED.is_lab
           RETURNING (xmax = 0) AS inserted`,
          [ctx.collegeId, n.subject_code, n.subject_name, categoryId, n.department_id, n.semester_no, n.credits, n.total_hours, n.is_lab]
        );
        if (res.inserted) inserted++; else updated++;
      }
      return { inserted, updated };
    },
  },

  // ------------------------------------------------------------------ staff
  staff: {
    label: 'Staff', hodAllowed: true,
    columns: [
      { name: 'staff_code', required: true, aliases: ['employee_code', 'emp_code', 'staff_id', 'employee_id', 'emp_id', 'employee_no', 'emp_no', 'staff_no', 'id_no', 'code'], example: 'STF012' },
      { name: 'first_name', required: true, aliases: ['name', 'staff_name', 'firstname', 'name_of_the_staff', 'name_of_staff', 'name_of_the_faculty', 'name_of_faculty', 'faculty_name', 'employee_name'], example: 'Priya', note: 'The full name may go here; last_name is optional' },
      { name: 'last_name', aliases: ['lastname', 'surname', 'initial'], example: 'Raman' },
      { name: 'department_code', aliases: ['department', 'dept', 'dept_code', 'branch'], example: 'CSE', note: 'Code or full name. May be left out when the list is headed "Department of ..."' },
      { name: 'designation', aliases: ['position', 'post'], example: 'Assistant Professor' },
      { name: 'role', aliases: ['login_role'], example: 'staff', note: 'staff or hod. An hod row also makes the person HOD of the department' },
      { name: 'email', aliases: ['email_id', 'mail', 'e_mail', 'mail_id', 'email_address'], example: 'priya.raman@example.edu' },
      { name: 'mobile', aliases: ['phone', 'mobile_no', 'contact', 'mobile_number', 'phone_no', 'phone_number', 'contact_no', 'contact_number'], example: '9000000012' },
      { name: 'employee_type', aliases: ['type'], example: 'regular', note: 'regular, contract or visiting' },
      { name: 'joining_date', aliases: ['date_of_joining', 'doj'], example: '2019-06-10', note: 'YYYY-MM-DD or DD-MM-YYYY' },
      { name: 'username', aliases: ['login', 'user_name'], example: '', note: 'Optional. Defaults to the staff code in lower case' },
      { name: 'password', aliases: [], example: '', note: 'Optional. Defaults to the username. Must be changed at first login' },
    ],
    async validate(ctx, rows, client) {
      for (const r of rows) {
        const n = {}, errs = [];
        n.staff_code = up(need(r.raw, n, errs, 'staff_code', 'Staff code', 30));
        need(r.raw, n, errs, 'first_name', 'First name', 80);
        n.last_name = txt(r.raw.last_name) || null;
        department(ctx, r.raw, n, errs);
        n.designation = txt(r.raw.designation) || null;
        n.role = low(r.raw.role) || 'staff';
        if (!['staff', 'hod'].includes(n.role)) errs.push('Role must be staff or hod');
        if (n.role === 'hod' && ctx.hodDepartmentId) errs.push('Only the college admin can upload an HOD');
        n.email = low(r.raw.email) || null;
        if (n.email && !EMAIL.test(n.email)) errs.push('Email is not valid');
        n.mobile = txt(r.raw.mobile) || null;
        n.employee_type = low(r.raw.employee_type) || 'regular';
        if (!['regular', 'contract', 'visiting'].includes(n.employee_type)) errs.push('Employee type must be regular, contract or visiting');
        n.joining_date = txt(r.raw.joining_date) ? dateVal(r.raw.joining_date) : null;
        if (txt(r.raw.joining_date) && !n.joining_date) errs.push('Joining date is not a valid date');
        n.username = low(r.raw.username) || low(n.staff_code);
        n.password = txt(r.raw.password) || null;
        if (n.password && n.password.length < 8) errs.push('Password must be at least 8 characters');
        const existing = ctx.staff.get(n.staff_code);
        n.existing_staff_id = existing ? existing.staff_id : null;
        n.existing_user_id = existing ? existing.user_id : null;
        if (existing && ctx.hodDepartmentId && existing.department_id !== ctx.hodDepartmentId) errs.push('This staff code belongs to another department');
        r.normalized = n; r.errors = errs;
      }
      dupes(rows, (r) => r.normalized.staff_code, 'Staff code');
      dupes(rows, (r) => r.normalized.username, 'Username');
      dupes(rows, (r) => r.normalized.email, 'Email');
      dupes(rows.filter((r) => r.normalized.role === 'hod'), (r) => r.normalized.department_code, 'HOD for the department');
      await usernameClashes(ctx, client, rows, (r) => r.normalized.existing_user_id);
      await emailClashes(ctx, client, rows, (r) => r.normalized.existing_user_id);
    },
    async prepare(ctx, rows) {
      // Hash initial passwords before the transaction opens, so it stays short.
      const fresh = rows.filter((r) => !r.normalized.existing_staff_id);
      const hashes = await mapLimit(fresh, 8, (r) => hashPassword(r.normalized.password || r.normalized.username, { temporary: true }));
      fresh.forEach((r, i) => { r.hash = hashes[i]; });
    },
    async commit(client, ctx, rows) {
      let inserted = 0, updated = 0;
      const roleIds = { staff: await usersModel.roleId('staff', client), hod: await usersModel.roleId('hod', client) };
      for (const r of rows) {
        const n = r.normalized;
        let staffId = n.existing_staff_id;
        if (staffId) {
          await client.query(
            `UPDATE attendance.users SET first_name = $2, last_name = $3, email = COALESCE($4, email), mobile = COALESCE($5, mobile),
                    department_id = $6, role_id = $7 WHERE user_id = $1`,
            [n.existing_user_id, n.first_name, n.last_name, n.email, n.mobile, n.department_id, roleIds[n.role]]
          );
          await client.query(
            `UPDATE attendance.staff SET designation = COALESCE($2, designation), department_id = $3, employee_type = $4,
                    joining_date = COALESCE($5, joining_date) WHERE staff_id = $1`,
            [staffId, n.designation, n.department_id, n.employee_type, n.joining_date]
          );
          updated++;
        } else {
          const userId = await usersModel.insertUser(client, {
            username: n.username, password_hash: r.hash, role_id: roleIds[n.role], department_id: n.department_id,
            first_name: n.first_name, last_name: n.last_name, email: n.email, mobile: n.mobile, college_id: ctx.collegeId, must_change_password: true,
          });
          staffId = (await client.one(
            `INSERT INTO attendance.staff (user_id, staff_code, designation, department_id, employee_type, joining_date, college_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING staff_id`,
            [userId, n.staff_code, n.designation, n.department_id, n.employee_type, n.joining_date, ctx.collegeId]
          )).staff_id;
          inserted++;
        }
        if (n.role === 'hod') await client.query('UPDATE attendance.departments SET hod_staff_id = $2 WHERE department_id = $1', [n.department_id, staffId]);
      }
      return { inserted, updated };
    },
  },

  // ------------------------------------------------------------------ students
  students: {
    label: 'Students', hodAllowed: true,
    columns: [
      { name: 'register_no', required: true, aliases: ['register_number', 'reg_no', 'registration_no', 'registration_number', 'regno', 'reg_number', 'register_no_', 'roll_number_register_number'], example: 'RA2411003010001' },
      { name: 'full_name', required: true, aliases: ['name', 'student_name', 'name_of_the_student', 'name_of_student', 'student'], example: 'Asha Kumar' },
      { name: 'university_id', aliases: ['university_no', 'sis_id', 'student_id', 'univ_id', 'university_register_no'], example: '', note: 'The id the recognition pipeline uses for the student. Defaults to the register number' },
      // The class may be given in every row, or once in the heading above the list.
      ...SECTION_COLS.map((c) => ({ ...c, required: false, note: `${c.note ? c.note + '. ' : ''}May be left out when the heading above the list gives it` })),
      { name: 'roll_no', aliases: ['roll_number', 'roll'], example: '01' },
      { name: 'batch_year', aliases: ['batch', 'admission_year', 'year_of_admission'], example: '2024' },
      { name: 'admission_no', aliases: ['admission_number', 'adm_no'], example: '' },
      { name: 'gender', aliases: ['sex'], example: 'female', note: 'male, female or other' },
      { name: 'dob', aliases: ['date_of_birth', 'birth_date', 'd_o_b'], example: '2006-04-18', note: 'YYYY-MM-DD or DD-MM-YYYY' },
      { name: 'email', aliases: ['email_id', 'mail', 'e_mail', 'mail_id', 'student_email'], example: 'asha.kumar@example.edu' },
      { name: 'mobile', aliases: ['phone', 'mobile_no', 'contact', 'mobile_number', 'student_mobile', 'phone_no', 'contact_no'], example: '9000000101' },
      { name: 'father_name', aliases: ['father', 'father_s_name', 'fathers_name', 'name_of_father', 'parent_name'], example: 'Kumar R' },
      { name: 'father_mobile', aliases: ['father_s_mobile', 'father_mobile_no', 'father_phone', 'parent_mobile', 'parent_mobile_no', 'parent_contact', 'parent_phone'], example: '9000000201' },
      { name: 'mother_name', aliases: ['mother', 'mother_s_name', 'mothers_name', 'name_of_mother'], example: '' },
      { name: 'mother_mobile', aliases: ['mother_s_mobile', 'mother_mobile_no', 'mother_phone'], example: '' },
      { name: 'guardian_name', aliases: ['guardian', 'guardian_s_name'], example: '' },
      { name: 'guardian_mobile', aliases: ['guardian_s_mobile', 'guardian_mobile_no', 'guardian_phone'], example: '' },
      { name: 'parent_email', aliases: ['parent_email_id', 'parent_mail', 'father_email'], example: '' },
      { name: 'username', aliases: ['login', 'user_name'], example: '', note: 'Optional. Defaults to the register number in lower case' },
      { name: 'password', aliases: [], example: '', note: 'Optional. Defaults to the username. Must be changed at first login' },
    ],
    async validate(ctx, rows, client) {
      for (const r of rows) {
        const n = {}, errs = [];
        n.register_no = up(need(r.raw, n, errs, 'register_no', 'Register number', 40));
        n.university_id = up(r.raw.university_id) || n.register_no;
        if (n.university_id.length > 40) errs.push('University id is longer than 40 characters');
        need(r.raw, n, errs, 'full_name', 'Full name', 120);
        section(ctx, r.raw, n, errs, true);
        n.roll_no = txt(r.raw.roll_no) || null;
        n.batch_year = txt(r.raw.batch_year) ? int(r.raw.batch_year) : null;
        if (txt(r.raw.batch_year) && (n.batch_year === null || n.batch_year < 1990 || n.batch_year > 2100)) errs.push('Batch year is not valid');
        const g = low(r.raw.gender);
        n.gender = { m: 'male', f: 'female', male: 'male', female: 'female', other: 'other', o: 'other' }[g] || null;
        if (g && !n.gender) errs.push('Gender must be male, female or other');
        n.dob = txt(r.raw.dob) ? dateVal(r.raw.dob) : null;
        if (txt(r.raw.dob) && !n.dob) errs.push('Date of birth is not a valid date');
        n.email = low(r.raw.email) || null;
        if (n.email && !EMAIL.test(n.email)) errs.push('Email is not valid');
        n.mobile = txt(r.raw.mobile) || null;
        n.username = low(r.raw.username) || low(n.register_no);
        n.password = txt(r.raw.password) || null;
        if (n.password && n.password.length < 8) errs.push('Password must be at least 8 characters');
        n.admission_no = txt(r.raw.admission_no) || null;
        for (const k of ['father_name', 'mother_name', 'guardian_name', 'father_mobile', 'mother_mobile', 'guardian_mobile']) n[k] = txt(r.raw[k]).slice(0, 120) || null;
        n.parent_email = low(r.raw.parent_email) || null;
        if (n.parent_email && !EMAIL.test(n.parent_email)) errs.push('Parent email is not valid');
        n.has_parent = ['father_name', 'mother_name', 'guardian_name', 'father_mobile', 'mother_mobile', 'guardian_mobile', 'parent_email'].some((k) => n[k]);
        r.normalized = n; r.errors = errs;
      }
      dupes(rows, (r) => r.normalized.university_id, 'University id');
      dupes(rows, (r) => r.normalized.register_no, 'Register number');
      dupes(rows, (r) => r.normalized.username, 'Username');
      dupes(rows, (r) => r.normalized.email, 'Email');
      // university_id and register_no are unique across the whole group, not per college.
      const found = await client.many(
        `SELECT student_id, user_id, college_id, upper(university_id) AS university_id, upper(register_no) AS register_no
           FROM identity.students WHERE upper(university_id) = ANY($1) OR upper(register_no) = ANY($2)`,
        [rows.map((r) => r.normalized.university_id), rows.map((r) => r.normalized.register_no)]
      );
      const byUni = new Map(found.map((f) => [f.university_id, f]));
      const byReg = new Map(found.filter((f) => f.register_no).map((f) => [f.register_no, f]));
      for (const r of rows) {
        const n = r.normalized;
        const ex = byUni.get(n.university_id);
        n.existing_student_id = null; n.existing_user_id = null;
        if (ex) {
          if (ex.college_id && ex.college_id !== ctx.collegeId) r.errors.push('This university id belongs to a student of another college');
          else { n.existing_student_id = ex.student_id; n.existing_user_id = ex.user_id; }
        }
        const reg = byReg.get(n.register_no);
        if (reg && reg.university_id !== n.university_id) r.errors.push(`Register number ${n.register_no} already belongs to another student`);
      }
      await usernameClashes(ctx, client, rows, (r) => r.normalized.existing_user_id);
      await emailClashes(ctx, client, rows, (r) => r.normalized.existing_user_id);
    },
    async prepare(ctx, rows) {
      const fresh = rows.filter((r) => !r.normalized.existing_user_id);
      const hashes = await mapLimit(fresh, 8, (r) => hashPassword(r.normalized.password || r.normalized.username, { temporary: true }));
      fresh.forEach((r, i) => { r.hash = hashes[i]; });
    },
    async commit(client, ctx, rows) {
      let inserted = 0, updated = 0;
      const roleId = await usersModel.roleId('student', client);
      for (const r of rows) {
        const n = r.normalized;
        let userId = n.existing_user_id;
        if (userId) {
          await client.query(
            `UPDATE attendance.users SET first_name = $2, last_name = NULL, email = COALESCE($3, email), mobile = COALESCE($4, mobile), department_id = $5 WHERE user_id = $1`,
            [userId, n.full_name, n.email, n.mobile, n.department_id]
          );
        } else {
          userId = await usersModel.insertUser(client, {
            username: n.username, password_hash: r.hash, role_id: roleId, department_id: n.department_id,
            first_name: n.full_name, email: n.email, mobile: n.mobile, college_id: ctx.collegeId, must_change_password: true,
          });
        }
        if (n.existing_student_id) {
          await client.query(
            `UPDATE identity.students SET full_name = $2, register_no = $3, roll_no = COALESCE($4, roll_no), section_id = $5,
                    batch_year = COALESCE($6, batch_year), gender = COALESCE($7, gender), dob = COALESCE($8, dob), user_id = $9, college_id = $10,
                    admission_no = COALESCE($11, admission_no)
              WHERE student_id = $1`,
            [n.existing_student_id, n.full_name, n.register_no, n.roll_no, n.section_id, n.batch_year, n.gender, n.dob, userId, ctx.collegeId, n.admission_no]
          );
          updated++;
        } else {
          n.existing_student_id = (await client.one(
            `INSERT INTO identity.students (university_id, full_name, user_id, section_id, register_no, roll_no, batch_year, gender, dob, college_id, admission_no)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING student_id`,
            [n.university_id, n.full_name, userId, n.section_id, n.register_no, n.roll_no, n.batch_year, n.gender, n.dob, ctx.collegeId, n.admission_no]
          )).student_id;
          inserted++;
        }
        // Parent details: one row per student; blank cells keep what is already stored.
        if (n.has_parent) {
          const vals = [n.existing_student_id, n.father_name, n.mother_name, n.guardian_name, n.father_mobile, n.mother_mobile, n.guardian_mobile, n.parent_email];
          const upd = await client.query(
            `UPDATE attendance.student_parents SET father_name = COALESCE($2, father_name), mother_name = COALESCE($3, mother_name),
                    guardian_name = COALESCE($4, guardian_name), father_mobile = COALESCE($5, father_mobile), mother_mobile = COALESCE($6, mother_mobile),
                    guardian_mobile = COALESCE($7, guardian_mobile), email = COALESCE($8, email)
              WHERE parent_id = (SELECT min(parent_id) FROM attendance.student_parents WHERE student_id = $1)`, vals);
          if (!upd.rowCount) {
            await client.query(
              `INSERT INTO attendance.student_parents (student_id, father_name, mother_name, guardian_name, father_mobile, mother_mobile, guardian_mobile, email)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, vals);
          }
        }
      }
      return { inserted, updated };
    },
  },

  // ------------------------------------------------------------------ classrooms
  classrooms: {
    label: 'Classrooms', hodAllowed: false,
    columns: [
      { name: 'room_number', required: true, aliases: ['room', 'room_no', 'classroom', 'hall'], example: 'LH-201' },
      { name: 'block_name', aliases: ['block', 'building'], example: 'Tech Park' },
      { name: 'floor_no', aliases: ['floor'], example: '2' },
      { name: 'capacity', aliases: ['seats'], example: '70' },
      { name: 'has_cctv', aliases: ['camera', 'cctv'], example: 'Yes', note: 'Yes or No. Defaults to Yes' },
    ],
    async validate(ctx, rows) {
      for (const r of rows) {
        const n = {}, errs = [];
        n.room_number = up(need(r.raw, n, errs, 'room_number', 'Room number', 30));
        n.block_name = txt(r.raw.block_name) || null;
        n.floor_no = txt(r.raw.floor_no) ? int(r.raw.floor_no) : null;
        if (txt(r.raw.floor_no) && n.floor_no === null) errs.push('Floor must be a whole number');
        n.capacity = txt(r.raw.capacity) ? int(r.raw.capacity) : null;
        if (txt(r.raw.capacity) && (n.capacity === null || n.capacity < 0)) errs.push('Capacity must be a whole number');
        n.has_cctv = bool(r.raw.has_cctv, true);
        if (n.has_cctv === null) errs.push('Camera must be Yes or No');
        r.normalized = n; r.errors = errs;
      }
      dupes(rows, (r) => r.normalized.room_number && `${low(r.normalized.block_name)}|${r.normalized.room_number}`, 'Room');
    },
    async commit(client, ctx, rows) {
      let inserted = 0, updated = 0;
      for (const { normalized: n } of rows) {
        const res = await client.one(
          `INSERT INTO attendance.classrooms (college_id, room_number, block_name, floor_no, capacity, has_cctv)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (college_id, COALESCE(block_name, ''), room_number) DO UPDATE
             SET floor_no = EXCLUDED.floor_no, capacity = EXCLUDED.capacity, has_cctv = EXCLUDED.has_cctv
           RETURNING (xmax = 0) AS inserted`,
          [ctx.collegeId, n.room_number, n.block_name, n.floor_no, n.capacity, n.has_cctv]
        );
        if (res.inserted) inserted++; else updated++;
      }
      return { inserted, updated };
    },
  },

  // ------------------------------------------------------------------ sections
  sections: {
    label: 'Sections', hodAllowed: true,
    columns: [...SECTION_COLS, { name: 'strength', aliases: ['sanctioned_strength', 'intake'], example: '60' }],
    async validate(ctx, rows) {
      for (const r of rows) {
        const n = {}, errs = [];
        section(ctx, r.raw, n, errs, false);
        if (n.section && n.section.length > 10) errs.push('Section is longer than 10 characters');
        n.strength = txt(r.raw.strength) ? int(r.raw.strength) : 0;
        if (n.strength === null || n.strength < 0) errs.push('Strength must be a whole number');
        r.normalized = n; r.errors = errs;
      }
      dupes(rows, (r) => r.normalized.section && `${r.normalized.department_code}|${r.normalized.program_code}|${r.normalized.semester_no}|${r.normalized.section}`, 'Section');
    },
    async commit(client, ctx, rows) {
      let inserted = 0, updated = 0;
      for (const { normalized: n } of rows) {
        const res = await client.one(
          `INSERT INTO attendance.sections (department_id, program_id, academic_year_id, semester_id, section_name, strength)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (department_id, program_id, academic_year_id, semester_id, section_name) DO UPDATE SET strength = EXCLUDED.strength
           RETURNING (xmax = 0) AS inserted`,
          [n.department_id, n.program_id, ctx.activeYear.academic_year_id, n.semester_id, n.section, n.strength]
        );
        if (res.inserted) inserted++; else updated++;
      }
      return { inserted, updated };
    },
  },

  // ------------------------------------------------------------------ timetable
  timetable: {
    label: 'Timetable', hodAllowed: true, grid: true, classSheet: true, needsEffectiveFrom: true,
    columns: [
      ...SECTION_COLS,
      { name: 'year', aliases: ['year_of_study'], example: '2', note: 'Optional check: must equal the year of the semester' },
      { name: 'day', required: true, aliases: ['day_of_week', 'weekday'], example: 'Monday', note: 'Monday to Sunday, or 1 to 7 with 1 = Monday' },
      { name: 'period_no', required: true, aliases: ['period', 'hour', 'slot'], example: '1' },
      { name: 'subject_code', required: true, aliases: ['subject', 'course_code'], example: 'CS301', note: 'Subject code, or the short name used on the timetable (CN, AIML)' },
      { name: 'staff_code', aliases: ['staff', 'faculty', 'faculty_code', 'employee_code'], example: 'STF012', note: 'May be left blank when the subject is allocated to one staff member for the class' },
      { name: 'staff_name', aliases: ['staff_incharge', 'faculty_name'], example: '', note: 'Used when there is no staff code; matched against the staff master' },
      { name: 'room_number', aliases: ['room', 'classroom', 'hall', 'room_no', 'hall_no'], example: 'LH-201', note: 'May be left blank when the allocation gives the room' },
      { name: 'block_name', aliases: ['block', 'building'], example: '', note: 'Needed only when two blocks have the same room number' },
    ],
    async validate(ctx, rows, client) {
      for (const r of rows) {
        const n = {}, errs = [];
        const { sem, sec } = section(ctx, r.raw, n, errs, true);
        n.day = parseDay(r.raw.day);
        if (!n.day) errs.push('Day must be Monday to Sunday, or 1 to 7');
        const pno = int(r.raw.period_no !== undefined && /\d/.test(String(r.raw.period_no)) ? String(r.raw.period_no).match(/\d+/)[0] : r.raw.period_no);
        const period = pno !== null ? ctx.periods.get(pno) : null;
        n.period_no = pno;
        if (pno === null) errs.push('Period number is required');
        else if (!period) errs.push(`Period ${pno} is not set up`);
        n.period_id = period ? period.period_id : null;

        // Subject: by code, else by the short name allocated to this class, else a short name unique in the college.
        const scode = up(r.raw.subject_code);
        let subject = ctx.subjects.get(scode);
        if (!subject && scode) {
          const own = sec ? (ctx.sectionSubjects.get(sec.section_id) || []).filter((x) => up(x.short_name) === scode) : [];
          const anywhere = ctx.subjectsByShort.get(scode) || [];
          subject = own[0] || (anywhere.length === 1 ? anywhere[0] : null);
        }
        if (!scode) errs.push('Subject code is required');
        else if (!subject) errs.push(`Subject "${scode}" does not exist. Commit the subject and staff allocation for this class first.`);
        n.subject_code = subject ? subject.subject_code : scode;
        n.subject_id = subject ? subject.subject_id : null;

        // Staff: code, else name, else the one person the subject is allocated to for this class.
        const allocs = sec && subject ? ctx.allocations.get(`${sec.section_id}|${subject.subject_id}`) || [] : [];
        let { staff, problem } = findStaff(ctx, r.raw.staff_code, r.raw.staff_name);
        if (!staff && !problem && allocs.length === 1) staff = ctx.staffById.get(allocs[0].staff_id);
        if (problem) errs.push(problem);
        else if (!staff) {
          errs.push(txt(r.raw.staff_name)
            ? `Staff "${txt(r.raw.staff_name)}" is not in the staff master. Enter the staff code.`
            : 'Staff code is required, or allocate the subject to one staff member for this class');
        } else if (staff.status !== 'active') errs.push(`Staff "${staff.staff_code}" is not active`);
        n.staff_code = staff ? staff.staff_code : up(r.raw.staff_code);
        n.staff_id = staff ? staff.staff_id : null;

        // Room: the allocation's room for this staff member wins; else the row's own room.
        const alloc = staff ? allocs.find((x) => x.staff_id === staff.staff_id) : null;
        const room = up(r.raw.room_number);
        n.room_number = room;
        n.classroom_id = null;
        if (alloc && alloc.classroom_id) {
          n.classroom_id = alloc.classroom_id;
          n.room_number = (ctx.classroomsById.get(alloc.classroom_id) || {}).room_number || room;
        } else if (!room) errs.push('Room number is required');
        else {
          let hits = ctx.classrooms.get(room) || [];
          const block = low(r.raw.block_name);
          if (block) hits = hits.filter((h) => low(h.block_name) === block);
          if (!hits.length) errs.push(`Room "${room}" does not exist`);
          else if (hits.length > 1) errs.push(`Room "${room}" exists in more than one block; add block_name`);
          else n.classroom_id = hits[0].classroom_id;
        }
        n.sem_start = sem ? sem.start_date : null;
        n.sem_end = sem ? sem.end_date : null;
        r.normalized = n; r.errors = errs;
      }
      const slot = (n) => `${DAY_NAMES[n.day]} period ${n.period_no}`;
      // One section can have several classes in a period (lab batches, electives), but not the same one twice.
      dupes(rows, (r) => { const n = r.normalized; return n.section_id && n.day && n.period_id && n.subject_id && n.staff_id ? `${n.section_id}|${n.day}|${n.period_id}|${n.subject_id}|${n.staff_id}` : null; }, 'This class (section, day, period, subject and staff)');
      // A combined class is the same subject, staff member and room for several sections: not a clash.
      const combined = (a, b) => a.subject_id === b.subject_id && a.staff_id === b.staff_id && a.classroom_id === b.classroom_id && a.section_id !== b.section_id;
      const seenStaff = new Map(), seenRoom = new Map();
      for (const r of rows) {
        const n = r.normalized;
        if (!n.day || !n.period_id) continue;
        if (n.staff_id) {
          const k = `${n.staff_id}|${n.day}|${n.period_id}`;
          const first = seenStaff.get(k);
          if (first && !combined(first, n)) r.errors.push(`Staff ${n.staff_code} is booked twice on ${slot(n)} (also row ${first.row_no})`);
          else if (!first) seenStaff.set(k, { ...n, row_no: r.row_no });
        }
        if (n.classroom_id) {
          const k = `${n.classroom_id}|${n.day}|${n.period_id}`;
          const first = seenRoom.get(k);
          // The same section may split one room between two subjects; two sections may not share it unless combined.
          if (first && first.section_id !== n.section_id && !combined(first, n)) r.errors.push(`Room ${n.room_number} is booked twice on ${slot(n)} (also row ${first.row_no})`);
          else if (!first) seenRoom.set(k, { ...n, row_no: r.row_no });
        }
      }
      // Clashes with timetables of sections that are not in this file (those stay as they are).
      const sectionIds = [...new Set(rows.map((r) => r.normalized.section_id).filter(Boolean))];
      const existing = await client.many(
        `SELECT t.staff_id, t.classroom_id, t.subject_id, t.section_id, t.day_of_week, t.period_id, sem.start_date, sem.end_date,
                d.department_code || ' sem ' || sem.semester_no || ' ' || sec.section_name AS label
           FROM attendance.timetable t
           JOIN attendance.sections sec ON sec.section_id = t.section_id
           JOIN attendance.departments d ON d.department_id = sec.department_id
           JOIN attendance.semesters sem ON sem.semester_id = t.semester_id
          WHERE d.college_id = $1 AND NOT (t.section_id = ANY($2::int[]))
            AND (t.effective_to IS NULL OR t.effective_to >= $3)`,
        [ctx.collegeId, sectionIds, ctx.effectiveFrom]
      );
      const byStaff = new Map(), byRoom = new Map();
      for (const e of existing) {
        const a = `${e.staff_id}|${e.day_of_week}|${e.period_id}`, b = `${e.classroom_id}|${e.day_of_week}|${e.period_id}`;
        if (!byStaff.has(a)) byStaff.set(a, []);
        byStaff.get(a).push(e);
        if (!byRoom.has(b)) byRoom.set(b, []);
        byRoom.get(b).push(e);
      }
      const overlaps = (n, e) => n.sem_start && e.start_date <= n.sem_end && e.end_date >= n.sem_start;
      for (const r of rows) {
        const n = r.normalized;
        if (!n.day || !n.period_id) continue;
        const s = (byStaff.get(`${n.staff_id}|${n.day}|${n.period_id}`) || []).find((e) => overlaps(n, e) && !combined(e, n));
        if (s) r.errors.push(`Staff ${n.staff_code} already teaches ${s.label} on ${slot(n)}`);
        const c = (byRoom.get(`${n.classroom_id}|${n.day}|${n.period_id}`) || []).find((e) => overlaps(n, e) && !combined(e, n));
        if (c) r.errors.push(`Room ${n.room_number} is already used by ${c.label} on ${slot(n)}`);
      }
    },
    /** Replaces the whole timetable of every section in the file, from the effective-from date. */
    async commit(client, ctx, rows, batch, userId) {
      const from = ctx.effectiveFrom;
      const sectionIds = [...new Set(rows.map((r) => r.normalized.section_id))];
      const old = await client.many('SELECT * FROM attendance.timetable WHERE section_id = ANY($1::int[]) AND is_active FOR UPDATE', [sectionIds]);
      for (const slot of old) await timetableService.retire(client, slot, from);
      for (const { normalized: n } of rows) {
        const row = await client.one(
          `INSERT INTO attendance.timetable (academic_year_id, semester_id, section_id, subject_id, staff_id, classroom_id, day_of_week, period_id, effective_from)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING timetable_id`,
          [ctx.activeYear.academic_year_id, n.semester_id, n.section_id, n.subject_id, n.staff_id, n.classroom_id, n.day, n.period_id, from]
        );
        await client.query(
          `INSERT INTO attendance.timetable_history (timetable_id, modified_by, change_type, new_staff_id, new_subject_id, new_classroom_id)
           VALUES ($1, $2, 'imported', $3, $4, $5)`,
          [row.timetable_id, userId, n.staff_id, n.subject_id, n.classroom_id]
        );
      }
      return { inserted: rows.length, updated: old.length };
    },
  },

  // ------------------------------------------------------------------ subject and staff allocation
  allocation: {
    label: 'Subject and staff allocation', hodAllowed: true, classSheet: true,
    // Subject and staff first: those are the cells people fix in the preview.
    columns: [
      { name: 'subject_code', required: true, aliases: ['code', 'course_code'], example: 'CS3561' },
      { name: 'short_name', aliases: ['short', 'abbreviation', 'abbr', 'acronym'], example: 'CN', note: 'The name used in timetable cells' },
      { name: 'subject_name', aliases: ['subject', 'course_name', 'course_title'], example: 'Computer Networks', note: 'Needed when the subject is new' },
      { name: 'staff_name', aliases: ['staff_incharge', 'faculty', 'faculty_name'], example: '', note: 'Matched against the staff master, ignoring titles and the order of initials' },
      { name: 'staff_code', aliases: ['staff', 'faculty_code', 'employee_code'], example: 'CSE014', note: 'Staff code, or leave blank and give staff_name' },
      { name: 'room_number', aliases: ['room', 'hall', 'hall_no', 'lab'], example: '', note: 'Hall or lab for this subject, when it is not the class\'s own hall' },
      ...SECTION_COLS,
      { name: 'lecture_hours', aliases: ['l'], example: '4' },
      { name: 'tutorial_hours', aliases: ['t'], example: '0' },
      { name: 'practical_hours', aliases: ['p'], example: '0', note: 'More than 0 marks the subject as a lab' },
      { name: 'subject_department', aliases: ['offering_department'], example: 'CSE', note: 'Department that offers the subject. Defaults to the class\'s department' },
      { name: 'category', aliases: ['category_name', 'type'], example: '', note: 'For example Professional Elective - I' },
      { name: 'block_name', aliases: ['block', 'building'], example: '' },
    ],
    async validate(ctx, rows) {
      for (const r of rows) {
        const n = {}, errs = [];
        const { d, sec } = section(ctx, r.raw, n, errs, true);
        n.subject_code = up(need(r.raw, n, errs, 'subject_code', 'Subject code', 20));
        n.subject_name = txt(r.raw.subject_name) || null;
        n.short_name = up(r.raw.short_name) || null;
        const existing = ctx.subjects.get(n.subject_code);
        n.subject_id = existing ? existing.subject_id : null;
        if (!existing && !n.subject_name) errs.push(`Subject "${n.subject_code}" is new, so its name is required`);
        const dcode = up(r.raw.subject_department);
        const sd = dcode ? ctx.departments.get(dcode) : d;
        if (dcode && !sd) errs.push(`Department "${dcode}" does not exist`);
        n.subject_department_id = sd ? sd.department_id : null;
        for (const [k, label] of [['lecture_hours', 'L'], ['tutorial_hours', 'T'], ['practical_hours', 'P']]) {
          n[k] = txt(r.raw[k]) ? int(r.raw[k]) : null;
          if (txt(r.raw[k]) && (n[k] === null || n[k] < 0 || n[k] > 40)) errs.push(`${label} must be a whole number`);
        }
        n.category = txt(r.raw.category) || null;
        const { staff, problem } = findStaff(ctx, r.raw.staff_code, r.raw.staff_name);
        if (problem) errs.push(problem);
        else if (!staff) {
          errs.push(txt(r.raw.staff_name)
            ? `Staff "${txt(r.raw.staff_name)}" is not in the staff master. Enter the staff code, or add this person under staff first.`
            : 'Staff code or staff name is required');
        } else if (staff.status !== 'active') errs.push(`Staff "${staff.staff_code}" is not active`);
        n.staff_id = staff ? staff.staff_id : null;
        n.staff_code = staff ? staff.staff_code : up(r.raw.staff_code);
        n.classroom_id = null;
        const room = up(r.raw.room_number);
        if (room) {
          let hits = ctx.classrooms.get(room) || [];
          const block = low(r.raw.block_name);
          if (block) hits = hits.filter((h) => low(h.block_name) === block);
          if (!hits.length) errs.push(`Room "${room}" does not exist`);
          else if (hits.length > 1) errs.push(`Room "${room}" exists in more than one block; add block_name`);
          else n.classroom_id = hits[0].classroom_id;
        }
        n.section_semester_no = sec ? n.semester_no : null;
        r.normalized = n; r.errors = errs;
      }
      dupes(rows, (r) => { const n = r.normalized; return n.section_id && n.subject_code && n.staff_id ? `${n.section_id}|${n.subject_code}|${n.staff_id}` : null; }, 'This subject and staff member for the class');
      // A short name must point at one subject within a class.
      const shorts = new Map();
      for (const r of rows) {
        const n = r.normalized;
        if (!n.section_id || !n.short_name) continue;
        const k = `${n.section_id}|${n.short_name}`;
        if (shorts.has(k) && shorts.get(k) !== n.subject_code) r.errors.push(`Short name ${n.short_name} is used for two subjects of this class`);
        else shorts.set(k, n.subject_code);
      }
    },
    /** Replaces the allocation of every class in the file; creates or updates the subjects it names. */
    async commit(client, ctx, rows) {
      const cats = new Map(), subjectIds = new Map();
      for (const { normalized: n } of rows) {
        if (subjectIds.has(n.subject_code)) continue;
        let categoryId = null;
        if (n.category) {
          const key = low(n.category);
          if (!cats.has(key)) {
            cats.set(key, (await client.one(
              `INSERT INTO attendance.subject_categories (category_name) VALUES ($1)
               ON CONFLICT (category_name) DO UPDATE SET category_name = EXCLUDED.category_name RETURNING category_id`, [n.category])).category_id);
          }
          categoryId = cats.get(key);
        }
        const row = await client.one(
          `INSERT INTO attendance.subjects (college_id, subject_code, subject_name, short_name, category_id, department_id, semester_no,
                                            lecture_hours, tutorial_hours, practical_hours, is_lab)
           VALUES ($1, $2, COALESCE($3, $2), $4, $5, $6, $7, $8, $9, $10, COALESCE($10, 0) > 0)
           ON CONFLICT (college_id, subject_code) DO UPDATE
             SET subject_name = COALESCE($3, attendance.subjects.subject_name),
                 short_name = COALESCE($4, attendance.subjects.short_name),
                 category_id = COALESCE($5, attendance.subjects.category_id),
                 lecture_hours = COALESCE($8, attendance.subjects.lecture_hours),
                 tutorial_hours = COALESCE($9, attendance.subjects.tutorial_hours),
                 practical_hours = COALESCE($10, attendance.subjects.practical_hours),
                 is_lab = CASE WHEN $10 IS NULL THEN attendance.subjects.is_lab ELSE $10 > 0 END
           RETURNING subject_id`,
          [ctx.collegeId, n.subject_code, n.subject_name, n.short_name, categoryId, n.subject_department_id, n.section_semester_no,
            n.lecture_hours, n.tutorial_hours, n.practical_hours]
        );
        subjectIds.set(n.subject_code, row.subject_id);
      }
      const sectionIds = [...new Set(rows.map((r) => r.normalized.section_id))];
      const removed = await client.query('DELETE FROM attendance.staff_subjects WHERE section_id = ANY($1::int[])', [sectionIds]);
      for (const { normalized: n } of rows) {
        // academic_year_id and semester_id are filled from the section by a trigger.
        await client.query(
          `INSERT INTO attendance.staff_subjects (staff_id, subject_id, academic_year_id, semester_id, section_id, classroom_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [n.staff_id, subjectIds.get(n.subject_code), ctx.activeYear.academic_year_id, n.semester_id, n.section_id, n.classroom_id]
        );
      }
      return { inserted: rows.length, updated: removed.rowCount };
    },
  },

  // ------------------------------------------------------------------ elective choices
  electives: {
    label: 'Elective choices', hodAllowed: true,
    columns: [
      { name: 'register_no', required: true, aliases: ['register_number', 'reg_no', 'regno', 'university_id'], example: 'RA2411003010001' },
      { name: 'subject_code', required: true, aliases: ['subject', 'course_code', 'elective'], example: 'PIT202', note: 'Subject code or short name of the elective the student takes' },
    ],
    async validate(ctx, rows, client) {
      const found = await client.many(
        `SELECT s.student_id, upper(s.register_no) AS register_no, s.section_id, sec.semester_id, sec.department_id
           FROM identity.students s JOIN attendance.sections sec ON sec.section_id = s.section_id
          WHERE s.college_id = $1 AND upper(s.register_no) = ANY($2)`,
        [ctx.collegeId, rows.map((r) => up(r.raw.register_no))]
      );
      const students = new Map(found.map((f) => [f.register_no, f]));
      for (const r of rows) {
        const n = {}, errs = [];
        n.register_no = up(need(r.raw, n, errs, 'register_no', 'Register number', 40));
        const st = students.get(n.register_no);
        if (n.register_no && !st) errs.push(`Student ${n.register_no} does not exist or has no section`);
        else if (st && ctx.hodDepartmentId && st.department_id !== ctx.hodDepartmentId) errs.push('You can upload only for your own department');
        const scode = up(r.raw.subject_code);
        let subject = ctx.subjects.get(scode);
        if (!subject && scode && st) subject = (ctx.sectionSubjects.get(st.section_id) || []).find((x) => up(x.short_name) === scode);
        if (!scode) errs.push('Subject code is required');
        else if (!subject) errs.push(`Subject "${scode}" does not exist`);
        Object.assign(n, { student_id: st ? st.student_id : null, section_id: st ? st.section_id : null, semester_id: st ? st.semester_id : null, subject_id: subject ? subject.subject_id : null, subject_code: subject ? subject.subject_code : scode });
        r.normalized = n; r.errors = errs;
      }
      dupes(rows, (r) => (r.normalized.student_id && r.normalized.subject_id ? `${r.normalized.student_id}|${r.normalized.subject_id}` : null), 'This student and subject');
    },
    /** The file lists everyone who takes each elective in it: earlier choices for those subjects and classes are replaced. */
    async commit(client, ctx, rows) {
      const removed = await client.query(
        `DELETE FROM attendance.student_subjects e USING identity.students s
          WHERE s.student_id = e.student_id AND e.subject_id = ANY($1::bigint[]) AND s.section_id = ANY($2::int[])`,
        [[...new Set(rows.map((r) => r.normalized.subject_id))], [...new Set(rows.map((r) => r.normalized.section_id))]]
      );
      for (const { normalized: n } of rows) {
        await client.query(
          `INSERT INTO attendance.student_subjects (student_id, subject_id, semester_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [n.student_id, n.subject_id, n.semester_id]
        );
      }
      return { inserted: rows.length, updated: removed.rowCount };
    },
  },
};

const ORDER = ['departments', 'classrooms', 'staff', 'subjects', 'sections', 'students', 'allocation', 'timetable', 'electives'];

module.exports = { specs, ORDER, up, low, txt, int, bool, dateVal, nameKey, codeKey, findStaff };
