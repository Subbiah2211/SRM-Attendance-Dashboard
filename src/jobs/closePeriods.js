'use strict';
const engine = require('../services/engine');

/** Mark absentees for finished periods, or flag them for manual marking. */
module.exports = async function closePeriods() {
  const r = await engine.closeDuePeriods();
  if (r.closed || r.needsManual) console.log(`[close] ${r.closed} periods closed, ${r.needsManual} need manual marking`);
  return r;
};
