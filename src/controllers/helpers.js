'use strict';
const { todayIn, isDate, daysBetween } = require('../utils/dates');
const { invalid } = require('../utils/errors');
const { paging } = require('../utils/sql');

const idOrNull = (v) => (/^\d+$/.test(String(v === undefined || v === null ? '' : v)) ? parseInt(v, 10) : null);

/** date=YYYY-MM-DD, or from/to. Defaults to today in the college's time zone. */
function dateRange(q, tz, maxDays = 92) {
  const today = todayIn(tz);
  let from = isDate(q.from) ? q.from : isDate(q.date) ? q.date : today;
  let to = isDate(q.to) ? q.to : isDate(q.date) ? q.date : from;
  if (to < from) [from, to] = [to, from];
  if (daysBetween(from, to) > maxDays) throw invalid(`Choose a range of ${maxDays} days or less.`);
  return { from, to, today };
}

function pager(req, total, size = 50) {
  const pg = paging(req.query, size);
  return { ...pg, total, pages: Math.max(Math.ceil(total / pg.size), 1) };
}

module.exports = { idOrNull, dateRange, pager, paging };
