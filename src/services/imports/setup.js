'use strict';
// "Set up what is missing" for a class timetable sheet.
// A sheet can name a programme, a section, halls, hours and staff that the college has not
// entered yet. plan() lists them; apply() creates the ones the admin confirms, so the
// preview's "does not exist" errors can be cleared in one step instead of screen by screen.
const db = require('../../config/db');
const imports = require('./index');
const usersModel = require('../../models/users');
const { up, low, txt, int, codeKey, findStaff } = require('./specs');
const { hashPassword } = require('../../utils/crypto');
const { invalid } = require('../../utils/errors');

const TITLE = /^(ms|mrs|mr|dr|prof|miss|er)\b\.?\s*/i;
/** "Ms.S.Balaswathy" -> "S. Balaswathy" */
const personName = (name) => txt(name).replace(TITLE, '').replace(/\.(?=\S)/g, '. ').replace(/\s+/g, ' ').trim();

async function rawRows(batchId) {
  return batchId ? (await db.many('SELECT raw FROM attendance.import_rows WHERE batch_id = $1 ORDER BY row_no', [batchId])).map((r) => r.raw) : [];
}

/** What the sheet needs that the college does not have yet. */
async function plan(scope, batchId) {
  const batch = await imports.getBatch(scope, batchId);
  const out = { batch, departments: [], programs: [], sections: [], rooms: [], periods: [], staff: [], blockers: [], warnings: [], count: 0 };
  if (batch.layout !== 'class_sheet' || batch.status !== 'validated') return out;
  const alloc = await rawRows(batch.import_type === 'allocation' ? batch.batch_id : batch.linked_batch_id);
  const grid = await rawRows(batch.import_type === 'timetable' ? batch.batch_id : batch.linked_batch_id);
  const all = [...alloc, ...grid];
  const ctx = await imports.loadContext(db, batch);
  let meta = {};
  try { meta = JSON.parse(batch.message || '{}'); } catch { /* an older upload without the header kept */ }

  const seen = new Set();
  const once = (list, key, item) => { if (!seen.has(key)) { seen.add(key); list.push(item); } };
  if (!ctx.activeYear) out.blockers.push('No academic year is set up. Add one under Academic setup and mark it active.');
  for (const r of all) {
    const d = up(r.department_code), p = up(r.program_code), semNo = int(r.semester_no), sec = up(r.section);
    for (const code of [d, up(r.subject_department)]) {
      if (code && !ctx.departments.get(code)) once(out.departments, `d|${code}`, { code });
    }
    if (p && !ctx.programs.get(codeKey(p))) once(out.programs, `p|${codeKey(p)}`, { code: p });
    const sem = semNo !== null ? ctx.semesters.get(semNo) : null;
    if (ctx.activeYear && semNo !== null && !sem) {
      once(out.blockers, `s|${semNo}`, `Semester ${semNo} is not set up in academic year ${ctx.activeYear.label}. Add it under Academic setup > Semesters.`);
    }
    if (d && p && semNo !== null && sec) {
      const dep = ctx.departments.get(d), prog = ctx.programs.get(codeKey(p));
      const exists = dep && prog && sem && ctx.sections.get(`${dep.department_id}|${prog.program_id}|${sem.semester_id}|${sec}`);
      if (!exists) once(out.sections, `c|${d}|${codeKey(p)}|${semNo}|${sec}`, { department_code: d, program_code: p, semester_no: semNo, section: sec });
    }
    const room = up(r.room_number);
    if (room && !(ctx.classrooms.get(room) || []).length) once(out.rooms, `r|${room}`, { room_number: room });
    const pno = int(r.period_no);
    if (pno !== null && !ctx.periods.get(pno)) {
      const t = (meta.periods || []).find((x) => x.no === pno) || {};
      once(out.periods, `h|${pno}`, { period_no: pno, start: t.start || null, end: t.end || null });
    }
  }
  // Staff named on the sheet who are not in the staff master, with a suggested code per department.
  const next = new Map();
  const suggest = (dept) => {
    if (!next.has(dept)) {
      let max = 0, width = 3;
      for (const code of ctx.staff.keys()) {
        const m = code.match(new RegExp(`^${dept.replace(/[^A-Z0-9]/g, '')}(\\d+)$`));
        if (m) { max = Math.max(max, parseInt(m[1], 10)); width = Math.max(width, m[1].length); }
      }
      next.set(dept, { n: max, width });
    }
    const s = next.get(dept);
    s.n += 1;
    return `${dept}${String(s.n).padStart(s.width, '0')}`;
  };
  for (const r of alloc) {
    if (up(r.staff_code) || !txt(r.staff_name)) continue;
    if (findStaff(ctx, '', r.staff_name).staff) continue;
    const dept = up(r.subject_department) || up(r.department_code);
    once(out.staff, `f|${personName(r.staff_name).toLowerCase()}`, {
      sheet_name: txt(r.staff_name), name: personName(r.staff_name), designation: txt(r.staff_designation), department_code: dept,
      placeholder: /^new\s+staff/i.test(txt(r.staff_name)),
    });
  }
  out.staff.sort((a, b) => a.department_code.localeCompare(b.department_code) || a.name.localeCompare(b.name));
  for (const f of out.staff) f.suggested_code = suggest(f.department_code);
  // Attendance uses the college's own hour timings, so say when the sheet disagrees with them.
  const differ = (meta.periods || []).filter((h) => {
    const have = ctx.periods.get(h.no);
    return have && h.start && h.end && (String(have.start_time).slice(0, 5) !== h.start || String(have.end_time).slice(0, 5) !== h.end);
  });
  if (differ.length) {
    const h = differ[0], have = ctx.periods.get(h.no);
    out.warnings.push(`The hour timings on the sheet differ from the college's periods for ${differ.length} ${differ.length === 1 ? 'hour' : 'hours'} (period ${h.no}: ${h.start} to ${h.end} on the sheet, ${String(have.start_time).slice(0, 5)} to ${String(have.end_time).slice(0, 5)} in Academic setup). Attendance follows Academic setup > Periods; correct them there if the sheet is right.`);
  }
  out.periods.sort((a, b) => a.period_no - b.period_no);
  out.count = out.departments.length + out.programs.length + out.sections.length + out.rooms.length + out.periods.length + out.staff.length;
  return out;
}

