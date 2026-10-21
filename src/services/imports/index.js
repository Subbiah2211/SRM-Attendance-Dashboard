'use strict';
// Upload -> parse -> validate -> preview -> commit. Nothing reaches the live tables
// until commit, and a commit writes every row or none.
const fs = require('fs');
const ExcelJS = require('exceljs');
const db = require('../../config/db');
const settings = require('../settings');
const excel = require('../../importers/excel');
const pdf = require('../../importers/pdf');
const matrixParser = require('../../importers/matrix');
const classSheet = require('../../importers/classSheet');
const { specs, ORDER, up, nameKey, codeKey } = require('./specs');
const { Where } = require('../../utils/sql');
const { HttpError, notFound, forbidden, invalid } = require('../../utils/errors');
const { todayIn, addDays, isDate } = require('../../utils/dates');

function allowedTypes(scope) {
  return ORDER.filter((t) => scope.role !== 'hod' || specs[t].hodAllowed).map((t) => ({ key: t, label: specs[t].label, grid: !!specs[t].grid }));
}
function spec(type) {
  if (!specs[type]) throw invalid('Choose what the file contains.');
  return specs[type];
}

// ------------------------------------------------------------------ parsing
/** A class timetable sheet (grid plus subject table) in a PDF or Excel file, or null. */
async function readClassSheets(filePath, kind) {
  const sheets = kind === 'pdf'
    ? (await pdf.readItems(filePath)).map((items) => classSheet.fromPdfItems(items))
    : (await excel.readSheets(filePath)).map((sh) => classSheet.fromMatrix(sh.matrix));
  const found = sheets.filter((x) => x && x.cells.length && x.legend.length);
  if (!found.length) return null;
  const rows = found.map((sh) => classSheet.toRows(sh));
  const number = (list) => list.map((r, i) => ({ row_no: i + 1, raw: r.raw, uncertain: !!r.uncertain }));
  return {
    meta: found[0].meta, sheets: found.length, periods: found[0].periods,
    allocation: number(rows.flatMap((r) => r.allocation)),
    timetable: number(rows.flatMap((r) => r.timetable)),
  };
}

async function parseFile(filePath, kind, type, maxRows) {
  const s = spec(type);
  if (s.classSheet) {
    const sheet = await readClassSheets(filePath, kind);
    if (sheet) {
      if (sheet[type].length > maxRows) throw new HttpError(413, 'too_many_rows', `The file has ${sheet[type].length} rows; the limit is ${maxRows}.`);
      return { layout: 'class_sheet', rows: sheet[type], sheet };
    }
  }
  let parsed = [];
  if (kind === 'xlsx') {
    const sheets = await excel.readSheets(filePath, maxRows);
    for (const sh of sheets) {
      const t = matrixParser.fromTable(sh.matrix, s.columns) || (s.grid ? matrixParser.fromGrid(sh.matrix) : null);
      if (t) parsed.push(t);
    }
  } else {
    const { matrix, uncertain } = await pdf.readMatrix(filePath, s.columns, !!s.grid);
    const t = matrixParser.fromTable(matrix, s.columns, uncertain) || (s.grid ? matrixParser.fromGrid(matrix, uncertain) : null);
    if (t) parsed.push(t);
  }
  // A list printed for one class or one department says so in its heading, not in every row.
  const names = new Set(s.columns.map((c) => c.name));
  for (const t of parsed) {
    const meta = t.meta || {};
    const fill = ['department_code', 'program_code', 'semester_no', 'section'].filter((k) => names.has(k) && meta[k]);
    for (const r of t.rows) for (const k of fill) if (!String(r.raw[k] || '').trim()) r.raw[k] = meta[k];
    t.missing = (t.missing || []).filter((k) => !meta[k]);
  }
  parsed = parsed.filter((p) => p.rows.length || p.missing.length);
  if (!parsed.length) {
    throw new HttpError(422, 'no_table_found',
      `No ${s.label.toLowerCase()} table was found in the file. The header row must use the template's column names` +
      (s.grid ? ', or the sheet must be a timetable grid with a "Day" header row.' : '.'));
  }
  const missing = [...new Set(parsed.flatMap((p) => p.missing))];
  if (missing.length) throw new HttpError(422, 'columns_missing', `These required columns are missing: ${missing.join(', ')}.`);
  const rows = parsed.flatMap((p) => p.rows);
  if (!rows.length) throw new HttpError(422, 'no_rows', 'The file has a header but no data rows.');
  if (rows.length > maxRows) throw new HttpError(413, 'too_many_rows', `The file has ${rows.length} rows; the limit is ${maxRows}.`);
  return { layout: parsed[0].layout, rows: rows.map((r, i) => ({ row_no: i + 1, raw: r.raw, uncertain: !!r.uncertain })) };
}

