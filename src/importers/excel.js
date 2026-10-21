'use strict';
const ExcelJS = require('exceljs');

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    // Excel dates arrive as UTC midnight; a time-only cell has the 1899 epoch date.
    const iso = v.toISOString();
    return iso.startsWith('1899-12-3') ? iso.slice(11, 16) : iso.slice(0, 10);
  }
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if (v.result !== undefined) return cellText(v.result);
    if (v.text !== undefined) return cellText(v.text);
    if (v.error) return '';
    return '';
  }
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  return String(v);
}

/** Every worksheet as a matrix of trimmed cell texts. */
async function readSheets(filePath, maxRows = 6000) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheets = [];
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== 'visible') return;
    const matrix = [];
    const cols = Math.min(ws.columnCount || 0, 60);
    const last = Math.min(ws.rowCount || 0, maxRows + 60);
    for (let r = 1; r <= last; r++) {
      const row = ws.getRow(r);
      const cells = [];
      for (let c = 1; c <= cols; c++) cells.push(cellText(row.getCell(c).value).trim());
      matrix.push(cells);
    }
    sheets.push({ name: ws.name, matrix });
  });
  return sheets;
}

module.exports = { readSheets, cellText };
