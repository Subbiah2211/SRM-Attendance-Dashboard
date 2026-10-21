'use strict';
// Reads a class timetable sheet in the layout colleges publish:
//
//   PROGRAMME : B.E.                 Hall No : 504
//   SEMESTER  : V - CSE 3            CLASS ADVISOR: ...
//   HOUR   |   1   |   2   |   3   |   4   | lunch |  5 ...
//   Monday |  CN   | AIML  |  AIMLL / CNL  |       |  TP ...      <- short names; a cell
//   ...                                                             can span two hours or
//   S.No | Subject Code | Subject Name | CN | L T P | Staff | Dept  hold two subjects
//
// The grid gives day x hour -> subject short names. The table under it gives, per short
// name, the subject code and name, L-T-P, the staff in charge and their hall.
// One sheet becomes two sets of rows: the subject and staff allocation, and the timetable.
const { parseDay } = require('../utils/dates');

const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
const clean = (s) => String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
const TITLE = /^(ms|mrs|mr|dr|prof|miss|er)\b\.?/i;

/** "8.15am" / "12.45pm" / "1.30 PM" -> "08:15". */
function parseTime(s) {
  const m = String(s || '').match(/(\d{1,2})[.:](\d{2})\s*(am|pm)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** Header lines -> programme, semester, department, section, hall, year. */
function parseMeta(lines) {
  const meta = {};
  const text = lines.join('\n');
  let m;
  if ((m = text.match(/PROGRAMME\s*:?\s*([A-Za-z][A-Za-z.]*)/i))) meta.programme = m[1].replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  // "SEMESTER : V - CSE 3"  (semester in Roman or digits, department code, section)
  if ((m = text.match(/SEMESTER\s*:?\s*([IVX]+|\d{1,2})\s*[-\u2013]\s*([A-Za-z&]+)\s*[-\u2013]?\s*([A-Za-z0-9]{1,3})?(?=\s|$)/i))) {
    meta.semester_no = ROMAN[m[1].toUpperCase()] || parseInt(m[1], 10);
    meta.department_code = m[2].toUpperCase();
    meta.section = (m[3] || '').toUpperCase();
  }
  if (!meta.semester_no && (m = text.match(/\b([IVX]+|\d{1,2})\s*(?:st|nd|rd|th)?\s*SEM(?:ESTER)?\b/i) || text.match(/\bSEM(?:ESTER)?\s*[:-]?\s*([IVX]+|\d{1,2})\b/i))) {
    meta.semester_no = ROMAN[m[1].toUpperCase()] || parseInt(m[1], 10) || undefined;
  }
  if ((m = text.match(/Hall\s*No\.?\s*:?\s*([A-Za-z0-9-]+)/i))) meta.hall = m[1].toUpperCase();
  if ((m = text.match(/Academic\s*Year\s*:?\s*(\d{4})\s*[-\u2013]\s*(\d{2,4})(?:\s*\(?\s*(ODD|EVEN))?/i))) {
    meta.year_start = parseInt(m[1], 10);
    meta.term = (m[3] || '').toUpperCase();
  }
  if ((m = text.match(/DEPARTMENT\s+OF\s+([A-Za-z &]+)/i))) meta.department_name = clean(m[1]);
  if ((m = text.match(/CLASS\s*ADVISOR\s*:?\s*([^\n]+)/i))) meta.class_advisor = staffEntry(clean(m[1])).name;
  if ((m = text.match(/CO-?\s*ADVISOR\s*:?\s*([^\n]+)/i))) meta.co_advisor = staffEntry(clean(m[1])).name;
  if ((m = text.match(/With\s*Effect\s*From\s*:?\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/i))) meta.effective_from = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return meta;
}

/** "Ms.S.Anslam Sibi / A.P - Sr. G.(Hall No.502)" -> { name, designation, halls }. */
function staffEntry(text) {
  let t = clean(text);
  const halls = [];
  t = t.replace(/\(?\s*Hall\s*No\.?\s*:?\s*([A-Za-z0-9 ,&-]+?)\s*\)/gi, (all, list) => {
    halls.push(...list.split(/[,&]/).map((h) => h.trim().toUpperCase()).filter(Boolean));
    return '';
  });
  const [name, ...rest] = t.split(' / ');
  return { name: clean(name), designation: clean(rest.join(' / ')) || null, halls };
}

/** The staff cell of one subject: one entry per person (several lines can belong to one person). */
function staffEntries(lines) {
  const entries = [];
  for (const raw of lines.map(clean).filter(Boolean)) {
    const starts = TITLE.test(raw) || /^new\s+staff/i.test(raw) || !entries.length;
    if (starts) entries.push(raw);
    else entries[entries.length - 1] += ' ' + raw;
  }
  return entries.map(staffEntry).filter((e) => e.name);
}

/** "(Professional Elective - II) Storage Technologies" -> name and category. */
function subjectName(lines) {
  let name = clean(lines.join(' '));
  let category = null;
  const m = name.match(/^\(([^)]+)\)\s*(.*)$/);
  if (m && m[2]) { category = clean(m[1]); name = clean(m[2]); }
  return { name, category };
}

const isShort = (s) => /^[A-Z][A-Z0-9&-]{0,9}$/.test(s);
const tokens = (text) => clean(text).split(/\s*[/|]\s*/).map((t) => t.trim().toUpperCase()).filter(Boolean);

// ------------------------------------------------------------------ from PDF text positions
/**
 * items: [{ x, y, w, h, str }] of one page (y grows upwards, as in PDF space).
 * Returns the sheet, or null when the page is not a class timetable sheet.
 */
function fromPdfItems(items) {
  const at = (re) => items.find((i) => re.test(i.str.trim()));
  const hour = at(/^HOUR$/i);
  const legendHead = at(/^Staff\s*In-?\s*charge$/i) || at(/^Staff\b/i);
  if (!hour || !legendHead) return null;

  // Hour columns: the numbers on the HOUR line.
  const cols = items
    .filter((i) => Math.abs(i.y - hour.y) < 3 && i.x > hour.x && /^\d{1,2}$/.test(i.str.trim()))
    .map((i) => ({ no: parseInt(i.str, 10), cx: i.x + i.w / 2 }))
    .sort((a, b) => a.cx - b.cx);
  if (cols.length < 3) return null;
  const gridLeft = cols[0].cx - (cols[1].cx - cols[0].cx) / 2;

  // Day rows: a day name left of the first hour column.
  const days = items
    .filter((i) => i.x + i.w / 2 < gridLeft && i.y < hour.y && i.y > legendHead.y && parseDay(i.str))
    .map((i) => ({ day: parseDay(i.str), y: i.y }))
    .sort((a, b) => b.y - a.y);
  if (!days.length) return null;
  const rowGap = days.length > 1 ? Math.abs(days[0].y - days[1].y) : 20;

  // Period times: the texts between the HOUR line and the first day row, by column.
  const nearest = (cx) => cols.reduce((best, c) => (Math.abs(c.cx - cx) < Math.abs(best.cx - cx) ? c : best), cols[0]);
  const times = new Map();
  for (const i of items) {
    if (i.y >= hour.y - 2 || i.y <= days[0].y + rowGap * 0.45 || i.x + i.w / 2 < gridLeft) continue;
    const c = nearest(i.x + i.w / 2);
    times.set(c.no, ((times.get(c.no) || '') + ' ' + i.str).trim());
  }
  const periods = cols.map((c) => {
    const parts = (times.get(c.no) || '').split(/\s*-\s*|\s+/).map(parseTime).filter(Boolean);
    return { no: c.no, start: parts[0] || null, end: parts[1] || null };
  });

  // Cells. A text centred on a column belongs to that hour; a text centred between two
  // neighbouring columns is a merged cell and belongs to both.
  const cells = [];
  for (const d of days) {
    for (const i of items) {
      if (Math.abs(i.y - d.y) > rowGap * 0.4 || i.x + i.w / 2 < gridLeft) continue;
      const toks = tokens(i.str);
      if (!toks.length || !toks.every(isShort)) continue; // "LUNCH", "BREAK" and stray text are not all-caps codes
      if (/^(LUNCH|BREAK)$/.test(toks.join(''))) continue;
      const cx = i.x + i.w / 2;
      let best = { d: Infinity, nos: [] };
      cols.forEach((c, k) => {
        if (Math.abs(c.cx - cx) < best.d) best = { d: Math.abs(c.cx - cx), nos: [c.no], pitch: 0 };
        const next = cols[k + 1];
        // Only neighbouring hours can merge; the lunch gap is wider than a normal pitch.
        if (next && next.no === c.no + 1) {
          const mid = (c.cx + next.cx) / 2;
          if (Math.abs(mid - cx) < best.d) best = { d: Math.abs(mid - cx), nos: [c.no, next.no] };
        }
      });
      const width = cols.length > 1 ? Math.abs(cols[1].cx - cols[0].cx) : 50;
      for (const no of best.nos) cells.push({ day: d.day, period_no: no, tokens: toks, uncertain: best.d > width * 0.2 });
    }
  }

  // The subject table: rows are anchored on the short-name cells.
  const used = new Set(cells.flatMap((c) => c.tokens));
  const L = items.find((i) => i.str.trim() === 'L' && Math.abs(i.y - legendHead.y) < 8);
  const dept = items.find((i) => /^Dept/i.test(i.str.trim()) && Math.abs(i.y - legendHead.y) < 8);
  const codeHead = items.find((i) => /^(Subject|Code|Subject\s*Code)$/i.test(i.str.trim()) && Math.abs(i.y - legendHead.y) < 14 && i.x < (L ? L.x : legendHead.x) - 120);
  if (!L) return null;
  const P = items.filter((i) => i.str.trim() === 'P' && Math.abs(i.y - L.y) < 3)[0];
  const staffX = (P ? P.x + P.w : L.x + 36) + 4;
  const deptX = dept ? dept.x - 14 : Infinity;
  const codeRight = codeHead ? codeHead.x + codeHead.w + 4 : L.x - 190;
  const below = items.filter((i) => i.y < legendHead.y - 6);
  const anchors = below
    .filter((i) => used.has(i.str.trim().toUpperCase()) && i.x > codeRight && i.x + i.w < L.x + 2 && i.x > L.x - 70)
    .sort((a, b) => b.y - a.y);
  const legend = [];
  anchors.forEach((a, k) => {
    const prev = anchors[k - 1], next = anchors[k + 1];
    const gapUp = prev ? prev.y - a.y : next ? a.y - next.y : 20;
    const gapDown = next ? a.y - next.y : gapUp;
    const hi = prev ? a.y + gapUp / 2 : a.y + gapUp / 2, lo = a.y - gapDown / 2;
    const band = below.filter((i) => i !== a && i.y <= hi && i.y > lo).sort((p, q) => q.y - p.y || p.x - q.x);
    const code = band.find((i) => i.x < codeRight && i.x > (codeHead ? codeHead.x - 12 : 0) && /^[A-Z]{2,4}\d{3,5}[A-Z]?$/.test(i.str.trim()));
    const nameLines = band.filter((i) => i.x >= codeRight - 1 && i.x + i.w / 2 < a.x - 4 && !/^\d+$/.test(i.str.trim())).map((i) => i.str);
    const ltp = band.filter((i) => i.x >= L.x - 6 && i.x < staffX - 4 && /^\d$/.test(i.str.trim())).sort((p, q) => p.x - q.x).map((i) => parseInt(i.str, 10));
    const staffLines = band.filter((i) => i.x >= staffX - 2 && i.x < deptX).map((i) => i.str);
    const deptItem = band.find((i) => i.x >= deptX && /^[A-Z&]{2,8}$/.test(i.str.trim()));
    const { name, category } = subjectName(nameLines);
    legend.push({
      short: a.str.trim().toUpperCase(), code: code ? code.str.trim().toUpperCase() : null, name, category,
      L: ltp[0], T: ltp[1], P: ltp[2], staff: staffEntries(staffLines), dept: deptItem ? deptItem.str.trim().toUpperCase() : null,
    });
  });
  // Rows that share one L-T-P cell (two electives under one serial number) take it from the row above.
  legend.forEach((r, k) => { if (r.L === undefined && k > 0) Object.assign(r, { L: legend[k - 1].L, T: legend[k - 1].T, P: legend[k - 1].P }); });

  const headLines = [];
  const top = items.filter((i) => i.y > hour.y + 3).sort((a, b) => b.y - a.y || a.x - b.x);
  for (const i of top) {
    const last = headLines[headLines.length - 1];
    if (last && Math.abs(last.y - i.y) < 3.5) last.parts.push(i); else headLines.push({ y: i.y, parts: [i] });
  }
  const meta = parseMeta(headLines.map((l) => l.parts.sort((a, b) => a.x - b.x).map((p) => p.str).join(' ')));
  return { meta, periods, cells, legend };
}

// ------------------------------------------------------------------ from an Excel sheet
/** matrix: rows of cell texts; merged cells repeat their text in every cell they cover. */
function fromMatrix(matrix) {
  const isInt = (v) => /^\d{1,2}$/.test(clean(v));
  const hourRow = matrix.findIndex((r) => r.filter(isInt).length >= 3 && r.some((c) => /hour|day/i.test(c)));
  const legendRow = matrix.findIndex((r, i) => i > hourRow && r.some((c) => /subject\s*code/i.test(clean(c))) && r.some((c) => /staff/i.test(c)));
  if (hourRow < 0 || legendRow < 0) return null;

  const colOf = new Map(); // column index -> hour number
  matrix[hourRow].forEach((c, i) => { if (isInt(c)) colOf.set(i, parseInt(clean(c), 10)); });
  const timeRow = matrix[hourRow + 1] || [];
  const seen = new Set();
  const periods = [];
  for (const [i, no] of colOf) {
    if (seen.has(no)) continue;
    seen.add(no);
    const parts = clean(timeRow[i]).split(/\s*-\s*|\s+/).map(parseTime).filter(Boolean);
    periods.push({ no, start: parts[0] || null, end: parts[1] || null });
  }
  const cells = [];
  for (let r = hourRow + 1; r < legendRow; r++) {
    const row = matrix[r];
    const day = parseDay(row.slice(0, 3).map(clean).find((c) => parseDay(c)) || '');
    if (!day) continue;
    const done = new Set();
    for (const [i, no] of colOf) {
      const toks = tokens(row[i]);
      if (!toks.length || !toks.every(isShort) || done.has(no)) continue;
      done.add(no);
      cells.push({ day, period_no: no, tokens: toks, uncertain: false });
    }
  }
  const head = matrix[legendRow].map(clean);
  const find = (re) => head.findIndex((c) => re.test(c));
  const cCode = find(/subject\s*code/i), cName = find(/subject\s*name/i), cL = head.findIndex((c) => c === 'L'), cT = head.findIndex((c) => c === 'T'), cP = head.findIndex((c) => c === 'P');
  const cStaff = find(/staff/i), cDept = find(/^dept/i);
  if (cName < 0 || cL < 0 || cStaff < 0) return null;
  const legend = [];
  for (let r = legendRow + 1; r < matrix.length; r++) {
    const row = matrix[r].map((c) => String(c === null || c === undefined ? '' : c));
    const nameText = clean(row[cName]);
    // The short name is the last filled cell between the subject name and L.
    let short = '';
    for (let i = cL - 1; i > cName; i--) { const v = clean(row[i]); if (v && v !== nameText) { short = v.toUpperCase(); break; } }
    if (!short || !isShort(short)) continue;
    const { name, category } = subjectName(row[cName].split(/\n/));
    const n = (i) => (i >= 0 && /^\d+$/.test(clean(row[i])) ? parseInt(clean(row[i]), 10) : undefined);
    legend.push({
      short, code: /^[A-Z]{2,4}\d{3,5}[A-Z]?$/i.test(clean(row[cCode])) ? clean(row[cCode]).toUpperCase() : null, name, category,
      L: n(cL), T: n(cT), P: n(cP), staff: staffEntries(row[cStaff].split(/\n/)), dept: cDept >= 0 ? clean(row[cDept]).toUpperCase() || null : null,
    });
  }
  const meta = parseMeta(matrix.slice(0, hourRow).map((r) => [...new Set(r.map(clean).filter(Boolean))].join('   ')));
  return { meta, periods, cells, legend };
}

// ------------------------------------------------------------------ sheet -> raw import rows
/** Turn a sheet into raw rows for the two uploads. */
function toRows(sheet) {
  const m = sheet.meta;
  const base = {
    department_code: m.department_code || '', program_code: m.programme || '',
    semester_no: m.semester_no ? String(m.semester_no) : '', section: m.section || '',
  };
  const allocation = [];
  const byShort = new Map();
  for (const s of sheet.legend) {
    byShort.set(s.short, s);
    const staff = s.staff.length ? s.staff : [{ name: '', halls: [] }];
    for (const st of staff) {
      const practical = (s.P || 0) > 0;
      allocation.push({
        raw: {
          ...base, subject_code: s.code || s.short, subject_name: s.name, short_name: s.short,
          lecture_hours: s.L === undefined ? '' : String(s.L), tutorial_hours: s.T === undefined ? '' : String(s.T), practical_hours: s.P === undefined ? '' : String(s.P),
          staff_code: '', staff_name: st.name, staff_designation: st.designation || '', subject_department: s.dept || m.department_code || '', category: s.category || '',
          room_number: st.halls[0] || '', block_name: '',
        },
        // Flag what a person should look at: several halls for one person, or a lab with no room given.
        uncertain: st.halls.length > 1 || (practical && !st.halls.length) || !s.code,
      });
    }
  }
  const timetable = [];
  for (const c of sheet.cells) {
    for (const tok of c.tokens) {
      const s = byShort.get(tok);
      const staff = s && s.staff.length ? s.staff : [{ name: '', halls: [] }];
      for (const st of staff) {
        timetable.push({
          raw: {
            ...base, day: String(c.day), period_no: String(c.period_no),
            subject_code: s ? s.code || s.short : tok, staff_code: '', staff_name: st.name,
            room_number: st.halls[0] || m.hall || '', block_name: '',
          },
          uncertain: c.uncertain || !s,
        });
      }
    }
  }
  timetable.sort((a, b) => a.raw.day - b.raw.day || a.raw.period_no - b.raw.period_no);
  return { allocation, timetable };
}

module.exports = { fromPdfItems, fromMatrix, toRows, parseMeta, parseTime, staffEntries, staffEntry };
