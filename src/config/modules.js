'use strict';
// The module catalogue and the default permission matrix a new college starts from.
// Keys match attendance.modules.module_key (seeded by migration 001).
const V = 'view', E = 'edit', D = 'delete', X = 'export';
const ACTIONS = [V, E, D, X];
const ROLES = ['superadmin', 'admin', 'hod', 'staff', 'student'];
const ASSIGNABLE_ROLES = ['admin', 'hod', 'staff', 'student'];

const MODULES = [
  { key: 'dashboard', name: 'Dashboard' },
  { key: 'permissions', name: 'Module permissions' },
  { key: 'users', name: 'Users' },
  { key: 'academic_setup', name: 'Academic setup' },
  { key: 'master_data', name: 'Master data import' },
  { key: 'timetable', name: 'Timetable' },
  { key: 'attendance', name: 'Attendance' },
  { key: 'corrections', name: 'Corrections and manual marking' },
  { key: 'class_swaps', name: 'Class swaps' },
  { key: 'reports', name: 'Reports and defaulters' },
  { key: 'cameras', name: 'Cameras and unknown-face review' },
  { key: 'camera_view', name: 'AI camera view' },
  { key: 'notifications', name: 'Notifications' },
  { key: 'audit_log', name: 'Audit log' },
  { key: 'settings', name: 'Settings' },
];

const DEFAULT_MATRIX = {
  admin: {
    dashboard: [V, X], permissions: [V], users: [V, E, D], academic_setup: [V, E, D],
    master_data: [V, E], timetable: [V, E, D, X], attendance: [V, X], corrections: [V, E],
    class_swaps: [V, E], reports: [V, X], cameras: [V, E], camera_view: [V], notifications: [V],
    audit_log: [V, X], settings: [V, E],
  },
  hod: {
    dashboard: [V, X], users: [V, E], academic_setup: [V], master_data: [V, E],
    timetable: [V, E, X], attendance: [V, X], corrections: [V, E], class_swaps: [V, E],
    reports: [V, X], camera_view: [V], notifications: [V],
  },
  staff: {
    dashboard: [V], academic_setup: [V], timetable: [V], attendance: [V, X],
    corrections: [V, E], class_swaps: [V, E], reports: [V, X], camera_view: [V], notifications: [V],
  },
  student: {
    dashboard: [V], timetable: [V], attendance: [V], reports: [V], notifications: [V],
  },
};

module.exports = { ACTIONS, ROLES, ASSIGNABLE_ROLES, MODULES, DEFAULT_MATRIX };