// ------------------------------------------------------------------ lookups for validation
async function loadContext(client, batch) {
  const cid = batch.college_id;
  const map = (rows, keyFn) => new Map(rows.map((r) => [keyFn(r), r]));
  const activeYear = await client.one(
    'SELECT * FROM attendance.academic_years WHERE college_id = $1 ORDER BY is_active DESC, start_date DESC LIMIT 1', [cid]);
  const yearId = activeYear ? activeYear.academic_year_id : 0;
  // One at a time: these run on a single connection, often inside a transaction.
  const departments = await client.many('SELECT * FROM attendance.departments WHERE college_id = $1', [cid]);
  const programs = await client.many('SELECT * FROM attendance.programs WHERE college_id = $1', [cid]);
  const semesters = await client.many('SELECT * FROM attendance.semesters WHERE academic_year_id = $1', [yearId]);
  const sections = await client.many('SELECT * FROM attendance.sections WHERE academic_year_id = $1', [yearId]);
  const subjects = await client.many('SELECT * FROM attendance.subjects WHERE college_id = $1', [cid]);
  const staff = await client.many(
    `SELECT st.*, btrim(concat_ws(' ', u.first_name, u.last_name)) AS full_name
       FROM attendance.staff st JOIN attendance.users u ON u.user_id = st.user_id WHERE st.college_id = $1`, [cid]);
  const allocated = await client.many(
    `SELECT a.section_id, a.subject_id, a.staff_id, a.classroom_id
       FROM attendance.staff_subjects a WHERE a.academic_year_id = $1 AND a.section_id IS NOT NULL`, [yearId]);
  const classrooms = await client.many('SELECT * FROM attendance.classrooms WHERE college_id = $1', [cid]);
  const periods = await client.many('SELECT * FROM attendance.periods WHERE college_id = $1', [cid]);
  const rooms = new Map();
  for (const c of classrooms) {
    const k = up(c.room_number);
    if (!rooms.has(k)) rooms.set(k, []);
    rooms.get(k).push(c);
  }
  const group = (list, keyFn) => {
    const m = new Map();
    for (const x of list) {
      const k = keyFn(x);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(x);
    }
    return m;
  };
  const subjectsById = map(subjects, (r) => r.subject_id);
  return {
    // Staff by name: titles dropped and name parts sorted, so "Ms.S.Balaswathy" finds "Balaswathy S".
    staffByName: group(staff, (r) => nameKey(r.full_name)),
    staffByLooseName: group(staff, (r) => nameKey(r.full_name, true)),
    staffById: map(staff, (r) => r.staff_id),
    subjectsByShort: group(subjects, (r) => up(r.short_name)),
    classroomsById: map(classrooms, (r) => r.classroom_id),
    // This academic year's allocation: who teaches a subject to a class, and where.
    allocations: group(allocated, (r) => `${r.section_id}|${r.subject_id}`),
    sectionSubjects: group(allocated.map((a) => ({ section_id: a.section_id, ...(subjectsById.get(a.subject_id) || {}) })), (r) => r.section_id),
    collegeId: cid,
    hodDepartmentId: batch.department_id || null,
    effectiveFrom: batch.effective_from,
    activeYear,
    departments: map(departments, (r) => up(r.department_code)),
    departmentsByName: map(departments, (r) => codeKey(r.department_name)),
    programs: map(programs, (r) => codeKey(r.program_code)),
    semesters: map(semesters, (r) => r.semester_no),
    sections: map(sections, (r) => `${r.department_id}|${r.program_id}|${r.semester_id}|${up(r.section_name)}`),
    subjects: map(subjects, (r) => up(r.subject_code)),
    staff: map(staff, (r) => up(r.staff_code)),
    classrooms: rooms,
    periods: map(periods, (r) => r.period_no),
  };
}

