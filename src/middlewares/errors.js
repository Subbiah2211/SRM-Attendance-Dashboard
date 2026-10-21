'use strict';
const multer = require('multer');
const { HttpError, fromPg } = require('../utils/errors');

function notFoundHandler(req, res, next) {
  next(new HttpError(404, 'not_found', 'Page not found.'));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let e = fromPg(err);
  if (e instanceof multer.MulterError) {
    e = new HttpError(413, 'upload_rejected', e.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than the upload limit.' : e.message);
  }
  const status = e.status || 500;
  if (status >= 500) console.error('[error]', req.method, req.originalUrl, e);
  const message = status >= 500 ? 'Something went wrong on the server.' : e.message;

  if (req.isApi) {
    return res.status(status).json({ code: e.code || 'server_error', message, errors: e.errors || undefined });
  }
  if (status === 401) return res.redirect('/login');
  // A rejected form goes back where it came from with the reason shown.
  if (req.method !== 'GET' && status < 500 && status !== 403 && status !== 404) {
    res.flash('error', message);
    const back = req.get('referer');
    let target = '/dashboard';
    try {
      if (back && new URL(back).host === req.get('host')) target = new URL(back).pathname + new URL(back).search;
    } catch { /* keep the default */ }
    return res.redirect(303, target);
  }
  res.status(status);
  res.render('error', { title: status === 404 ? 'Not found' : status === 403 ? 'No access' : 'Error', status, message }, (renderErr, html) => {
    if (renderErr) return res.type('text').send(`${status} ${message}`);
    res.send(html);
  });
}

module.exports = { notFoundHandler, errorHandler };
