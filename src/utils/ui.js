'use strict';
// HTML helpers for the views: icons, avatars, status chips, percentage bars.
// Status is always shown as a word as well as a colour.

const esc = (v) => String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 24 x 24 line icons, drawn for this project (currentColor, no fill).
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7.5" height="9" rx="2"/><rect x="13.5" y="3" width="7.5" height="5.5" rx="2"/><rect x="13.5" y="11.5" width="7.5" height="9.5" rx="2"/><rect x="3" y="15" width="7.5" height="6" rx="2"/>',
  attendance: '<rect x="5" y="4.5" width="14" height="16.5" rx="2.5"/><path d="M9 4.5v-.7a1.3 1.3 0 0 1 1.3-1.3h3.4A1.3 1.3 0 0 1 15 3.8v.7"/><path d="m8.8 13.2 2.3 2.3 4.2-4.6"/>',
  timetable: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4M8 14h2.5M13.5 14H16M8 17h2.5"/>',
  layers: '<path d="m12 3 9 4.5-9 4.5-9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
  cap: '<path d="m2.5 9.5 9.5-4.5 9.5 4.5-9.5 4.5z"/><path d="M6.5 11.6V16c0 1.4 2.5 2.8 5.5 2.8s5.5-1.4 5.5-2.8v-4.4M21.5 9.5V15"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19.5c0-3.2 2.7-5.3 6-5.3s6 2.1 6 5.3"/><circle cx="17" cy="9.5" r="2.5"/><path d="M16.5 14.4c2.6.2 4.5 2 4.5 4.6"/>',
  camera: '<rect x="3" y="7" width="12.5" height="10" rx="2.5"/><path d="m15.5 10.5 5-2.8v8.6l-5-2.8"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  logout: '<path d="M14 4.5H7.5A2.5 2.5 0 0 0 5 7v10a2.5 2.5 0 0 0 2.5 2.5H14"/><path d="M10.5 12H20m-3.5-3.5L20 12l-3.5 3.5"/>',
  key: '<circle cx="8" cy="15" r="3.5"/><path d="m10.6 12.4 8.4-8.4M16 7l2.5 2.5M13.5 9.5l2 2"/>',
  download: '<path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19.5h14"/>',
  upload: '<path d="M12 15.5v-11M7.5 9 12 4.5 16.5 9M5 19.5h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8.3 12.3 2.5 2.5 4.9-5.2"/>',
  cross: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.3 2"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  gauge: '<path d="M4.5 16.5a8 8 0 1 1 15 0"/><path d="m12 13 4-4.5"/><circle cx="12" cy="13.5" r="1.2"/>',
  building: '<rect x="4.5" y="3.5" width="10" height="17" rx="1.5"/><path d="M14.5 9.5h4a1 1 0 0 1 1 1v10h-5M8 7.5h3M8 11h3M8 14.5h3M3 20.5h18"/>',
  file: '<path d="M7 3.5h7l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M14 3.5V8h4.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  shield: '<path d="M12 3 5 5.8v5.4c0 4.4 2.9 8 7 9.8 4.1-1.8 7-5.4 7-9.8V5.8z"/><path d="m9 12 2.2 2.2L15 10.3"/>',
  student: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/>',
  swap: '<path d="M4 8h13m-3.5-3.5L17 8l-3.5 3.5M20 16H7m3.5-3.5L7 16l3.5 3.5"/>',
  book: '<path d="M5 4.5h11a2.5 2.5 0 0 1 2.5 2.5v12.5H7.5A2.5 2.5 0 0 1 5 17z"/><path d="M5 17a2.5 2.5 0 0 1 2.5-2.5h11M9 8.5h6"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  door: '<path d="M6 20.5V5a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 18 5v15.5M3.5 20.5h17M14.5 12v1"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  badge: '<rect x="4" y="5.5" width="16" height="14" rx="2.5"/><path d="M9.5 5.5V4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5"/><circle cx="12" cy="11" r="2.2"/><path d="M8.3 16.5c.6-1.6 2-2.4 3.7-2.4s3.1.8 3.7 2.4"/>',
  list: '<path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11"/><circle cx="4.5" cy="6.5" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="17.5" r="1"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  filter: '<path d="M4 5.5h16l-6 7.2V19l-4-2v-4.3z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/>',
};

function icon(name, size = 20) {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// The product mark: a register page with a tick.
const logo = (size = 34) =>
  `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 34 34" aria-hidden="true"><rect width="34" height="34" rx="9" fill="var(--brand)"/><path d="M9 11h16M9 17h7M9 23h5" stroke="#fff" stroke-opacity=".55" stroke-width="2" stroke-linecap="round"/><path d="m17.5 21 3 3 5.5-6.5" stroke="var(--accent)" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** Initials on a colour picked from the name, so the same person always looks the same. */
function avatar(name, size = '') {
  const clean = String(name || '?').trim();
  const parts = clean.split(/\s+/);
  const initials = ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  let h = 0;
  for (const ch of clean) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `<span class="avatar ${size}" style="--h:${h}" aria-hidden="true">${esc(initials)}</span>`;
}

/** A stable hue (0-359) for a code, used to tint timetable tiles per subject. */
function hue(text) {
  let h = 2166136261; // FNV-1a, so codes that differ by one digit land far apart
  for (const ch of String(text || '')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

const RECORD_LABEL = { present: 'Present', late: 'Late', absent: 'Absent', excused: 'Excused' };
const SESSION_LABEL = { scheduled: 'Open', closed: 'Closed', needs_manual: 'Needs manual marking', cancelled: 'Cancelled' };

const band = (p, threshold = 75) => (p === null || p === undefined ? 'none' : p >= threshold ? 'good' : p >= threshold - 15 ? 'warn' : 'bad');

module.exports = {
  esc, icon, logo, avatar, band, hue,
  status: (s) => `<span class="chip chip-${s || 'none'}">${RECORD_LABEL[s] || 'Not marked'}</span>`,
  session: (s) => `<span class="chip chip-s-${s}">${SESSION_LABEL[s] || esc(s)}</span>`,
  /** Percentage with a bar. threshold colours the bar: at or above it is good. */
  pct: (p, threshold = 75) => (p === null || p === undefined
    ? '<span class="muted">no marks yet</span>'
    : `<span class="pct pct-${band(p, threshold)}"><span class="pct-bar" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, p))}%"></i></span><b>${p}%</b></span>`),
  role: (r) => ({ superadmin: 'Superadmin', admin: 'Admin', hod: 'HOD', staff: 'Staff', student: 'Student' }[r] || r),
};
