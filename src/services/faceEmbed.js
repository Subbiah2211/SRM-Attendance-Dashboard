'use strict';
// Turns photos into face embeddings by talking to recognition/embed_service.py.
// The Python process is started on the first request and kept running, so the face
// model is loaded once. One JSON line goes in per request and one comes back.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../config/env');
const { HttpError } = require('../utils/errors');

const recognitionDir = path.join(__dirname, '..', '..', 'recognition');
let child = null;
let buffer = '';
let seq = 0;
let lastStderr = '';
const pending = new Map();
let backend = null; // tests replace the Python process with a function

function pythonBin() {
  if (config.pythonBin) return config.pythonBin;
  const root = path.join(__dirname, '..', '..');
  const candidates = [];
  for (const base of [recognitionDir, root]) {
    for (const venv of ['venv', '.venv']) {
      candidates.push(path.join(base, venv, 'Scripts', 'python.exe'), path.join(base, venv, 'bin', 'python'));
    }
  }
  return candidates.find((p) => fs.existsSync(p)) || (process.platform === 'win32' ? 'python' : 'python3');
}

const unavailable = (detail) => new HttpError(503, 'face_service_unavailable',
  'Face enrolment is not available on the server right now. Please tell your class advisor or the college admin.' + (detail ? ` (${detail})` : ''));

function failAll(detail) {
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(unavailable(detail)); }
  pending.clear();
  child = null;
  buffer = '';
}

function start() {
  const bin = pythonBin();
  child = spawn(bin, ['embed_service.py'], { cwd: recognitionDir, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        console.error('[face] embed_service error:', msg.error);
        p.reject(unavailable());
      } else p.resolve(msg);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { lastStderr = (lastStderr + d).slice(-600); });
  child.on('error', (err) => {
    console.error(`[face] could not start "${bin}": ${err.message}. Install the recognition requirements, or set PYTHON_BIN.`);
    failAll();
  });
  child.on('exit', (code) => {
    if (pending.size) console.error(`[face] embed_service stopped (code ${code}). Last output: ${lastStderr.trim().split('\n').slice(-3).join(' | ')}`);
    failAll();
  });
}

/**
 * paths: absolute paths of JPEG files. Returns { model_version, results: [{ path, faces, problem,
 * width, sharpness, score, embedding }] }, one result per path, in order.
 */
function embed(paths, { minFace = 100, timeoutMs = 300000 } = {}) {
  if (backend) return Promise.resolve(backend(paths, { minFace }));
  if (!child) start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    // The first request may have to download and load the model, hence the long limit.
    const timer = setTimeout(() => { pending.delete(id); reject(unavailable('it took too long')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(JSON.stringify({ id, paths, min_face: minFace }) + '\n');
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(unavailable());
    }
  });
}

function stop() {
  if (child) { try { child.stdin.end(); child.kill(); } catch { /* already gone */ } }
  child = null;
}

module.exports = { embed, stop, setBackend: (fn) => { backend = fn; }, pythonBin };
