'use strict';
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../config/env');
const { randomToken } = require('../utils/crypto');
const { HttpError } = require('../utils/errors');
const { csrfAfterUpload } = require('./csrf');

const dir = path.join(config.storageDir, 'imports');
fs.mkdirSync(dir, { recursive: true });

const ALLOWED = { '.xlsx': 'xlsx', '.pdf': 'pdf' };

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, dir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${randomToken(8)}${path.extname(file.originalname).toLowerCase()}`),
});

const uploader = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 1 }, // hard cap; the college's import_max_mb is checked after
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED[ext]) return cb(new HttpError(415, 'bad_file_type', 'Upload an Excel (.xlsx) or PDF (.pdf) file.'));
    cb(null, true);
  },
});

/** The extension is not trusted: check the first bytes too. */
function sniff(req, res, next) {
  if (!req.file) throw new HttpError(400, 'file_missing', 'Choose a file to upload.');
  const ext = path.extname(req.file.originalname).toLowerCase();
  const fd = fs.openSync(req.file.path, 'r');
  const head = Buffer.alloc(5);
  fs.readSync(fd, head, 0, 5, 0);
  fs.closeSync(fd);
  const ok = ext === '.xlsx' ? head.slice(0, 2).toString() === 'PK' : head.toString() === '%PDF-';
  if (!ok) {
    fs.unlinkSync(req.file.path);
    throw new HttpError(415, 'bad_file_content', 'The file content does not match its extension.');
  }
  req.file.kind = ALLOWED[ext];
  next();
}

const importFile = [uploader.single('file'), csrfAfterUpload, sniff];

// Enrolment photos are checked in memory first; only accepted ones are written under var/photos.
const photoUploader = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: 6 } });
const enrolPhotos = [photoUploader.array('photos', 6), csrfAfterUpload];

module.exports = { importFile, enrolPhotos, importDir: dir };
