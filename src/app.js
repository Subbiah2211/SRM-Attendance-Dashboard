'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config/env');
const { respond, viewLocals } = require('./middlewares/respond');
const { loadSession } = require('./middlewares/authenticate');
const { csrf } = require('./middlewares/csrf');
const { notFoundHandler, errorHandler } = require('./middlewares/errors');
const routes = require('./routes');

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
  app.disable('x-powered-by');

  const directives = {
    ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'script-src': ["'self'"], 'form-action': ["'self'"],
    // The AI camera view shows video from the college's own camera gateway (HLS, MJPEG or a page),
    // which lives on another address. Scripts stay limited to this application.
    'img-src': ["'self'", 'data:', 'blob:', 'https:', 'http:'], // blob: previews of enrolment photos
    'media-src': ["'self'", 'blob:', 'https:', 'http:'],
    'frame-src': ['https:', 'http:'],
    'connect-src': ["'self'", 'https:', 'http:'],
    'worker-src': ["'self'", 'blob:'],
  };
  if (!config.cookieSecure) delete directives['upgrade-insecure-requests']; // plain http on a campus network
  // same-origin: the application's own pages tell it where a form was sent from (so a refused form
  // returns to its page); nothing is told to other sites.
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives }, hsts: config.cookieSecure, referrerPolicy: { policy: 'same-origin' } }));

  app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: config.nodeEnv === 'production' ? '1d' : 0 }));
  // The browser build of Chart.js, served from node_modules so pages need no CDN.
  const chartFile = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.min.js');
  app.get('/vendor/chart.js', (req, res) => res.sendFile(chartFile, { maxAge: '7d' }));
  // The HLS player, loaded only by the camera view when a browser cannot play HLS itself.
  const hlsFile = path.join(__dirname, '..', 'node_modules', 'hls.js', 'dist', 'hls.min.js');
  app.get('/vendor/hls.js', (req, res) => res.sendFile(hlsFile, { maxAge: '7d' }));
  // Photos for the sign-in page are optional: drop staff, student, cctv and attendance images
  // (jpg, png or webp) into src/public/img/login and they replace the drawn pictures.
  const photoDir = path.join(__dirname, 'public', 'img', 'login');
  app.locals.loginPhoto = (name) => {
    for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
      if (fs.existsSync(path.join(photoDir, `${name}.${ext}`))) return `/static/img/login/${name}.${ext}`;
    }
    return null;
  };
  // The interface font, self-hosted for the same reason.
  const fontFile = path.join(path.dirname(require.resolve('@fontsource-variable/plus-jakarta-sans/package.json')), 'files', 'plus-jakarta-sans-latin-wght-normal.woff2');
  app.get('/vendor/fonts/plus-jakarta-sans.woff2', (req, res) => res.sendFile(fontFile, { maxAge: '30d', immutable: true }));

  // Middleware order matters: parse -> response helpers -> session and scope -> view locals -> CSRF -> routes.
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: true, limit: '2mb', parameterLimit: 5000 }));
  app.use(express.json({ limit: '2mb' }));
  app.use(respond);
  app.use(loadSession);
  app.use(viewLocals);
  app.use(csrf);

  app.use('/api/v1', routes);
  app.use('/', routes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
