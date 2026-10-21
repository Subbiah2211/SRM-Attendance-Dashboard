'use strict';
// The sidebar: groups with submenus. An item is shown when the role has view
// permission on its module, so the menu follows the superadmin's permission matrix.
const { todayIn, addDays } = require('../utils/dates');

const master = (key, label, moduleKey, icon) => ({ label, icon, href: `/master/${key}`, module: moduleKey, test: (p) => p.startsWith(`/master/${key}`) });

function definition(req) {
  const role = req.user.role;
  const today = todayIn(req.scope.timezone);
  return [
    { key: 'dashboard', label: 'Dashboard', icon: 'dashboard', href: '/dashboard', module: 'dashboard', test: (p) => p === '/dashboard' },
    {
      key: 'attendance', label: 'Attendance', icon: 'attendance',
      test: (p) => p.startsWith('/students/'),
      children: [
        { label: 'Period-wise attendance', icon: 'list', href: '/attendance', module: 'attendance', test: (p, q) => p.startsWith('/attendance') && q.status !== 'needs_manual' },
        { label: 'Needs manual marking', icon: 'alert', href: `/attendance?status=needs_manual&from=${addDays(today, -7)}&to=${today}`, module: 'corrections', hide: role === 'student', test: (p, q) => p === '/attendance' && q.status === 'needs_manual' },
        { label: 'Face enrolment', icon: 'camera', href: '/enroll', module: 'attendance', hide: role !== 'student', test: (p) => p === '/enroll' },
        { label: 'My attendance', icon: 'user', href: '/students/me/attendance', module: 'attendance', hide: role !== 'student', test: (p) => p.startsWith('/students/') },
        { label: 'Defaulters', icon: 'gauge', href: '/reports/defaulters', module: 'reports', test: (p) => p.startsWith('/reports') },
      ],
    },
    {
      key: 'timetable', label: 'Timetable', icon: 'timetable',
      children: [
        { label: 'Weekly timetable', icon: 'grid', href: '/timetable', module: 'timetable', test: (p) => p.startsWith('/timetable') },
        { label: 'Class swaps', icon: 'swap', href: '/class-swaps', module: 'class_swaps', test: (p) => p.startsWith('/class-swaps') },
      ],
    },
    {
      key: 'master', label: 'Master data', icon: 'layers',
      children: [
        { label: 'Uploads', icon: 'upload', href: '/imports', module: 'master_data', test: (p, q) => p.startsWith('/imports') && !(p === '/imports' && ['staff', 'students'].includes(q.type)) },
        master('departments', 'Departments', 'master_data', 'building'),
        master('programs', 'Programs', 'master_data', 'cap'),
        master('subjects', 'Subjects', 'master_data', 'book'),
        master('sections', 'Sections', 'master_data', 'users'),
        master('allocations', 'Subject allocation', 'master_data', 'layers'),
      ],
    },
    {
      key: 'academic', label: 'Academic setup', icon: 'cap',
      children: [
        master('academic-years', 'Academic years', 'academic_setup', 'timetable'),
        master('semesters', 'Semesters', 'academic_setup', 'list'),
        master('periods', 'Periods', 'academic_setup', 'clock'),
        master('classrooms', 'Classrooms', 'academic_setup', 'door'),
        master('holidays', 'Holidays', 'academic_setup', 'sun'),
        master('working-days', 'Working-day overrides', 'academic_setup', 'check'),
      ],
    },
    {
      key: 'people', label: 'People', icon: 'users',
      children: [
        { label: 'Users and sign-ins', icon: 'key', href: '/users', module: 'users', test: (p) => p.startsWith('/users') },
        { ...master('staff-list', 'Staff details', 'users', 'badge'), hide: !req.scope.collegeId },
        { ...master('students', 'Student details', 'users', 'student'), hide: !req.scope.collegeId },
        { label: 'Upload staff', icon: 'upload', href: '/imports?type=staff', module: 'master_data', hide: !req.scope.collegeId || !req.can('users'), test: (p, q) => p === '/imports' && q.type === 'staff' },
        { label: 'Upload students', icon: 'upload', href: '/imports?type=students', module: 'master_data', hide: !req.scope.collegeId || !req.can('users'), test: (p, q) => p === '/imports' && q.type === 'students' },
      ],
    },
    {
      key: 'cameras', label: 'Cameras', icon: 'camera',
      children: [
        { label: 'AI camera view', icon: 'eye', href: '/cameras/view', module: 'camera_view', test: (p) => p.startsWith('/cameras/view') },
        { label: 'Camera health', icon: 'gauge', href: '/cameras/health', module: 'cameras', test: (p) => p.startsWith('/cameras/health') },
        master('cameras', 'Camera mapping', 'cameras', 'door'),
        { label: 'Unknown faces', icon: 'search', href: '/unknown-detections', module: 'cameras', test: (p) => p.startsWith('/unknown-detections') },
      ],
    },
    {
      key: 'admin', label: 'Administration', icon: 'sliders',
      children: [
        { label: 'Colleges', icon: 'building', href: '/colleges', superOnly: true, test: (p) => p.startsWith('/colleges') && !p.endsWith('/permissions') },
        { label: 'Module permissions', icon: 'shield', href: '/permissions', module: 'permissions', test: (p) => p === '/permissions' || p.endsWith('/permissions') },
        { label: 'Settings', icon: 'sliders', href: '/settings', module: 'settings', test: (p) => p.startsWith('/settings') },
        { label: 'Audit log', icon: 'file', href: '/audit-logs', module: 'audit_log', test: (p) => p.startsWith('/audit-logs') },
      ],
    },
  ];
}

/** The menu for this request: [{ key, label, icon, href?, active, children?: [{ label, href, active }] }] plus the breadcrumb. */
function build(req) {
  // Until a student has enrolled, every other page sends them back here, so the menu offers nothing else.
  if (req.user.mustEnrolFace) return { menu: [{ key: 'enrol', label: 'Face enrolment', icon: 'camera', href: '/enroll', active: true }], crumbs: ['Face enrolment'] };
  const p = req.path, q = req.query || {};
  const allowed = (i) => !i.hide && (i.superOnly ? req.user.role === 'superadmin' : req.can(i.module, 'view'));
  const menu = [];
  let crumbs = [];
  for (const g of definition(req)) {
    if (!g.children) {
      if (!allowed(g)) continue;
      const active = g.test(p, q);
      if (active) crumbs = [g.label];
      menu.push({ key: g.key, label: g.label, icon: g.icon, href: g.href, active });
      continue;
    }
    const children = g.children.filter(allowed).map((c) => ({ label: c.label, icon: c.icon || 'list', href: c.href, active: c.test(p, q) }));
    if (!children.length) continue;
    const hit = children.find((c) => c.active);
    const active = !!hit || !!(g.test && g.test(p, q));
    if (active) crumbs = hit ? [g.label, hit.label] : [g.label];
    // One visible child: a plain link is clearer than a group of one.
    if (children.length === 1) menu.push({ key: g.key, label: children[0].label, icon: g.icon, href: children[0].href, active });
    else menu.push({ key: g.key, label: g.label, icon: g.icon, active, children });
  }
  return { menu, crumbs };
}

module.exports = { build };
