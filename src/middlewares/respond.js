'use strict';
const dates = require('../utils/dates');
const ui = require('../utils/ui');
const menu = require('../config/menu');
const notifications = require('../services/notifications');
const { tokenFor } = require('./csrf');

const FLASH = 'flash';

/** res.page / res.done / res.flash: one controller serves both HTML pages and /api/v1 JSON. */
function respond(req, res, next) {
  req.isApi = req.originalUrl.startsWith('/api/');

  res.flash = (kind, message) => {
    if (!req.isApi) res.cookie(FLASH, JSON.stringify({ kind, message }), { httpOnly: true, sameSite: 'lax', maxAge: 60000 });
  };
  res.page = (view, data = {}) => (req.isApi ? res.json(data) : res.render(view, data));
  res.done = (url, data = {}, message) => {
    if (req.isApi) return res.json({ ok: true, message: message || undefined, ...data });
    if (message) res.flash('ok', message);
    res.redirect(303, url);
  };

  res.locals.flash = null;
  if (!req.isApi && req.cookies && req.cookies[FLASH]) {
    try {
      res.locals.flash = JSON.parse(req.cookies[FLASH]);
    } catch { /* ignore a damaged cookie */ }
    // The message is used up only when a page is shown: a request that just redirects
    // (the dashboard sending a student on to the enrolment page) must pass it along.
    const render = res.render.bind(res);
    res.render = (...args) => { res.clearCookie(FLASH); return render(...args); };
  }
  next();
}

/** Values every view can use. Runs after loadSession. */
async function viewLocals(req, res, next) {
  const user = req.user || null;
  Object.assign(res.locals, {
    user,
    // Named 'my' because EJS treats a local called 'scope' as one of its own options.
    my: req.scope || { collegeId: null, timezone: 'Asia/Kolkata' },
    can: req.can || (() => false),
    csrfToken: tokenFor(req),
    path: req.path,
    query: req.query,
    title: 'Attendance',
    unread: 0,
    menu: [],
    crumbs: [],
    dates,
    ui,
    qs: (extra = {}) => {
      const merged = { ...req.query, ...extra };
      const out = Object.entries(merged).filter(([, v]) => v !== undefined && v !== null && v !== '');
      return out.length ? '?' + out.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
    },
  });
  if (user && !req.isApi) {
    Object.assign(res.locals, menu.build(req));
    res.locals.unread = await notifications.unreadCount(user.userId).catch(() => 0);
  }
  next();
}

module.exports = { respond, viewLocals };
