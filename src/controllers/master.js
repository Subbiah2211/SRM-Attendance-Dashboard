'use strict';
const entities = require('../config/entities');
const model = require('../models/master');
const audit = require('../services/audit');
const { forbidden, HttpError } = require('../utils/errors');
const { pager } = require('./helpers');

/** Each list belongs to a module; check that module's permission for the action. */
function guard(action) {
  return (req, res, next) => {
    const e = model.entity(req.params.entity);
    if (!req.can(e.module, action)) throw forbidden(`Your role does not have ${action} access to ${e.title.toLowerCase()}.`);
    req.entity = e;
    next();
  };
}

const tabs = (req, e) =>
  Object.entries(entities).filter(([, x]) => x.group === e.group && req.can(x.module, 'view')).map(([key, x]) => ({ key, title: x.title }));

async function fieldOptions(scope, e) {
  const out = {};
  for (const f of e.fields) {
    if (f.type !== 'select') continue;
    out[f.name] = f.choices ? f.choices.map((c) => ({ value: c, label: c })) : await model.options(scope, f.options);
  }
  return out;
}

async function index(req, res) {
  const e = req.entity, key = req.params.entity;
  const q = (req.query.q || '').trim();
  const pg = pager(req, 0);
  const { rows, total, headers } = await model.list(key, req.scope, pg, q, req.query);
  const filters = await model.filterOptions(key, req.scope);
  const writable = !(req.scope.role === 'hod' && !e.departmentCol && !e.hodWritable);
  res.page('master/list', {
    title: e.title, entityKey: key, entity: { title: e.title, one: e.one }, headers, rows, q, filters,
    pager: pager(req, total), tabs: tabs(req, e),
    canEdit: writable && req.can(e.module, 'edit') && !!req.scope.collegeId,
    canAdd: writable && !e.noCreate && req.can(e.module, 'edit') && !!req.scope.collegeId,
    canDelete: writable && !e.noDelete && req.can(e.module, 'delete'),
    // The upload that fills this list, when the role may use it.
    uploadType: e.upload && req.can('master_data', 'edit') && !!req.scope.collegeId && !(req.scope.role === 'hod' && ['departments', 'classrooms'].includes(e.upload)) ? e.upload : null,
  });
}

async function form(req, res, values, errors) {
  const e = req.entity, key = req.params.entity;
  const row = values || (req.params.id ? await model.get(key, req.scope, req.params.id) : Object.fromEntries(e.fields.filter((f) => f.default !== undefined).map((f) => [f.name, f.default])));
  res.page('master/form', {
    title: `${req.params.id ? 'Edit' : 'Add'} ${e.one}`, entityKey: key, entity: { title: e.title, one: e.one },
    fields: e.fields.filter((f) => !(f.onCreateOnly && req.params.id)), row, id: req.params.id || null,
    options: await fieldOptions(req.scope, e), errors: errors || [],
  });
}

async function save(req, res) {
  const e = req.entity, key = req.params.entity;
  const id = req.params.id || null;
  try {
    const before = id ? await model.get(key, req.scope, id) : null;
    const row = await model.save(key, req.scope, id, req.body || {});
    await audit.log(req, `${key}_${id ? 'updated' : 'created'}`, { table: e.table, recordId: row[e.pk], oldValues: before, newValues: row });
    res.done(`/master/${key}`, { row }, `${e.one[0].toUpperCase()}${e.one.slice(1)} saved.`);
  } catch (err) {
    // Show the form again with what was typed and what is wrong.
    const known = err instanceof HttpError && err.status === 422;
    const dup = err.code === '23505';
    if (req.isApi || !(known || dup || err.status === 422)) throw err;
    res.status(422);
    await form(req, res, req.body, dup ? [{ field: '', message: `That ${e.one} already exists.` }] : err.errors || [{ field: '', message: err.message }]);
  }
}

async function remove(req, res) {
  const e = req.entity, key = req.params.entity;
  const row = await model.remove(key, req.scope, req.params.id);
  await audit.log(req, `${key}_deleted`, { table: e.table, recordId: row[e.pk], oldValues: row });
  res.done(`/master/${key}`, {}, `${e.one[0].toUpperCase()}${e.one.slice(1)} deleted.`);
}

module.exports = { guard, index, form: (req, res) => form(req, res), save, remove };