/** Validate every row of a batch and store the result. Returns the rows (with normalized values). */
async function validateBatch(client, batch) {
  const s = spec(batch.import_type);
  const rows = await client.many('SELECT row_id, row_no, raw, uncertain FROM attendance.import_rows WHERE batch_id = $1 ORDER BY row_no', [batch.batch_id]);
  const ctx = await loadContext(client, batch);
  await s.validate(ctx, rows, client);
  const payload = rows.map((r) => ({
    row_id: r.row_id, normalized: r.normalized, status: r.errors.length ? 'invalid' : 'valid', errors: [...new Set(r.errors)],
  }));
  await client.query(
    `UPDATE attendance.import_rows r SET normalized = v.normalized, status = v.status, errors = v.errors
       FROM jsonb_to_recordset($1::jsonb) AS v(row_id bigint, normalized jsonb, status text, errors jsonb)
      WHERE r.row_id = v.row_id`,
    [JSON.stringify(payload)]
  );
  const bad = payload.filter((p) => p.status === 'invalid').length;
  await client.query(
    `UPDATE attendance.import_batches SET status = 'validated', total_rows = $2, valid_rows = $3, error_rows = $4 WHERE batch_id = $1`,
    [batch.batch_id, rows.length, rows.length - bad, bad]
  );
  return { rows, ctx, errorRows: bad };
}

