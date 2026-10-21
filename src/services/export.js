'use strict';
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const config = require('../config/env');
const reports = require('../models/reports');
const audit = require('./audit');
const { invalid } = require('../utils/errors');

const dir = path.join(config.storageDir, 'exports');
fs.mkdirSync(dir, { recursive: true });

const cell = (v) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : v);

async function writeXlsx(file, { title, subtitle, columns, rows }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Report');
  ws.addRow([title]).font = { bold: true, size: 14 };
  ws.addRow([subtitle || '']);
  ws.addRow([]);
  const head = ws.addRow(columns.map((c) => c.header));
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3E9F6' } }; });
  for (const r of rows) ws.addRow(columns.map((c) => cell(r[c.key])));
  columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width || 16; });
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  await wb.xlsx.writeFile(file);
}

function writePdf(file, { title, subtitle, columns, rows }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 });
    const out = fs.createWriteStream(file);
    out.on('finish', resolve);
    out.on('error', reject);
    doc.pipe(out);
    const left = doc.page.margins.left;
    const usable = doc.page.width - left - doc.page.margins.right;
    const sum = columns.reduce((a, c) => a + (c.width || 16), 0);
    const widths = columns.map((c) => ((c.width || 16) / sum) * usable);
    const rowH = 16;
    const bottom = () => doc.page.height - doc.page.margins.bottom - rowH;

    const header = () => {
      let x = left;
      const y = doc.y;
      doc.rect(left, y - 2, usable, rowH).fill('#E3E9F6').fillColor('#14213D').font('Helvetica-Bold').fontSize(8);
      columns.forEach((c, i) => {
        doc.text(String(c.header), x + 3, y + 2, { width: widths[i] - 6, lineBreak: false, ellipsis: true });
        x += widths[i];
      });
      doc.y = y + rowH;
      doc.font('Helvetica').fontSize(8);
    };

    doc.fillColor('#14213D').font('Helvetica-Bold').fontSize(14).text(title, left, doc.y);
    if (subtitle) doc.font('Helvetica').fontSize(9).fillColor('#4A5568').text(subtitle, { width: usable });
    doc.moveDown(0.6);
    header();
    for (const r of rows) {
      if (doc.y > bottom()) {
        doc.addPage();
        header();
      }
      let x = left;
      const y = doc.y;
      doc.fillColor('#14213D');
      columns.forEach((c, i) => {
        doc.text(String(cell(r[c.key])), x + 3, y + 2, { width: widths[i] - 6, lineBreak: false, ellipsis: true });
        x += widths[i];
      });
      doc.moveTo(left, y + rowH - 2).lineTo(left + usable, y + rowH - 2).strokeColor('#D7DCE5').lineWidth(0.5).stroke();
      doc.y = y + rowH;
    }
    if (!rows.length) doc.fillColor('#4A5568').text('No rows match these filters.', left, doc.y + 6);
    doc.end();
  });
}

/**
 * Build the file, log it in report_exports and send it as a download.
 * report: { name, title, subtitle, columns: [{ header, key, width }], rows }
 */
async function send(req, res, report, format) {
  if (!['xlsx', 'pdf'].includes(format)) throw invalid('Choose Excel or PDF.');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const fileName = `${report.name}-${stamp}.${format}`;
  const file = path.join(dir, `${req.user.userId}-${fileName}`);
  if (format === 'xlsx') await writeXlsx(file, report);
  else await writePdf(file, report);
  await reports.logExport(req.user.userId, report.title, format === 'xlsx' ? 'excel' : 'pdf', path.basename(file));
  await audit.log(req, 'export', { table: report.name, newValues: { format, rows: report.rows.length, filters: report.subtitle } });
  res.download(file, fileName);
}

module.exports = { send, writeXlsx, writePdf };
