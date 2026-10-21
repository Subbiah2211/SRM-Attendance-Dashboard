'use strict';
const { HttpError } = require('../utils/errors');

/**
 * Module permission check: the first of the two checks every request passes
 * (the second, data scope, is applied inside the models).
 *   router.get('/attendance', permit('attendance', 'view'), ...)
 */
function permit(moduleKey, action = 'view') {
  return function permitMiddleware(req, res, next) {
    if (req.can && req.can(moduleKey, action)) return next();
    throw new HttpError(403, 'forbidden', `Your role does not have ${action} access to this module.`);
  };
}

/** Passes when any of the [module, action] pairs is allowed. */
function permitAny(...pairs) {
  return function permitAnyMiddleware(req, res, next) {
    if (req.can && pairs.some(([m, a]) => req.can(m, a))) return next();
    throw new HttpError(403, 'forbidden', 'Your role does not have access to this module.');
  };
}

module.exports = { permit, permitAny };
