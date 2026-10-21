'use strict';
const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Today's date as YYYY-MM-DD in a time zone. */
function todayIn(tz = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
/** A real calendar date as YYYY-MM-DD (so 2007-02-31 is rejected, not rolled over). */
function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
/** ISO day of week: 1 = Monday ... 7 = Sunday. */
function isoDow(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return d === 0 ? 7 : d;
}
/** Accepts Monday, mon, 1..7 (1 = Monday). Returns 1..7 or null. */
function parseDay(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (/^[1-7]$/.test(s)) return parseInt(s, 10);
  const i = DAY_NAMES.findIndex((n) => n && (n.toLowerCase() === s || n.toLowerCase().slice(0, 3) === s.slice(0, 3)));
  return s.length >= 3 && i > 0 ? i : null;
}
function fmtTime(t) {
  return t ? String(t).slice(0, 5) : '';
}
function fmtDateTime(d, tz = 'Asia/Kolkata') {
  if (!d) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d));
}
function fmtClock(d, tz = 'Asia/Kolkata') {
  if (!d) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(d));
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(String(s).slice(0, 10) + 'T00:00:00Z');
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(d);
}

module.exports = { DAY_NAMES, todayIn, isDate, addDays, daysBetween, isoDow, parseDay, fmtTime, fmtDateTime, fmtClock, fmtDate };
