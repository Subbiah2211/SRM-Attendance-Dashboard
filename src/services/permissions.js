'use strict';
const db = require('../config/db');
const { MODULES, ACTIONS, ASSIGNABLE_ROLES, DEFAULT_MATRIX } = require('../config/modules');

const cache = new Map(); // collegeId -> { at, matrix }
const TTL_MS = 30000;
const FULL = Object.fromEntries(ACTIONS.map((a) => [a, true]));
const NONE = Object.fromEntries(ACTIONS.map((a) => [a, false]));

/** matrix[role][module] = { view, edit, delete, export } for one college. */
async function getMatrix(collegeId) {
  const hit = cache.get(collegeId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.matrix;
  const rows = await db.many(
    `SELECT r.role_name, m.module_key, p.can_view, p.can_edit, p.can_delete, p.can_export
       FROM attendance.role_module_permissions p
       JOIN attendance.roles r ON r.role_id = p.role_id
       JOIN attendance.modules m ON m.module_id = p.module_id
      WHERE p.college_id = $1`,
    [collegeId]
  );
  const matrix = {};
  for (const role of ASSIGNABLE_ROLES) {
    matrix[role] = {};
    for (const m of MODULES) matrix[role][m.key] = { ...NONE };
  }
  for (const r of rows) {
    if (!matrix[r.role_name] || !matrix[r.role_name][r.module_key]) continue;
    matrix[r.role_name][r.module_key] = { view: r.can_view, edit: r.can_edit, delete: r.can_delete, export: r.can_export };
  }
  cache.set(collegeId, { at: Date.now(), matrix });
  return matrix;
}

/** Permissions of one user: superadmin has everything, always. */
async function forUser(user, scope) {
  if (user.role === 'superadmin') return Object.fromEntries(MODULES.map((m) => [m.key, { ...FULL }]));
  if (!scope.collegeId) return Object.fromEntries(MODULES.map((m) => [m.key, { ...NONE }]));
  return (await getMatrix(scope.collegeId))[user.role] || {};
}

function defaultMatrix() {
  const matrix = {};
  for (const role of ASSIGNABLE_ROLES) {
    matrix[role] = {};
    for (const m of MODULES) {
      const allowed = (DEFAULT_MATRIX[role] || {})[m.key] || [];
      matrix[role][m.key] = Object.fromEntries(ACTIONS.map((a) => [a, allowed.includes(a)]));
    }
  }
  return matrix;
}

/** Replace a college's whole matrix. Only called for the superadmin. Returns { before, after }. */
async function saveMatrix(collegeId, matrix, userId, client) {
  const before = await getMatrix(collegeId);
  const run = async (c) => {
    for (const role of ASSIGNABLE_ROLES) {
      for (const m of MODULES) {
        const cell = (matrix[role] || {})[m.key] || NONE;
        const view = !!cell.view; // other actions need view
        await c.query(
          `INSERT INTO attendance.role_module_permissions
             (college_id, role_id, module_id, can_view, can_edit, can_delete, can_export, updated_by, updated_at)
           SELECT $1, r.role_id, m.module_id, $4, $5, $6, $7, $8, now()
             FROM attendance.roles r, attendance.modules m
            WHERE r.role_name = $2 AND m.module_key = $3
           ON CONFLICT (college_id, role_id, module_id) DO UPDATE
             SET can_view = EXCLUDED.can_view, can_edit = EXCLUDED.can_edit,
                 can_delete = EXCLUDED.can_delete, can_export = EXCLUDED.can_export,
                 updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [collegeId, role, m.key, view, view && !!cell.edit, view && !!cell.delete, view && !!cell.export, userId || null]
        );
      }
    }
  };
  if (client) await run(client);
  else await db.tx(run);
  cache.delete(collegeId);
  return { before, after: client ? matrix : await getMatrix(collegeId) };
}

const seedDefaults = (collegeId, userId, client) => saveMatrix(collegeId, defaultMatrix(), userId, client);

/** Changed cells between two matrices, for the audit log. */
function diff(before, after) {
  const changes = [];
  for (const role of ASSIGNABLE_ROLES) {
    for (const m of MODULES) {
      const a = (before[role] || {})[m.key] || NONE;
      const b = (after[role] || {})[m.key] || NONE;
      if (ACTIONS.some((x) => !!a[x] !== !!b[x])) changes.push({ role, module: m.key, from: a, to: b });
    }
  }
  return changes;
}

module.exports = { getMatrix, forUser, defaultMatrix, saveMatrix, seedDefaults, diff, invalidate: (id) => cache.delete(id) };
