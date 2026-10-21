'use strict';
// Text-based PDFs only. The table is rebuilt from the position of each piece of text:
// lines are grouped by y, a header line fixes the column positions, and every later
// piece of text goes to the column it overlaps most. Scanned PDFs have no text layer
// and are rejected (OCR is out of scope).
const fs = require('fs');
const { parseDay } = require('../utils/dates');
const { isHeader, isGridHeader, metaFromRow } = require('./matrix');
const { HttpError } = require('../utils/errors');

async function readLines(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const task = pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    throw new HttpError(422, 'pdf_unreadable', 'This PDF could not be opened. It may be damaged or password-protected.');
  }
  const lines = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    const items = tc.items
      .filter((i) => i.str && i.str.trim())
      .map((i) => ({ x: i.transform[4], y: i.transform[5], w: i.width, h: Math.abs(i.transform[3]) || i.height || 10, str: i.str.trim() }))
      .sort((a, b) => b.y - a.y || a.x - b.x);
    let line = null;
    for (const it of items) {
      if (!line || Math.abs(line.y - it.y) > Math.max(2, it.h * 0.35)) {
        line = { y: it.y, items: [] };
        lines.push(line);
      }
      line.items.push(it);
    }
  }
  await task.destroy();
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

/** Every piece of upright text with its position, page by page (rotated text such as a vertical "LUNCH BREAK" is left out). */
async function readItems(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const task = pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    throw new HttpError(422, 'pdf_unreadable', 'This PDF could not be opened. It may be damaged or password-protected.');
  }
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const tc = await (await doc.getPage(n)).getTextContent();
    pages.push(tc.items
      .filter((i) => i.str && i.str.trim() && Math.abs(i.transform[1]) < 0.01)
      .map((i) => ({ x: i.transform[4], y: i.transform[5], w: i.width, h: Math.abs(i.transform[3]) || i.height || 10, str: i.str.trim() })));
  }
  await task.destroy();
  return pages;
}

/** Join pieces of text that sit close together into cells (used for header and free-text lines). */
function toCells(items) {
  const cells = [];
  for (const it of items) {
    const last = cells[cells.length - 1];
    if (last && it.x - last.x2 < it.h * 0.45) {
      last.str += (it.x - last.x2 > it.h * 0.12 ? ' ' : '') + it.str;
      last.x2 = it.x + it.w;
    } else cells.push({ x: it.x, x2: it.x + it.w, str: it.str });
  }
  return cells;
}

/** Column ranges from header cells: boundaries halfway between neighbouring headers. */
function columnRanges(cells) {
  return cells.map((c, i) => ({
    from: i === 0 ? -Infinity : (cells[i - 1].x2 + c.x) / 2,
    to: i === cells.length - 1 ? Infinity : (c.x2 + cells[i + 1].x) / 2,
  }));
}

/** Place a line's text into columns by overlap. Returns { row, unsure }. */
function place(items, ranges) {
  const row = ranges.map(() => '');
  let unsure = false;
  for (const it of items) {
    const a = it.x, b = it.x + Math.max(it.w, 1);
    let best = -1, bestOv = -1, second = 0;
    ranges.forEach((r, i) => {
      const ov = Math.max(0, Math.min(b, r.to) - Math.max(a, r.from));
      if (ov > bestOv) { second = bestOv; bestOv = ov; best = i; } else if (ov > second) second = ov;
    });
    if (second > 0.3 * (b - a)) unsure = true;
    row[best] = row[best] ? `${row[best]} ${it.str}` : it.str;
  }
  return { row, unsure };
}

/**
 * Read a PDF into the same matrix shape the Excel reader produces.
 * columns: the import type's columns (for finding a table header);
 * allowGrid: also look for a timetable grid.
 */
async function readMatrix(filePath, columns, allowGrid) {
  const lines = await readLines(filePath);
  if (!lines.length) {
    throw new HttpError(422, 'pdf_no_text', 'This PDF has no text layer (it looks scanned). Use the Excel template instead.');
  }
  const matrix = [];
  const uncertain = new Set();
  let ranges = null, mode = null;
  for (const line of lines) {
    const cells = toCells(line.items);
    const texts = cells.map((c) => c.str);
    if (isHeader(texts, columns)) {
      ranges = columnRanges(cells); mode = 'table'; matrix.push(texts); continue;
    }
    if (allowGrid && isGridHeader(texts)) {
      ranges = columnRanges(cells); mode = 'grid'; matrix.push(texts); continue;
    }
    if (!ranges) { matrix.push([texts.join('  ')]); continue; }
    const { row, unsure } = place(line.items, ranges);
    if (mode === 'grid') {
      const last = matrix[matrix.length - 1];
      if (parseDay(row[0])) {
        matrix.push(row);
        if (unsure) uncertain.add(matrix.length - 1);
      } else if (!row[0] && last && parseDay(last[0]) && !Object.keys(metaFromRow([texts.join(' ')])).length) {
        // A cell that wraps over several lines: subject, staff and room each on their own line.
        row.forEach((v, i) => { if (v) last[i] = last[i] ? `${last[i]} / ${v}` : v; });
        if (unsure) uncertain.add(matrix.length - 1);
      } else {
        ranges = null; mode = null; matrix.push([texts.join('  ')]); // text outside the grid, e.g. the next section's heading
      }
    } else {
      matrix.push(row);
      if (unsure) uncertain.add(matrix.length - 1);
    }
  }
  return { matrix, uncertain };
}

module.exports = { readMatrix, readLines, readItems, toCells, columnRanges, place };
