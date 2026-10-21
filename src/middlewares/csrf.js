'use strict';
const config = require('../config/env');
const { hmac, safeEqual } = require('../utils/crypto');
const { HttpError } = require('../utils/errors');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const tokenFor = (req) => (req.sessionToken ? hmac(config.sessionSecret, 'csrf:' + req.sessionToken) : '');

function check(req) {
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  if (!safeEqual(sent, tokenFor(req))) throw new HttpError(403, 'bad_csrf', 'This form has expired. Reload the page and try again.');
}

/** Session-bound CSRF token on every state-changing request of a signed-in user. */
function csrf(req, res, next) {
  res.locals.csrfToken = tokenFor(req);
  if (SAFE.has(req.method) || !req.user) return next();
  // Multipart bodies are not parsed yet; the upload middleware calls csrfAfterUpload.
  if ((req.get('content-type') || '').startsWith('multipart/form-data')) return next();
  check(req);
  next();
}
function csrfAfterUpload(req, res, next) {
  check(req);
  next();
}

module.exports = { csrf, csrfAfterUpload, tokenFor };
