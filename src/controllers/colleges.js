'use strict';
const { z } = require('zod');
const db = require('../config/db');
const model = require('../models/colleges');
const permissions = require('../services/permissions');
const audit = require('../services/audit');
const { parse, notFound } = require('../utils/errors');
const { MODULES, ASSIGNABLE_ROLES, ACTIONS } = require('../config/modules');

const schema = z.object({
  college_code: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,40}$/, 'use 2 to 40 lower-case letters, digits or dashes'),
  college_name: z.string().trim().min(2).max(160),
  campus: z.string().trim().max(120).optional(),
  timezone: z.string().trim().min(3).max(60).default('Asia/Kolkata'),
  is_active: z.preprocess((v) => v === true || v === 'on' || v === 'true', z.boolean()),
});

const index = async (req, res) => res.page('colleges/index', { title: 'Colleges', colleges: await model.list() });

async function form(req, res) {
  const college = req.params.id ? await model.get(req.params.id) : { is_active: true, timezone: 'Asia/Kolkata' };
  if (!college) throw notFound('That college does not exist.');
  res.page('colleges/form', { title: college.college_id ? 'Edit college' : 'Add a college', college });
}

async function save(req, res) {
  const v = parse(schema, req.body);
  try {
    new Intl.DateTimeFormat('en', { timeZone: v.timezone });
  } catch {
    throw Object.assign(new Error('Time zone is not valid. Use a name such as Asia/Kolkata.'), { status: 422 });
  }
  if (req.params.id) {
    const before = await model.get(req.params.id);
    if (!before) throw notFound('That college does not exist.');
    const after = await model.update(before.college_id, v);
    await audit.log(req, 'college_updated', { table: 'colleges', recordId: after.college_id, oldValues: before, newValues: after, collegeId: after.college_id });
    return res.done('/colleges', { college: after }, 'College saved.');
  }
  // A new college starts from the default permission matrix.
  const college = await db.tx(async (c) => {
    const row = await model.create(v, c);
    await permissions.seedDefaults(row.college_id, req.user.userId, c);
    return row;
  });
  await audit.log(req, 'college_created', { table: 'colleges', recordId: college.college_id, newValues: college, collegeId: college.college_id });
  res.done('/colleges', { college }, `${college.college_name} added with the default module permissions.`);
}

/** Superadmin: choose the college to work in (or leave, with id 0). */
async function enter(req, res) {
  const id = parseInt(req.params.id, 10) || null;
  if (id && !(await model.get(id))) throw notFound('That college does not exist.');
  await model.setContext(req.sessionId, id);
  res.done(id ? '/dashboard' : '/colleges', { college_id: id });
}

// ---------------------------------------------------------------- module permissions
function target(req) {
  // Superadmin: the college in the URL, else the one they are working in. Admin: own college only.
  if (req.user.role === 'superadmin') return parseInt(req.params.id, 10) || req.scope.collegeId;
  return req.scope.collegeId;
}

async function showPermissions(req, res) {
  const collegeId = target(req);
  if (!collegeId) return res.done('/colleges', {}, undefined);
  const college = await model.get(collegeId);
  if (!college) throw notFound('That college does not exist.');
  res.page('permissions/matrix', {
    title: 'Module permissions', college, matrix: await permissions.getMatrix(collegeId),
    modules: MODULES, roles: ASSIGNABLE_ROLES, actions: ACTIONS, editable: req.user.role === 'superadmin',
  });
}

async function savePermissions(req, res) {
  const collegeId = target(req);
  const college = collegeId && (await model.get(collegeId));
  if (!college) throw notFound('That college does not exist.');
  let matrix;
  if (req.body && req.body.reset) matrix = permissions.defaultMatrix();
  else {
    // Form posts perm[role][module][action]=on; the API posts { matrix: { role: { module: { view: true } } } }.
    const src = (req.body && (req.body.matrix || req.body.perm)) || {};
    matrix = {};
    for (const role of ASSIGNABLE_ROLES) {
      matrix[role] = {};
      for (const m of MODULES) {
        const cell = (src[role] || {})[m.key] || {};
        matrix[role][m.key] = Object.fromEntries(ACTIONS.map((a) => [a, cell[a] === true || cell[a] === 'on' || cell[a] === 'true']));
      }
    }
  }
  const { before, after } = await permissions.saveMatrix(collegeId, matrix, req.user.userId);
  const changes = permissions.diff(before, after);
  if (changes.length) {
    await audit.log(req, req.body && req.body.reset ? 'permissions_reset' : 'permissions_changed', {
      table: 'role_module_permissions', recordId: collegeId, collegeId,
      oldValues: changes.map((c) => ({ role: c.role, module: c.module, ...c.from })),
      newValues: changes.map((c) => ({ role: c.role, module: c.module, ...c.to })),
    });
  }
  res.done(`/colleges/${collegeId}/permissions`, { changed: changes.length, matrix: after }, changes.length ? `${changes.length} permission cells changed.` : 'Nothing changed.');
}

const modules = (req, res) => res.json({ modules: MODULES, actions: ACTIONS, roles: ASSIGNABLE_ROLES });

module.exports = { index, form, save, enter, showPermissions, savePermissions, modules };
