'use strict';

// Starshine Auto - safe, automated DLSS 5 deployment.
//
// This is an orchestration layer over the official installer, never a second
// installer. Everything that writes a game folder still goes through
// src/core/apply.js inside src/core/file-journal.js's transaction, and every
// restore goes through the official Restore Originals. What this module adds
// is detection, recommendation, planning, verification, diagnostics and
// recovery - the parts a normal user should not have to reason about.
//
// A machine that cannot run the neural pass is never pushed into a route:
// detection decides, the plan states why, and the install runs only after the
// preflight passes. No feature here guesses by trying DLLs in a loop.

const detect = require('./detect');
const compat = require('./compat');
const plan = require('./plan');
const install = require('./install');
const verify = require('./verify');
const recovery = require('./recovery');
const { STATES, MODES, MODE_ORDER, normalizeMode, outcome } = require('./state');

// Structured debug log. Every entry carries what the diagnostics UI and the
// support file need, and nothing that could be a secret.
function createLogger(sink) {
  const rows = [];
  const log = (gameDir, route, mode, component, step, result, errorCode, params) => {
    const row = {
      timestamp: new Date().toISOString(),
      game: gameDir || null,
      route: route || null,
      mode: mode || null,
      component: component || null,
      step: step || null,
      result: result || null,
      errorCode: errorCode || null,
      params: params && typeof params === 'object' ? params : null
    };
    rows.push(row);
    if (typeof sink === 'function') sink(row);
    return row;
  };
  return { log, rows: () => rows.slice() };
}

// A compact, human-readable summary of an automation result lives in
// ./state (outcome) - imported above.

module.exports = {
  STATES,
  MODES,
  MODE_ORDER,
  normalizeMode,
  createLogger,
  outcome,
  detect: (options, deps) => detect.detectGame(options, deps),
  recommend: (detection, mode) => compat.buildRecommendation(detection, mode),
  preflight: (detection, recommendation, deps) => plan.preflightCheck(detection, recommendation, deps),
  buildPlan: (detection, recommendation, mode) => plan.buildInstallPlan(detection, recommendation, mode),
  runInstall: (options, deps) => install.runSmartInstall(options, deps),
  verify: (gameDir, planData, deps) => verify.verifyInstallation(gameDir, planData, deps),
  diagnose: (gameDir, planData, deps) => verify.diagnoseInstallation(gameDir, planData, deps),
  repair: (gameDir, repairId, options, deps) => verify.safeAutoRepair(gameDir, repairId, options, deps),
  rollback: (gameDir, deps) => recovery.rollbackInstall(gameDir, deps),
  restoreLastKnownGood: (gameDir, options, deps) => recovery.restoreLastKnownGood(gameDir, options, deps),
  state: (gameDir, deps) => recovery.readGameState(gameDir, deps),
  setMode: (gameDir, mode, deps) => recovery.setGameMode(gameDir, mode, deps),
  components: (gameDir, deps) => recovery.componentStatus(gameDir, deps)
};
