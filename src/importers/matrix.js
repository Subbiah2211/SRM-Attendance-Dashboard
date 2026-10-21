'use strict';
// Turns a matrix of cell texts (from Excel or from a PDF) into raw import rows.
// Two layouts are understood:
//   table  one header row with column names, then one row per record
//   grid   timetable only: days down the side, periods across the top,
//          each cell "subject code / staff code / room"
const { parseDay } = require('../utils/dates');

const norm = (s) => String(s === null || s === undefined ? '' : s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** Map header cell index -> canonical column name, using each column's aliases. */
function headerMap(cells, columns) {
  const lookup = new Map();
  for (const c of columns) for (const a of [c.name, ...(c.aliases || [])]) lookup.set(norm(a), c.name);
  const map = new Map();
  cells.forEach((cell, i) => {
    const name = lookup.get(norm(cell));
    if (name && ![...map.values()].includes(name)) map.set(i, name);
  });
  return map;
}

function headerThreshold(columns) {
  const required = columns.filter((c) => c.required).length;
  return Math.max(2, Math.min(3, required));
}

/**
 * Is this row the header of a list? Enough known column names, and at least one of the
 * columns the list cannot do without (so a heading line such as "Department: CSE  Section: A"
 * is not mistaken for the header).
 */
function isHeader(cells, columns) {
  const map = headerMap(cells, columns);
  if (map.size < headerThreshold(columns)) return false;
  const key = new Set(columns.filter((c) => c.required).map((c) => c.name));
  return [...map.values()].some((name) => key.has(name));
}

function findHeader(matrix, columns, maxScan = 40) {
  for (let i = 0; i < Math.min(matrix.length, maxScan); i++) {
    if (isHeader(matrix[i], columns)) return { index: i, map: headerMap(matrix[i], columns) };
  }
  return null;
}

function fromTable(matrix, columns, uncertain = new Set()) {
  const header = findHeader(matrix, columns);
  if (!header) return null;
  const present = new Set(header.map.values());
  const missing = columns.filter((c) => c.required && !present.has(c.name)).map((c) => c.name);
  const rows = [];
  for (let i = header.index + 1; i < matrix.length; i++) {
    const cells = matrix[i];
    if (!cells || cells.every((c) => String(c || '').trim() === '')) continue;
    if (isHeader(cells, columns)) continue; // header repeated on a new page
    const raw = {};
    for (const [idx, name] of header.map) raw[name] = String(cells[idx] === undefined || cells[idx] === null ? '' : cells[idx]).trim();
    rows.push({ raw, uncertain: uncertain.has(i) });
  }
  return { layout: 'table', rows, missing, meta: headingMeta(matrix.slice(0, header.index)) };
}

const META_ALIASES = {
  department_code: ['department_code', 'department', 'dept', 'dept_code', 'branch'],
  program_code: ['program_code', 'program', 'programme', 'course', 'degree'],
  semester_no: ['semester_no', 'semester', 'sem'],
  section: ['section', 'sec', 'section_name'],
  year: ['year', 'year_of_study'],
};
const META_LOOKUP = new Map();
for (const [k, list] of Object.entries(META_ALIASES)) for (const a of list) META_LOOKUP.set(a, k);
const META_RE = /(department(?:\s*code)?|dept(?:\s*code)?|branch|program(?:me)?(?:\s*code)?|course|degree|semester(?:\s*no)?|sem|section(?:\s*name)?|sec|year(?:\s*of\s*study)?)\s*[:=\u2013-]\s*([A-Za-z0-9.&]+)/gi;

function metaFromRow(cells) {
  const out = {};
  cells.forEach((cell, i) => {
    const text = String(cell || '');
    let m;
    META_RE.lastIndex = 0;
    let found = false;
    while ((m = META_RE.exec(text))) {
      const key = META_LOOKUP.get(norm(m[1]));
      if (key) { out[key] = m[2].trim(); found = true; }
    }
    if (!found) {
      const key = META_LOOKUP.get(norm(text));
      const next = String(cells[i + 1] || '').trim();
      if (key && next && !META_LOOKUP.get(norm(next))) out[key] = next;
    }
  });
  return out;
}

/**
 * What the lines above a list say about all its rows: the class of a nominal roll
 * ("SEMESTER : V - CSE 3", "Section: A") or the department of a staff list
 * ("DEPARTMENT OF COMPUTER SCIENCE AND ENGINEERING").
 */
function headingMeta(rowsAbove) {
  const { parseMeta } = require('./classSheet');
  const meta = {};
  for (const cells of rowsAbove) Object.assign(meta, metaFromRow(cells));
  const head = parseMeta(rowsAbove.map((r) => r.map((c) => String(c || '').trim()).filter(Boolean).join('   ')));
  // The class-sheet reader understands "V - CSE 3" and Roman numerals, so its reading comes first.
  const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
  const sem = head.semester_no || ROMAN[String(meta.semester_no || '').toUpperCase()] || meta.semester_no || '';
  return {
    department_code: head.department_code || meta.department_code || head.department_name || '',
    program_code: head.programme || meta.program_code || '',
    semester_no: sem ? String(sem) : '',
    section: head.section || meta.section || '',
  };
}

const DAY_HEADERS = new Set(['day', 'days', 'day_period', 'period_day', 'day_time', 'day_order', 'day_hour']);
const isGridHeader = (cells) => DAY_HEADERS.has(norm(cells[0])) && cells.slice(1).filter((c) => /\d/.test(String(c || ''))).length >= 2;
const EMPTY_SLOT = /^(|_+|break|lunch|lunch_break|free|nil|na|n_a|library|x)$/;

function fromGrid(matrix, uncertain = new Set()) {
  const rows = [];
  let meta = {}, periods = null, sawData = false, grids = 0;
  matrix.forEach((cells, i) => {
    if (!cells || cells.every((c) => String(c || '').trim() === '')) return;
    if (isGridHeader(cells)) {
      periods = new Map();
      cells.forEach((c, idx) => {
        const m = idx > 0 && String(c || '').match(/\d+/);
        if (m) periods.set(idx, parseInt(m[0], 10));
      });
      sawData = false;
      grids++;
      return;
    }
    const day = periods ? parseDay(cells[0]) : null;
    if (periods && day) {
      sawData = true;
      for (const [idx, periodNo] of periods) {
        const text = String(cells[idx] || '').trim();
        if (EMPTY_SLOT.test(norm(text))) continue;
        const parts = text.split(/\s*(?:\/|\||\n|;)\s*/).map((p) => p.trim()).filter(Boolean);
        rows.push({
          raw: {
            department_code: meta.department_code || '', program_code: meta.program_code || '',
            year: meta.year || '', semester_no: meta.semester_no || '', section: meta.section || '',
            day: String(day), period_no: String(periodNo),
            subject_code: parts[0] || '', staff_code: parts[1] || '', room_number: parts[2] || '', block_name: '',
          },
          uncertain: uncertain.has(i) || parts.length !== 3,
        });
      }
      return;
    }
    const found = metaFromRow(cells);
    if (Object.keys(found).length) {
      if (sawData) { meta = {}; periods = null; sawData = false; } // a new section's block starts
      Object.assign(meta, found);
    }
  });
  if (!grids) return null;
  return { layout: 'grid', rows, missing: [] };
}

module.exports = { norm, headerMap, headerThreshold, isHeader, findHeader, fromTable, fromGrid, isGridHeader, metaFromRow, headingMeta };
