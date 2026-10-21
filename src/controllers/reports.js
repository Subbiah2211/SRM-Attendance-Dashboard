'use strict';
const reports = require('../models/reports');
const timetable = require('../models/timetable');
const master = require('../models/master');
const settings = require('../services/settings');
const exporter = require('../services/export');
const { idOrNull, pager } = require('./helpers');

const filtersOf = (req) => ({ section_id: idOrNull(req.query.section_id), subject_id: idOrNull(req.query.subject_id) });

async function defaulters(req, res) {
  const f = filtersOf(req);
  const threshold = await settings.get(req.scope.collegeId, 'defaulter_threshold_pct', 75);
  const pg = pager(req, 0);
  const { rows, total } = await reports.defaulters(req.scope, f, threshold, pg);
  res.page('reports/defaulters', {
    title: 'Defaulters', rows, threshold, filters: f, pager: pager(req, total),
    options: {
      sections: await timetable.sections(req.scope),
      subjects: req.scope.collegeId && req.user.role !== 'student' ? await master.options(req.scope, 'subjects') : [],
    },
  });
}

async function exportDefaulters(req, res) {
  const f = filtersOf(req);
  const threshold = await settings.get(req.scope.collegeId, 'defaulter_threshold_pct', 75);
  const { rows } = await reports.defaulters(req.scope, f, threshold, { limit: 5000, offset: 0 });
  await exporter.send(req, res, {
    name: 'defaulters', title: `Students below ${threshold}%`,
    subtitle: `${req.scope.collegeName || 'All colleges'}. Current semester${f.section_id ? ', one class' : ''}${f.subject_id ? ', one subject' : ''}.`,
    columns: [
      { header: 'Register no', key: 'register_no', width: 20 }, { header: 'Name', key: 'full_name', width: 28 },
      { header: 'Class', key: 'section_label', width: 20 }, { header: 'Subject', key: 'subject', width: 32 },
      { header: 'Held', key: 'total_classes', width: 7 }, { header: 'Attended', key: 'attended_classes', width: 9 },
      { header: 'Excused', key: 'excused_classes', width: 9 }, { header: '%', key: 'percentage', width: 8 },
    ],
    rows: rows.map((r) => ({ ...r, subject: `${r.subject_code} ${r.subject_name}` })),
  }, req.query.format);
}

module.exports = { defaulters, exportDefaulters };
