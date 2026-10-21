'use strict';
const service = require('../services/enrolment');
const attendance = require('../models/attendance');
const settings = require('../services/settings');
const audit = require('../services/audit');
const { notFound, forbidden } = require('../utils/errors');

/** The student's enrolment page: the form before enrolment, the stored photos after it. */
async function show(req, res) {
  if (req.user.role !== 'student' || !req.scope.studentId) return res.done('/dashboard', {});
  const s = await service.student(req.scope.studentId);
  res.page('enrol/index', {
    title: 'Face enrolment', student: s, photos: service.photos(s), max: service.MAX_PHOTOS,
    min: await settings.get(s.college_id, 'enroll_min_photos', 3), required: req.user.mustEnrolFace,
  });
}

async function submit(req, res) {
  const consent = ['on', 'true', true, '1'].includes((req.body || {}).consent);
  try {
    const out = await service.enrol(req.scope, req.user.userId, req.files, consent);
    await audit.log(req, 'face_enrolled', { table: 'face_embeddings', recordId: out.student.student_id, newValues: { photos: out.photos, model: out.model_version } });
    res.done('/dashboard', { photos: out.photos, model_version: out.model_version }, `Your face is enrolled from ${out.photos} photos. Cameras can now mark your attendance.`);
  } catch (err) {
    if (err.duplicateOf) {
      await audit.log(req, 'face_enrolment_refused', { table: 'face_embeddings', recordId: req.scope.studentId, newValues: { matches_register_no: err.duplicateOf } });
    }
    throw err;
  }
}

/** One stored photo. The student sees their own; staff, HOD and admin see their students'. */
async function photo(req, res) {
  const id = req.params.id === 'me' ? req.scope.studentId : req.params.id;
  const st = id && /^[0-9a-f-]{36}$/i.test(id) ? await attendance.student(req.scope, id) : null;
  const file = st && service.photoPath(st, req.params.file);
  if (!file) throw notFound('That photo does not exist.');
  res.set('Cache-Control', 'private, no-store');
  res.type('jpeg').sendFile(file);
}

/** Clear a student's enrolment so they can enrol again. */
async function reset(req, res) {
  if (req.user.role === 'student') throw forbidden('Ask your class advisor or HOD to reset your enrolment.');
  const st = /^[0-9a-f-]{36}$/i.test(req.params.id) ? await attendance.student(req.scope, req.params.id) : null;
  if (!st) throw notFound('That student does not exist.');
  await service.reset(st);
  await audit.log(req, 'face_enrolment_reset', { table: 'face_embeddings', recordId: st.student_id, oldValues: { register_no: st.register_no } });
  res.done(`/students/${st.student_id}/attendance`, {}, `${st.full_name}'s face enrolment was cleared. They enrol again at their next sign-in.`);
}

module.exports = { show, submit, photo, reset };
