'use strict';
const engine = require('../services/engine');
const config = require('../config/env');

/** Drain unconsumed identification events in batches. */
module.exports = async function ingestEvents() {
  let total = { events: 0, marked: 0, ignored: 0 };
  for (let i = 0; i < 20; i++) { // at most 20 batches per tick, then yield to the other jobs
    const r = await engine.ingestBatch(config.worker.batchSize);
    total = { events: total.events + r.events, marked: total.marked + r.marked, ignored: total.ignored + r.ignored };
    if (r.events < config.worker.batchSize) break;
  }
  if (total.events) console.log(`[ingest] ${total.events} events: ${total.marked} marked, ${total.ignored} ignored`);
  return total;
};