// ------------------------------------------------------------------ the five steps
async function createBatch(scope, userId, { type, file, effectiveFrom }) {
  const s = spec(type);
  const cleanup = () => fs.promises.unlink(file.path).catch(() => {});
  try {
    if (scope.role === 'hod' && !s.hodAllowed) throw forbidden(`Only the college admin can upload ${s.label.toLowerCase()}.`);
    const maxMb = await settings.get(scope.collegeId, 'import_max_mb', 10);
    const maxRows = await settings.get(scope.collegeId, 'import_max_rows', 5000);
    if (file.size > maxMb * 1024 * 1024) throw new HttpError(413, 'file_too_large', `The file is larger than ${maxMb} MB.`);
    let from = null;
    if (s.needsEffectiveFrom) {
      const today = todayIn(scope.timezone);
      from = effectiveFrom || addDays(today, 1);
      if (!isDate(from) || from < today) throw invalid('Effective-from date must be today or later.');
    }
    const parsed = await parseFile(file.path, file.kind, type, maxRows);
    if (parsed.sheet) {
      // The sheet names its academic year; refuse it for another year rather than load it into the wrong one.
      const active = await db.one('SELECT label, start_date FROM attendance.academic_years WHERE college_id = $1 ORDER BY is_active DESC, start_date DESC LIMIT 1', [scope.collegeId]);
      const y = parsed.sheet.meta.year_start;
      if (active && y && parseInt(active.start_date.slice(0, 4), 10) !== y) {
        throw invalid(`The sheet is for academic year ${y}-${y + 1}, but this college's active academic year is ${active.label}. Make that year active first.`);
      }
      if (s.needsEffectiveFrom && !effectiveFrom && parsed.sheet.meta.effective_from && parsed.sheet.meta.effective_from >= todayIn(scope.timezone)) from = parsed.sheet.meta.effective_from;
    }
    const insertBatch = async (c, batchType, rows, effective) => {
      const batch = await c.one(
        `INSERT INTO attendance.import_batches (college_id, department_id, import_type, file_name, storage_ref, file_type, layout, effective_from, uploaded_by, message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        // For a class sheet, keep what the header said (hall, hour timings): the set-up step uses it.
        [scope.collegeId, scope.role === 'hod' ? scope.departmentId : null, batchType, file.originalname.slice(0, 200), file.filename, file.kind, parsed.layout, effective, userId,
          parsed.sheet ? JSON.stringify({ hall: parsed.sheet.meta.hall || null, periods: parsed.sheet.periods || [] }) : null]
      );
      await c.query(
        `INSERT INTO attendance.import_rows (batch_id, row_no, raw, uncertain)
         SELECT $1, v.row_no, v.raw, v.uncertain FROM jsonb_to_recordset($2::jsonb) AS v(row_no int, raw jsonb, uncertain boolean)`,
        [batch.batch_id, JSON.stringify(rows)]
      );
      return batch;
    };
    return await db.tx(async (c) => {
      const batch = await insertBatch(c, type, parsed.rows, from);
      // A class timetable sheet uploaded as a timetable carries its own subject and staff table:
      // that becomes a second upload, to be committed first.
      if (type === 'timetable' && parsed.sheet && parsed.sheet.allocation.length) {
        const alloc = await insertBatch(c, 'allocation', parsed.sheet.allocation, null);
        await c.query('UPDATE attendance.import_batches SET linked_batch_id = $2 WHERE batch_id = $1', [batch.batch_id, alloc.batch_id]);
        await c.query('UPDATE attendance.import_batches SET linked_batch_id = $2 WHERE batch_id = $1', [alloc.batch_id, batch.batch_id]);
        await validateBatch(c, alloc);
        await validateBatch(c, batch);
        return { ...alloc, linked_batch_id: batch.batch_id };
      }
      await validateBatch(c, batch);
      return batch;
    });
  } catch (err) {
    await cleanup();
    throw err;
  }
}

function batchWhere(scope) {
  const w = new Where();
  if (scope.collegeId) w.add('b.college_id = ?', scope.collegeId);
  if (scope.role === 'hod') w.add('b.department_id = ?', scope.departmentId || 0);
  return w;
}

async function getBatch(scope, id) {
  const w = batchWhere(scope).add('b.batch_id = ?', parseInt(id, 10) || 0);
  const b = await db.one(
    `SELECT b.*, btrim(concat_ws(' ', u.first_name, u.last_name)) AS uploaded_by_name
       FROM attendance.import_batches b JOIN attendance.users u ON u.user_id = b.uploaded_by ${w}`,
    w.params
  );
  if (!b) throw notFound('That upload does not exist.');
  return b;
}

async function listBatches(scope, pg) {
  const w = batchWhere(scope);
  const total = (await db.one(`SELECT count(*)::int AS n FROM attendance.import_batches b ${w}`, w.params)).n;
  const rows = await db.many(
    `SELECT b.*, btrim(concat_ws(' ', u.first_name, u.last_name)) AS uploaded_by_name
       FROM attendance.import_batches b JOIN attendance.users u ON u.user_id = b.uploaded_by ${w}
      ORDER BY b.uploaded_at DESC LIMIT ${pg.limit} OFFSET ${pg.offset}`,
    w.params
  );
  return { rows, total };
}

async function batchRows(batchId, onlyInvalid, pg) {
  const cond = onlyInvalid ? "AND status = 'invalid'" : '';
  const total = (await db.one(`SELECT count(*)::int AS n FROM attendance.import_rows WHERE batch_id = $1 ${cond}`, [batchId])).n;
  const rows = await db.many(
    `SELECT row_id, row_no, raw, status, uncertain, errors FROM attendance.import_rows
      WHERE batch_id = $1 ${cond} ORDER BY row_no LIMIT ${pg.limit} OFFSET ${pg.offset}`,
    [batchId]
  );
  return { rows, total };
}

/** Validate again with today's master data (a linked allocation may have been committed since). */
async function recheck(scope, id) {
  const batch = await getBatch(scope, id);
  if (batch.status === 'validated') await db.tx((c) => validateBatch(c, batch));
  return getBatch(scope, id);
}

function assertOpen(batch) {
  if (batch.status !== 'validated') throw invalid(`This upload is ${batch.status} and can no longer be changed.`);
}

/** Fix cells of one row in the preview, then re-check the whole batch. */
async function updateRow(scope, batchId, rowId, patch) {
  const batch = await getBatch(scope, batchId);
  assertOpen(batch);
  const names = new Set(spec(batch.import_type).columns.map((c) => c.name));
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) if (names.has(k)) clean[k] = String(v === null || v === undefined ? '' : v).trim().slice(0, 300);
  await db.tx(async (c) => {
    const r = await c.query(
      `UPDATE attendance.import_rows SET raw = raw || $3::jsonb, uncertain = false WHERE batch_id = $1 AND row_id = $2`,
      [batch.batch_id, parseInt(rowId, 10) || 0, JSON.stringify(clean)]
    );
    if (!r.rowCount) throw notFound('That row does not exist.');
    await validateBatch(c, batch);
  });
  return getBatch(scope, batchId);
}

async function removeRow(scope, batchId, rowId) {
  const batch = await getBatch(scope, batchId);
  assertOpen(batch);
  await db.tx(async (c) => {
    await c.query('DELETE FROM attendance.import_rows WHERE batch_id = $1 AND row_id = $2', [batch.batch_id, parseInt(rowId, 10) || 0]);
    await validateBatch(c, batch);
  });
  return getBatch(scope, batchId);
}

async function commitBatch(scope, userId, batchId) {
  const batch = await getBatch(scope, batchId);
  assertOpen(batch);
  const s = spec(batch.import_type);
  if (s.needsEffectiveFrom && batch.effective_from < todayIn(scope.timezone)) {
    throw invalid('The effective-from date of this upload has passed. Upload the file again.');
  }
  // Validate once outside the transaction so slow preparation (password hashing) does not hold locks.
  let prepared = null;
  if (s.prepare) {
    const pre = await db.tx((c) => validateBatch(c, batch));
    if (pre.errorRows) throw invalid(`${pre.errorRows} rows still have errors. Fix them in the preview first.`);
    await s.prepare(pre.ctx, pre.rows);
    prepared = new Map(pre.rows.map((r) => [r.row_no, r.hash]));
  }
  const result = await db.tx(async (c) => {
    const { rows, ctx, errorRows } = await validateBatch(c, batch);
    if (errorRows) throw invalid(`${errorRows} rows still have errors. Fix them in the preview first.`);
    if (!rows.length) throw invalid('There are no rows to commit.');
    if (prepared) for (const r of rows) r.hash = prepared.get(r.row_no);
    const counts = await s.commit(c, ctx, rows, batch, userId);
    await c.query(
      `UPDATE attendance.import_batches SET status = 'committed', committed_at = now(), inserted_rows = $2, updated_rows = $3 WHERE batch_id = $1`,
      [batch.batch_id, counts.inserted, counts.updated]
    );
    return counts;
  });
  return { batch, ...result };
}

async function cancelBatch(scope, batchId) {
  const batch = await getBatch(scope, batchId);
  assertOpen(batch);
  await db.query(`UPDATE attendance.import_batches SET status = 'cancelled' WHERE batch_id = $1`, [batch.batch_id]);
  await db.query('DELETE FROM attendance.import_rows WHERE batch_id = $1', [batch.batch_id]);
  return batch;
}

// ------------------------------------------------------------------ workbooks
function styleHeader(row) {
  row.font = { bold: true };
  row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3E9F6' } }; });
}

/** The class timetable sheet as colleges publish it: the same layout the PDF reader understands. */
function classSheetExample(ws) {
  const rows = [
    ['PROGRAMME : B.E.', '', '', '', '', 'Hall No : 504'],
    ['SEMESTER : V - CSE 3', '', '', '', '', 'Academic Year : 2026-2027 (ODD Semester)'],
    ['With Effect From :'],
    ['DAY / HOUR', 1, 2, 3, 4, '', 5, 6, 7, 8],
    ['', '8.15am-9.05am', '9.05am-9.55am', '10.05am-10.55am', '10.55am-11.45am', 'LUNCH', '12.45pm-1.30pm', '1.30pm-2.15pm', '2.25pm-3.10pm', '3.10pm-3.55pm'],
    ['Monday', 'CN', 'AIML', 'AIMLL / CNL', '', '', 'TP', '', 'MENT', 'LIB'],
    ['Tuesday', 'ST/CCBT', 'DW', 'ST/CCBT', 'AIML', '', 'AIMLL / CNL', '', 'CN', 'DW'],
    [],
    ['S.No', 'Subject Code', 'Subject Name', 'Short name', 'L', 'T', 'P', 'Staff Incharge', 'Dept'],
    [1, 'CS3561', 'Computer Networks', 'CN', 4, 0, 0, 'Ms. S. Balaswathy / A.P', 'CSE'],
    [2, 'CS3563', 'Artificial Intelligence and Machine Learning', 'AIML', 3, 0, 0, 'Mr. K. Arun / A.P', 'CSE'],
    [3, 'PIT201', '(Professional Elective - I) Data Warehousing', 'DW', 4, 0, 0, 'Ms. S. Suma / A.P', 'CSE'],
    [4, 'PIT202', '(Professional Elective - II) Storage Technologies', 'ST', 4, 0, 0, 'Ms. R. Anitha / A.P (Hall No.503)', 'CSE'],
    [4, 'PCY302', '(Professional Elective - II) Crypto Currency and Blockchain Technologies', 'CCBT', 4, 0, 0, 'Dr. C. Pabitha / Asso. Prof. (Hall No.404)', 'CSE'],
    [5, '', 'Training Programme', 'TP', 0, 2, 0, 'Ms. S. Balaswathy / A.P', 'CSE'],
    [6, '', 'Mentoring', 'MENT', 0, 1, 0, 'Ms. A. Lalitha / A.P', 'CSE'],
    [7, '', 'Library', 'LIB', 0, 1, 0, 'Ms. A. Lalitha / A.P', 'CSE'],
    [8, 'CS3565', 'Computer Networks Laboratory', 'CNL', 0, 0, 4, 'Ms. S. Balaswathy / A.P (Hall No.LAB-2)', 'CSE'],
    [9, 'CS3566', 'Artificial Intelligence and Machine Learning Laboratory', 'AIMLL', 0, 0, 4, 'Mr. K. Arun / A.P (Hall No.LAB-1)', 'CSE'],
    [],
    ['A cell may hold two subjects (AIMLL / CNL: lab batches or electives) and may be merged across two hours.'],
    ['Subjects with no code (Training, Mentoring, Library) use their short name as the code. A lab or hall goes in brackets after the staff name.'],
  ];
  rows.forEach((r) => ws.addRow(r));
  ws.mergeCells('D6:E6'); ws.mergeCells('G6:H6'); ws.mergeCells('G7:H7'); // double periods
  styleHeader(ws.getRow(4));
  styleHeader(ws.getRow(9));
  ws.columns.forEach((col, i) => { col.width = i === 2 ? 48 : i === 7 ? 40 : 16; });
}

async function templateWorkbook(type) {
  const s = spec(type);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  ws.addRow(s.columns.map((c) => c.name));
  ws.addRow(s.columns.map((c) => c.example || ''));
  styleHeader(ws.getRow(1));
  ws.columns.forEach((col) => { col.width = 22; });
  if (s.grid) {
    const g = wb.addWorksheet('Grid layout');
    [['department_code', 'CSE'], ['program_code', 'BTECH'], ['semester_no', 3], ['section', 'A'], [],
      ['Day', 'P1', 'P2', 'P3', 'P4'],
      ['Monday', 'CS301 / STF012 / LH-201', 'MA201 / STF020 / LH-201', '', 'CS302 / STF014 / LAB-1'],
      ['Tuesday', 'CS302 / STF014 / LH-201', '', 'CS301 / STF012 / LH-201', '']].forEach((r) => g.addRow(r));
    styleHeader(g.getRow(6));
    g.columns.forEach((col) => { col.width = 26; });
    g.addRow([]);
    g.addRow(['Use either the Data sheet (one row per slot) or this grid, one grid per sheet or stacked with its own heading rows.']);
    g.addRow(['Delete the sheet you do not use. Each cell is subject code / staff code / room. Leave free periods blank.']);
  }
  if (s.classSheet) classSheetExample(wb.addWorksheet('Class sheet layout'));
  const notes = wb.addWorksheet('Notes');
  notes.addRow(['Column', 'Required', 'Notes']);
  styleHeader(notes.getRow(1));
  for (const c of s.columns) notes.addRow([c.name, c.required ? 'Yes' : 'No', c.note || '']);
  notes.columns = [{ width: 24 }, { width: 10 }, { width: 90 }];
  return wb;
}

async function errorsWorkbook(scope, batchId) {
  const batch = await getBatch(scope, batchId);
  const s = spec(batch.import_type);
  const rows = await db.many(`SELECT row_no, raw, errors FROM attendance.import_rows WHERE batch_id = $1 AND status = 'invalid' ORDER BY row_no`, [batch.batch_id]);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Errors');
  ws.addRow(['row', ...s.columns.map((c) => c.name), 'errors']);
  styleHeader(ws.getRow(1));
  for (const r of rows) ws.addRow([r.row_no, ...s.columns.map((c) => r.raw[c.name] || ''), r.errors.join('; ')]);
  ws.columns.forEach((col, i) => { col.width = i === s.columns.length + 1 ? 80 : 18; });
  return { wb, batch };
}

module.exports = {
  specs, allowedTypes, spec, parseFile, createBatch, getBatch, listBatches, batchRows, updateRow, removeRow,
  commitBatch, cancelBatch, templateWorkbook, errorsWorkbook, validateBatch, recheck, readClassSheets, classSheetExample, loadContext,
};
