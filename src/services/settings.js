'use strict';
const db = require('../config/db');

// Known settings: key -> { type, label }. Values live in attendance.system_settings;
// a row with college_id NULL is the group default, a college row overrides it.
const KEYS = {
  early_entry_minutes: { type: 'int', min: 0, max: 60, label: 'Early entry window (minutes)' },
  late_after_minutes: { type: 'int', min: 0, max: 120, label: 'Late after (minutes)' },
  absent_grace_minutes: { type: 'int', min: 0, max: 120, label: 'Wait before marking absentees (minutes)' },
  min_presence_minutes: { type: 'int', min: 0, max: 180, label: 'Minimum presence (minutes, 0 = off)' },
  min_confidence: { type: 'float', min: 0, max: 1, label: 'Minimum recognition confidence (0 to 1)' },
  defaulter_threshold_pct: { type: 'float', min: 0, max: 100, label: 'Defaulter threshold (%)' },
  defaulter_warning_pct: { type: 'float', min: 0, max: 100, label: 'Warning level (%)' },
  defaulter_critical_pct: { type: 'float', min: 0, max: 100, label: 'Critical level (%)' },
  excused_counts_as_attended: { type: 'bool', label: 'Excused counts as attended', hint: 'Off: excused periods are left out of the total instead.' },
  staff_correction_window_hours: { type: 'int', min: 0, max: 8760, label: 'Staff correction window (hours)' },
  session_idle_minutes: { type: 'int', min: 5, max: 1440, label: 'Idle logout (minutes)' },
  login_max_attempts: { type: 'int', min: 3, max: 20, label: 'Failed logins before lock' },
  login_lock_minutes: { type: 'int', min: 1, max: 1440, label: 'Account lock time (minutes)' },
  import_max_mb: { type: 'int', min: 1, max: 50, label: 'Largest upload (MB)' },
  import_max_rows: { type: 'int', min: 1, max: 50000, label: 'Most rows per upload' },
  close_catchup_days: { type: 'int', min: 0, max: 14, label: 'Period-close catch-up (days)' },
  // Not in the database until someone changes them: the default below applies.
  require_face_enrolment: { type: 'bool', label: 'Students must enrol their face at first sign-in', default: true, hint: 'Off: students reach the dashboard without enrolling; photos are then enrolled by the office.' },
  enroll_min_photos: { type: 'int', min: 1, max: 6, label: 'Photos needed for face enrolment', default: 3 },
};

const cache = new Map(); // collegeId|0 -> { at, values }
const TTL_MS = 30000;

async function load(collegeId) {
  const key = collegeId || 0;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.values;
  const rows = await db.many(
    `SELECT setting_key, setting_value, college_id FROM attendance.system_settings
      WHERE college_id IS NULL OR college_id = $1
      ORDER BY college_id NULLS FIRST`,
    [collegeId || null]
  );
  const values = {};
  for (const r of rows) values[r.setting_key] = r.setting_value; // college rows come last and win
  cache.set(key, { at: Date.now(), values });
  return values;
}

function cast(key, raw) {
  const def = KEYS[key];
  if (!def || raw === undefined || raw === null) return raw;
  if (def.type === 'int') return parseInt(raw, 10);
  if (def.type === 'float') return parseFloat(raw);
  if (def.type === 'bool') return String(raw) === 'true';
  return raw;
}

/** All settings for a college as typed values. */
async function all(collegeId) {
  const raw = await load(collegeId);
  const out = {};
  for (const k of Object.keys(KEYS)) out[k] = raw[k] === undefined ? KEYS[k].default : cast(k, raw[k]);
  return out;
}
async function get(collegeId, key, fallback) {
  const v = (await all(collegeId))[key];
  return v === undefined || v === null || Number.isNaN(v) ? fallback : v;
}

/** Save overrides for a college (or group defaults when collegeId is null). */
async function save(collegeId, values) {
  const clean = {};
  for (const [k, def] of Object.entries(KEYS)) {
    if (values[k] === undefined) continue;
    let v = values[k];
    if (def.type === 'bool') v = v === true || v === 'true' || v === 'on' ? 'true' : 'false';
    else {
      const n = def.type === 'int' ? parseInt(v, 10) : parseFloat(v);
      if (Number.isNaN(n) || n < def.min || n > def.max) {
        const e = new Error(`${def.label}: enter a number from ${def.min} to ${def.max}`);
        e.status = 422;
        throw e;
      }
      v = String(n);
    }
    clean[k] = v;
  }
  await db.tx(async (c) => {
    for (const [k, v] of Object.entries(clean)) {
      await c.query(
        `INSERT INTO attendance.system_settings (college_id, setting_key, setting_value)
         VALUES ($1, $2, $3)
         ON CONFLICT (COALESCE(college_id, 0), setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
        [collegeId || null, k, v]
      );
    }
  });
  cache.clear();
  return clean;
}

module.exports = { KEYS, all, get, save, clearCache: () => cache.clear() };