const on = (v) => v === 'on' || v === true || v === 'true' || v === '1';

/**
 * Create what the admin ticked. body:
 *   department_name[CODE], program_name[CODE], program_years[CODE],
 *   create_sections, create_rooms, create_periods,
 *   staff[i][create], staff[i][code], staff[i][designation]   (i follows plan().staff)
 */
async function apply(scope, userId, batchId, body) {
  const p = await plan(scope, batchId);
  const b = body || {};
  const made = { departments: 0, programs: 0, sections: 0, rooms: 0, periods: 0, staff: 0 };
  const collegeId = p.batch.college_id;

  // Staff: check the codes before anything is written, and hash outside the transaction.
  const staff = [];
  const taken = new Set();
  for (let i = 0; i < p.staff.length; i++) {
    const f = (b.staff && b.staff[i]) || {};
    if (!on(f.create)) continue;
    const code = up(f.code || p.staff[i].suggested_code);
    if (!/^[A-Z0-9._-]{2,30}$/.test(code)) throw invalid(`Staff code for ${p.staff[i].name} must be 2 to 30 letters or digits.`);
    if (taken.has(code)) throw invalid(`Staff code ${code} is used twice in this form.`);
    taken.add(code);
    staff.push({ ...p.staff[i], code, designation: txt(f.designation) || p.staff[i].designation || null });
  }
  if (staff.length) {
    const clash = await db.many(
      `SELECT upper(st.staff_code) AS code FROM attendance.staff st WHERE st.college_id = $1 AND upper(st.staff_code) = ANY($2)
       UNION SELECT upper(u.username) FROM attendance.users u WHERE u.college_id = $1 AND upper(u.username) = ANY($2)`,
      [collegeId, staff.map((s) => s.code)]);
    if (clash.length) throw invalid(`Staff code ${clash[0].code} is already in use. Choose another.`);
  }
  for (const s of staff) s.hash = await hashPassword(low(s.code), { temporary: true });

  await db.tx(async (c) => {
    for (const d of p.departments) {
      const name = txt((b.department_name || {})[d.code]) || d.code;
      await c.query('INSERT INTO attendance.departments (college_id, department_code, department_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [collegeId, d.code, name]);
      made.departments++;
    }
    for (const g of p.programs) {
      const name = txt((b.program_name || {})[g.code]) || g.code;
      const years = Math.min(Math.max(parseInt((b.program_years || {})[g.code], 10) || 4, 1), 8);
      await c.query('INSERT INTO attendance.programs (college_id, program_code, program_name, duration_years) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [collegeId, g.code, name, years]);
      made.programs++;
    }
    if (on(b.create_rooms)) {
      for (const r of p.rooms) {
        await c.query('INSERT INTO attendance.classrooms (college_id, room_number) VALUES ($1, $2) ON CONFLICT DO NOTHING', [collegeId, r.room_number]);
        made.rooms++;
      }
    }
    if (on(b.create_periods)) {
      for (const h of p.periods.filter((x) => x.start && x.end && x.end > x.start)) {
        const mins = (t) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);
        await c.query(
          'INSERT INTO attendance.periods (college_id, period_no, start_time, end_time, duration_minutes) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
          [collegeId, h.period_no, h.start, h.end, mins(h.end) - mins(h.start)]);
        made.periods++;
      }
    }
    if (on(b.create_sections)) {
      for (const s of p.sections) {
        // Needs its department, programme and semester; anything still missing leaves the section for later.
        const r = await c.query(
          `INSERT INTO attendance.sections (department_id, program_id, academic_year_id, semester_id, section_name)
           SELECT d.department_id, pr.program_id, ay.academic_year_id, sem.semester_id, $5
             FROM attendance.departments d, attendance.programs pr, attendance.academic_years ay, attendance.semesters sem
            WHERE d.college_id = $1 AND upper(d.department_code) = $2
              AND pr.college_id = $1 AND regexp_replace(upper(pr.program_code), '[^A-Z0-9]', '', 'g') = $3
              AND ay.academic_year_id = (SELECT academic_year_id FROM attendance.academic_years WHERE college_id = $1 ORDER BY is_active DESC, start_date DESC LIMIT 1)
              AND sem.academic_year_id = ay.academic_year_id AND sem.semester_no = $4
           ON CONFLICT DO NOTHING`,
          [collegeId, s.department_code, codeKey(s.program_code), s.semester_no, s.section]);
        made.sections += r.rowCount;
      }
    }
    const roleId = staff.length ? await usersModel.roleId('staff', c) : null;
    for (const s of staff) {
      const dep = await c.one('SELECT department_id FROM attendance.departments WHERE college_id = $1 AND upper(department_code) = $2', [collegeId, s.department_code]);
      if (!dep) throw invalid(`Department ${s.department_code} does not exist, so ${s.name} cannot be added.`);
      const uid = await usersModel.insertUser(c, {
        username: low(s.code), password_hash: s.hash, role_id: roleId, department_id: dep.department_id,
        first_name: s.name, college_id: collegeId, must_change_password: true,
      });
      await c.query(
        'INSERT INTO attendance.staff (user_id, staff_code, designation, department_id, college_id) VALUES ($1, $2, $3, $4, $5)',
        [uid, s.code, s.designation, dep.department_id, collegeId]);
      made.staff++;
    }
  });
  return { batch: p.batch, made };
}

module.exports = { plan, apply, personName };
