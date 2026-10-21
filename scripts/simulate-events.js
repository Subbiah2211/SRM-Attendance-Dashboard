'use strict';
// Stand-in for the recognition pipeline: writes identification events for classes that
// have started, then (unless --no-engine) runs the engine once.
//   node scripts/simulate-events.js [--college srm-vec] [--date YYYY-MM-DD] [--no-engine]
const db = require('../src/config/db');
const { generateEvents, runEngine } = require('./lib/demo');
const { todayIn } = require('../src/utils/dates');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

(async () => {
  const college = arg('college', 'srm-vec');
  const date = arg('date', todayIn('Asia/Kolkata'));
  const n = await generateEvents(college, date, date, { seed: Date.now() % 100000 });
  console.log(`${n} identification events written for ${college} on ${date}.`);
  if (!process.argv.includes('--no-engine')) console.log('Engine:', JSON.stringify(await runEngine()));
  else console.log('Start the worker (npm run worker) to turn them into attendance.');
})()
  .then(() => db.end())
  .catch((err) => {
    console.error(err.message);
    db.end().finally(() => process.exit(1));
  });
