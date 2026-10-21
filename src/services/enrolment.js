'use strict';
// A student's own face enrolment: at least three JPEG photos, checked, saved under
// var/photos/<register no>/, and stored as embeddings in identity.face_embeddings.
const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const config = require('../config/env');
const settings = require('./settings');
const faceEmbed = require('./faceEmbed');
const { randomToken } = require('../utils/crypto');
const { invalid, forbidden, notFound } = require('../utils/errors');

const MAX_PHOTOS = 6;
const SAME_PERSON = 0.30;   // photos of one student must be at least this similar to each other
const SOMEONE_ELSE = 0.60;  // this similar to another enrolled student means the face is already taken
const POSES = ['front', 'left', 'right'];
const PROBLEM = {
  not_readable: 'the file could not be read as a picture',
  no_face: 'no face was found',
  several_faces: 'more than one face is in the picture; you must be alone in it',
  face_too_small: 'the face is too small; move closer to the camera',
  too_blurry: 'the picture is blurred; hold still and use better light',
  low_detector_score: 'the face is not clear enough; face the camera in good light',
  different_person: 'this does not look like the same person as your first photo',
};

const folderName = (s) => String(s.register_no || s.university_id).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
const photoFolder = (s) => path.join(config.photoDir, folderName(s));
const isJpeg = (buf) => buf && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const vector = (e) => `[${e.join(',')}]`;

function student(studentId) {
  return db.one(
    `SELECT s.student_id, s.register_no, s.university_id, s.full_name, s.enrollment_status, s.face_registered,
            s.consent_granted_at, s.college_id,
            (SELECT count(*)::int FROM identity.face_embeddings e WHERE e.student_id = s.student_id) AS embeddings,
            (SELECT max(created_at) FROM identity.face_embeddings e WHERE e.student_id = s.student_id) AS enrolled_at
       FROM identity.students s WHERE s.student_id = $1`, [studentId]);
}

