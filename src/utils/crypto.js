'use strict';
const crypto = require('crypto');
const argon2 = require('argon2');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hmac = (secret, s) => crypto.createHmac('sha256', secret).update(String(s)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Argon2id. Temporary passwords (bulk import, admin reset) use a lighter cost so a
 * 5,000-row import stays fast; the user must change them at first login, and the
 * new password is hashed at full cost.
 */
function hashPassword(password, { temporary = false } = {}) {
  const opts = temporary
    ? { type: argon2.argon2id, memoryCost: 8192, timeCost: 2, parallelism: 1 }
    : { type: argon2.argon2id };
  return argon2.hash(String(password), opts);
}
async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, String(password));
  } catch {
    return false;
  }
}

function randomPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

module.exports = { sha256, hmac, randomToken, safeEqual, hashPassword, verifyPassword, randomPassword };
