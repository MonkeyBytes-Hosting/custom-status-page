'use strict';

module.exports = {
  PORT:           parseInt(process.env.PORT) || 5072,
  HOST:           '0.0.0.0',
  CHECK_INTERVAL: 10_000,   // ms — check every 10 s for near-instant alerts
  MAX_HISTORY:    259_200,  // 30 days at 10 s intervals
};