/** File names of a student's stored photos, front first. */
function photos(s) {
  const dir = photoFolder(s);
  if (!fs.existsSync(dir)) return [];
  const rank = (f) => { const i = POSES.indexOf(f.replace('.jpg', '')); return i < 0 ? 9 : i; };
  return fs.readdirSync(dir).filter((f) => /^[a-z0-9]+\.jpg$/.test(f)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function photoPath(s, file) {
  if (!/^[a-z0-9]+\.jpg$/.test(String(file))) return null;
  const p = path.join(photoFolder(s), file);
  return fs.existsSync(p) ? p : null;
}

/**
 * Enrol the signed-in student. files: [{ buffer, originalname }] from the upload.
 * Nothing is kept unless enough photos pass every check.
 */
async function enrol(scope, userId, files, consent) {
  const s = scope.studentId ? await student(scope.studentId) : null;
  if (!s) throw forbidden('Only a student can enrol a face here.');
  if (s.enrollment_status !== 'active') throw forbidden('Your record is not active, so face enrolment is closed. See your class advisor.');
  if (s.face_registered) throw invalid('Your face is already enrolled. To enrol again, ask your class advisor or HOD to reset it.');
  if (!consent) throw invalid('Tick the consent box to continue.');
  const min = await settings.get(s.college_id, 'enroll_min_photos', 3);
  files = (files || []).filter((f) => f && f.buffer && f.buffer.length);
  if (files.length < min) throw invalid(`Add at least ${min} photos of your face.`);
  if (files.length > MAX_PHOTOS) throw invalid(`Add at most ${MAX_PHOTOS} photos.`);
  files.forEach((f, i) => { if (!isJpeg(f.buffer)) throw invalid(`Photo ${i + 1} is not a JPEG picture. Take it again or save it as JPEG (.jpg).`); });

  // Photos wait in a holding folder until every check has passed.
  const holding = path.join(config.photoDir, '_incoming', randomToken(8));
  fs.mkdirSync(holding, { recursive: true });
  const paths = files.map((f, i) => path.join(holding, `${i + 1}.jpg`));
  files.forEach((f, i) => fs.writeFileSync(paths[i], f.buffer));
  const cleanup = () => fs.rmSync(holding, { recursive: true, force: true });

  try {
    const out = await faceEmbed.embed(paths, { minFace: 100 });
    const results = out.results.map((r, i) => ({ ...r, n: i + 1 }));
    const good = results.filter((r) => !r.problem && r.embedding);
    // Every photo must show the same person as the first good one.
    for (const r of good.slice(1)) if (dot(good[0].embedding, r.embedding) < SAME_PERSON) r.problem = 'different_person';
    const accepted = results.filter((r) => !r.problem && r.embedding);
    if (accepted.length < min) {
      const bad = results.filter((r) => r.problem).map((r) => `Photo ${r.n}: ${PROBLEM[r.problem] || r.problem}.`);
      throw invalid(`${accepted.length} of ${results.length} photos could be used; ${min} are needed. ${bad.join(' ')}`);
    }
    // A face that already belongs to another student is refused, and the attempt is kept in the audit log.
    for (const r of accepted) {
      const near = await db.one(
        `SELECT s.register_no, 1 - (e.embedding <=> $1::vector) AS similarity
           FROM identity.face_embeddings e JOIN identity.students s ON s.student_id = e.student_id
          WHERE e.student_id <> $2 AND e.model_version = $3 AND s.college_id = $4
          ORDER BY e.embedding <=> $1::vector LIMIT 1`,
        [vector(r.embedding), s.student_id, out.model_version, s.college_id]);
      if (near && near.similarity >= SOMEONE_ELSE) {
        const e = invalid('These photos match a face that is already enrolled for another student. Enrol with your own face, or see your class advisor.');
        e.duplicateOf = near.register_no;
        throw e;
      }
    }

    const dir = photoFolder(s);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true }); // an earlier, reset enrolment
    const saved = accepted.map((r, i) => {
      const name = `${POSES[i] || String(i + 1)}.jpg`;
      fs.renameSync(r.path, path.join(dir, name));
      return { ...r, name, pose: POSES[i] || 'front' };
    });
    await db.tx(async (c) => {
      await c.query('UPDATE identity.students SET consent_granted_at = COALESCE(consent_granted_at, now()) WHERE student_id = $1', [s.student_id]);
      const session = await c.one('INSERT INTO attendance.registration_sessions (student_id, registered_by) VALUES ($1, $2) RETURNING session_id', [s.student_id, userId]);
      for (const r of saved) {
        await c.query(
          `INSERT INTO identity.face_embeddings (student_id, embedding, model_version, source) VALUES ($1, $2::vector, $3, 'enrollment')`,
          [s.student_id, vector(r.embedding), out.model_version]);
        await c.query(
          `INSERT INTO attendance.registration_images (session_id, student_id, pose, storage_ref, quality_ok) VALUES ($1, $2, $3, $4, true)`,
          [session.session_id, s.student_id, r.pose, `${folderName(s)}/${r.name}`]);
      }
    });
    return { student: s, photos: saved.length, folder: dir, model_version: out.model_version };
  } finally {
    cleanup();
  }
}

/** Remove a student's embeddings and photos so they can enrol again (class advisor, HOD or admin). */
async function reset(s) {
  if (!s) throw notFound('That student does not exist.');
  await db.tx(async (c) => {
    await c.query('DELETE FROM identity.face_embeddings WHERE student_id = $1', [s.student_id]);
    await c.query('UPDATE identity.students SET face_registered = false WHERE student_id = $1', [s.student_id]);
  });
  fs.rmSync(photoFolder(s), { recursive: true, force: true });
  return s;
}

module.exports = { enrol, reset, student, photos, photoPath, photoFolder, folderName, MAX_PHOTOS, PROBLEM };
