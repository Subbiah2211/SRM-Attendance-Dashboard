'use strict';
const model = require('../models/cameras');
const audit = require('../services/audit');
const { notFound } = require('../utils/errors');
const { pager } = require('./helpers');

async function health(req, res) {
  const [cameras, ignored] = await Promise.all([model.health(req.scope), model.ignoredReasons(req.scope)]);
  res.page('cameras/health', { title: 'Cameras', cameras, ignored });
}

async function unknown(req, res) {
  const reviewed = req.query.reviewed === '1';
  const pg = pager(req, 0);
  const { rows, total } = await model.unknown(req.scope, reviewed, pg);
  res.page('cameras/unknown', { title: 'Unknown faces', rows, reviewed, pager: pager(req, total) });
}

async function review(req, res) {
  const ok = /^[0-9a-f-]{36}$/i.test(req.params.id) && (await model.review(req.scope, req.params.id, req.user.userId, String((req.body || {}).remarks || '').slice(0, 300)));
  if (!ok) throw notFound('That detection does not exist.');
  await audit.log(req, 'unknown_detection_reviewed', { table: 'unknown_reviews', recordId: req.params.id });
  res.done('/unknown-detections', {}, 'Marked as reviewed.');
}

/** How a viewer address is shown: an HLS playlist in a video player, an image stream as an image, anything else as a page. */
function viewerKind(url) {
  if (!url) return null;
  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (/\.(mp4|webm|ogg)$/.test(path)) return 'video';
  if (/\.(mjpe?g|jpe?g|cgi)$/.test(path) || /mjpe?g|snapshot/.test(path)) return 'image';
  return 'page';
}

/** Pick a camera and see what it is doing: the class in its room, today's recognitions, live video if set up. */
async function view(req, res) {
  const list = await model.viewable(req.scope);
  const cam = list.find((c) => c.camera_id === String(req.query.camera_id || '')) || null;
  if (req.query.camera_id && !cam) throw notFound('That camera does not exist, or is not in a room you teach in.');
  const act = cam ? await model.activity({ ...cam, college_id: req.scope.collegeId }, req.scope.timezone) : null;
  res.page('cameras/view', { title: 'AI camera view', cameras: list, camera: cam, activity: act, viewerKind: cam ? viewerKind(cam.viewer_url) : null });
}

module.exports = { health, unknown, review, view, viewerKind };
