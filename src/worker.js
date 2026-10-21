'use strict';
// The worker process: same codebase and models as the web process, no HTTP.
//   node src/worker.js          run forever
//   node src/worker.js --once   run every job once and exit (cron, tests)
const config = require('./config/env');
const db = require('./config/db');
const ingestEvents = require('./jobs/ingestEvents');
const closePeriods = require('./jobs/closePeriods');
const refreshSummaries = require('./jobs/refreshSummaries');
const sendEmails = require('./jobs/sendEmails');

const JOBS = [
  { name: 'ingest', run: ingestEvents, everyMs: config.worker.ingestIntervalMs },
  { name: 'close', run: closePeriods, everyMs: config.worker.closeIntervalMs },
  { name: 'email', run: sendEmails, everyMs: 30000 },
  { name: 'alerts', run: refreshSummaries, everyMs: 60 * 60 * 1000 },
];

let stopping = false;

/** Run a job, wait, repeat. A job never overlaps itself, and one failure does not stop the loop. */
async function loop(job) {
  while (!stopping) {
    try {
      await job.run();
    } catch (err) {
      console.error(`[${job.name}] failed:`, err.message);
    }
    await new Promise((r) => setTimeout(r, job.everyMs));
  }
}

async function main() {
  if (process.argv.includes('--once')) {
    for (const job of JOBS) console.log(`[${job.name}]`, JSON.stringify(await job.run()));
    await db.end();
    return;
  }
  console.log('[worker] started: ingest every', config.worker.ingestIntervalMs, 'ms, period close every', config.worker.closeIntervalMs, 'ms');
  JOBS.forEach(loop);
}

function shutdown() {
  stopping = true;
  setTimeout(() => db.end().finally(() => process.exit(0)), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
