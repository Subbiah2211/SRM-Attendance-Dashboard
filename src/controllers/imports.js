'use strict';
const service = require('../services/imports');
const setup = require('../services/imports/setup');
const { forbidden } = require('../utils/errors');
const audit = require('../services/audit');
const { addDays, todayIn } = require('../utils/dates');
const { pager } = require('./helpers');

async function index(req, res) {
  const pg = pager(req, 0, 20);
  const { rows, total } = await service.listBatches(req.scope, pg);
  res.page('imports/index', {
    title: 'Uploads', types: service.allowedTypes(req.scope), batches: rows, pager: pager(req, total, 20), preselect: String(req.query.type || ''),
    defaultFrom: addDays(todayIn(req.scope.timezone), 1), canEdit: req.can('master_data', 'edit') && !!req.scope.collegeId,
  });
}

async function template(req, res) {
  const wb = await service.templateWorkbook(req.params.type);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-template.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

async function upload(req, res) {
  const batch = await service.createBatch(req.scope, req.user.userId, {
    type: req.body.import_type, file: req.file, effectiveFrom: req.body.effective_from || null,
  });
  await audit.log(req, 'import_uploaded', { table: 'import_batches', recordId: batch.batch_id, newValues: { type: batch.import_type, file: batch.file_name } });
  const message = batch.linked_batch_id
    ? `Class timetable sheet read. Step 1: check and commit the subject and staff allocation here. Step 2: commit the timetable (upload ${batch.linked_batch_id}).`
    : 'File read. Check the preview, then commit.';
  res.done(`/imports/${batch.batch_id}`, { batch_id: batch.batch_id, linked_batch_id: batch.linked_batch_id || undefined, import_type: batch.import_type }, message);
}

async function show(req, res) {
  // Checked again on every view: a linked allocation may have been committed since the upload.
  const batch = await service.recheck(req.scope, req.params.id);
  const onlyInvalid = req.query.show === 'errors';
  const pg = pager(req, 0);
  const { rows, total } = await service.batchRows(batch.batch_id, onlyInvalid, pg);
  // For a class timetable sheet: how many things it needs that the college has not entered yet.
  const missing = batch.layout === 'class_sheet' && batch.status === 'validated' ? (await setup.plan(req.scope, batch.batch_id)) : null;
  res.page('imports/show', {
    title: `Upload ${batch.batch_id}`, batch, rows, onlyInvalid, pager: pager(req, total),
    missingCount: missing ? missing.count : 0, missingBlockers: missing ? missing.blockers : [], canSetUp: ['admin', 'superadmin'].includes(req.user.role),
    columns: service.spec(batch.import_type).columns, label: service.spec(batch.import_type).label,
    canEdit: req.can('master_data', 'edit') && batch.status === 'validated',
  });
}

async function updateRow(req, res) {
  const batch = await service.updateRow(req.scope, req.params.id, req.params.rowId, (req.body && (req.body.raw || req.body)) || {});
  res.done(`/imports/${batch.batch_id}${req.query.show === 'errors' ? '?show=errors' : ''}`, { batch }, batch.error_rows ? `${batch.error_rows} rows still have errors.` : 'All rows are valid.');
}

async function removeRow(req, res) {
  const batch = await service.removeRow(req.scope, req.params.id, req.params.rowId);
  res.done(`/imports/${batch.batch_id}${req.query.show === 'errors' ? '?show=errors' : ''}`, { batch }, 'Row removed from this upload.');
}

async function commit(req, res) {
  const out = await service.commitBatch(req.scope, req.user.userId, req.params.id);
  await audit.log(req, 'import_committed', {
    table: 'import_batches', recordId: out.batch.batch_id,
    newValues: { type: out.batch.import_type, inserted: out.inserted, updated: out.updated, effective_from: out.batch.effective_from },
  });
  const noun = out.batch.import_type === 'timetable' ? 'old slots replaced' : ['allocation', 'electives'].includes(out.batch.import_type) ? 'earlier rows replaced' : 'updated';
  // After the allocation of a class sheet, go straight on to its timetable.
  const next = out.batch.import_type === 'allocation' && out.batch.linked_batch_id ? out.batch.linked_batch_id : out.batch.batch_id;
  res.done(`/imports/${next}`, { inserted: out.inserted, updated: out.updated, next_batch_id: next !== out.batch.batch_id ? next : undefined },
    `Committed: ${out.inserted} added, ${out.updated} ${noun}.${next !== out.batch.batch_id ? ' Now check and commit the timetable.' : ''}`);
}

async function cancel(req, res) {
  const batch = await service.cancelBatch(req.scope, req.params.id);
  await audit.log(req, 'import_cancelled', { table: 'import_batches', recordId: batch.batch_id });
  res.done('/imports', {}, 'Upload cancelled. Nothing was written.');
}

// ---- set up what a class timetable sheet needs: programme, section, halls, hours, staff
function adminOnly(req) {
  if (!['admin', 'superadmin'].includes(req.user.role)) throw forbidden('Only the college admin can add programmes, halls, hours and staff.');
}
async function setupForm(req, res) {
  adminOnly(req);
  const plan = await setup.plan(req.scope, req.params.id);
  res.page('imports/setup', { title: 'Set up what is missing', ...plan });
}
async function setupApply(req, res) {
  adminOnly(req);
  const { batch, made } = await setup.apply(req.scope, req.user.userId, req.params.id, req.body);
  await audit.log(req, 'import_setup', { table: 'import_batches', recordId: batch.batch_id, newValues: made });
  const ONE = { departments: 'department', programs: 'programme', sections: 'class', rooms: 'hall', periods: 'hour', staff: 'staff member' };
  const MANY = { departments: 'departments', programs: 'programmes', sections: 'classes', rooms: 'halls', periods: 'hours', staff: 'staff members' };
  const parts = Object.entries(made).filter(([, n]) => n).map(([k, n]) => `${n} ${n === 1 ? ONE[k] : MANY[k]}`);
  res.done(`/imports/${batch.batch_id}`, { made }, parts.length ? `Added: ${parts.join(', ')}. New staff sign in with their staff code as the first password.` : 'Nothing was added.');
}

async function errors(req, res) {
  const { wb, batch } = await service.errorsWorkbook(req.scope, req.params.id);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="upload-${batch.batch_id}-errors.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

module.exports = { index, template, upload, show, updateRow, removeRow, commit, cancel, errors, setupForm, setupApply };
