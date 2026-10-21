'use strict';
class HttpError extends Error {
  constructor(status, code, message, errors) {
    super(message);
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}
const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);
const forbidden = (msg = 'You do not have permission for this') => new HttpError(403, 'forbidden', msg);
const badRequest = (msg, errors) => new HttpError(400, 'bad_request', msg, errors);
const invalid = (msg, errors) => new HttpError(422, 'validation_failed', msg || 'Some fields need fixing', errors);
const conflict = (msg) => new HttpError(409, 'conflict', msg);

/** Parse with a zod schema; throw a 422 with per-field messages on failure. */
function parse(schema, data) {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const errors = r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
  throw invalid(errors.map((e) => `${e.field}: ${e.message}`).join('; '), errors);
}

/** Turn common PostgreSQL constraint errors into readable ones. */
function fromPg(err) {
  if (!err || !err.code) return err;
  if (err.code === '23505') return conflict('That value already exists: ' + (err.detail || err.constraint || ''));
  if (err.code === '23503') return conflict('This record is in use by other data and cannot be removed or changed that way.');
  if (err.code === '23514' || err.code === '23502') return invalid('A value is missing or not allowed: ' + (err.column || err.constraint || ''));
  if (err.code === '22P02' || err.code === '22007' || err.code === '22008') return invalid('A value has the wrong format.');
  return err;
}

module.exports = { HttpError, notFound, forbidden, badRequest, invalid, conflict, parse, fromPg };
