'use strict';

// Starshine Auto - transactional smart install.
//
// The heavy lifting stays in the official installer (src/core/apply.js inside
// the file-journal transaction). This module decides what the official
// installer should do, records what happened, and - on a failure that left a
// pending transaction behind - rolls back through the official Restore
// Originals. It never writes a game file itself.

const fs = require('fs');
const detect = require('./detect');
const compat = require('./compat');
const planMod = require('./plan');
const recovery = require('./recovery');
const { STATES, outcome, normalizeMode } = require('./state');

// Build the configuration the official installer understands from a detection
// and a recommendation. Every field maps onto backends.install(config).
function buildSmartConfig(detection, recommendation, mode, deps = {}) {
  const exe = detection.exe;
  const route = recommendation.recommendedRoute;
  const api = exe ? exe.api : null;
  // DirectX 8/9/DDraw titles run through dgVoodoo and load d3d11.dll inside
  // the wrapper; DirectX 12 never loads a d3d11 proxy. Same rule as the
  // official sheet's reshadeProxy choice (#328, #343).
  const reshadeProxy = ['dxgi', 'd3d8', 'd3d9', 'ddraw'].includes(api) && exe.apiLabel !== 'DirectX 12' && route !== 'optiscaler'
    ? (deps.loader || 'dxgi') : 'dxgi';
  return {
    gameDir: detection.gameDir,
    exePath: exe.path,
    api,
    apiChoice: exe.apiOverride && exe.apiOverride !== 'auto' ? exe.apiOverride : api,
    apiLabel: exe.apiLabel,
    bitness: exe.bitness,
    route,
    antiCheatAcknowledged: false,
    emulator: exe.emulator || null,
    reshadeProxy,
    installReShade: true,
    addMissingDlss: true,
    addStreamline: false,
    upgradeReShade: false,
    optiVersion: deps.optiVersion || null,
    mode
  };
}

// Codes that mean "nothing was written" - a rollback would be meaningless.
const NOTHING_WRITTEN = new Set([
  'unsupportedRendererHint', 'errOptiDownload', 'errOptiUnsupported',
  'errOptiConflict', 'errOptiVulkanLayer', 'errBackendVulkanSwitch',
  'runtimeRequiredHint', 'errProtonRequired', 'errLinuxVulkanUnsupported',
  'errNoWriteAccess', 'errBackendRecovery', 'errManagedModpack', 'errLoaderConflict'
]);

async function runSmartInstall(options, deps = {}) {
  const gameDir = options.gameDir;
  const mode = normalizeMode(options.mode);
  const userData = deps.userData;
  const send = deps.send || (() => {});
  const log = deps.log || (() => {});

  // 1. Detection (reuse, do not trust a stale caller).
  const detection = deps.detection || await detect.detectGame({ gameDir, exePath: options.exePath }, deps);
  if (!detection.ok) {
    return outcome(false, STATES.NEEDS_ATTENTION, 'errNoGameExecutable', { gameDir });
  }

  // 2. Recommendation.
  const recommendation = deps.recommendation || compat.buildRecommendation(detection, mode, deps);
  if (recommendation.blocked) {
    log(gameDir, null, mode, 'recommend', 'blocked', 'fail', recommendation.blockReason);
    return outcome(false, STATES.NEEDS_ATTENTION, 'autoBlocked', {
      blockReason: recommendation.blockReason, warnings: recommendation.warnings, gameDir
    });
  }

  // 3. Plan.
  const plan = deps.plan || planMod.buildInstallPlan(detection, recommendation, mode);

  // 4. Preflight re-check with the app's own payload.
  const preflight = deps.preflight || planMod.preflightCheck(detection, recommendation, deps);
  if (!preflight.ok) {
    log(gameDir, plan.recommendedRoute, mode, 'preflight', 'blocked', 'fail', null);
    return outcome(false, STATES.NEEDS_ATTENTION, 'autoPreflight', {
      checks: preflight.checks, errors: preflight.errors, gameDir
    });
  }

  // 5. Record the attempt and go installing.
  recovery.beginInstall(gameDir, plan, { userData });
  log(gameDir, plan.recommendedRoute, mode, 'install', 'begin', 'started', null);

  let manifest = null;
  let result;
  try {
    const config = buildSmartConfig(detection, recommendation, mode, deps);
    send({ code: 'autoInstalling', params: { route: config.route, mode } });
    result = await deps.install(config);
    manifest = result && result.manifest ? result.manifest : null;
  } catch (error) {
    // The official transaction already restored files for errors raised
    // inside backends.install. Only a leftover pending journal (an abnormal
    // exit) needs the explicit official restore.
    let rolledBack = false;
    try {
      if (fs.existsSync(require('../core/file-journal').pendingPath(gameDir))) {
        await (deps.restore ? deps.restore(gameDir) : Promise.resolve());
        rolledBack = true;
      }
    } catch (restoreError) {
      log(gameDir, null, mode, 'rollback', 'failed', 'error', restoreError.code || 'rollbackFailed');
    }
    const code = error && (error.code || 'errAutoInstall');
    log(gameDir, null, mode, 'install', 'failed', 'error', code);
    recovery.failInstall(gameDir, plan, error, rolledBack, { userData });
    return outcome(false, rolledBack ? STATES.ROLLED_BACK : STATES.FAILED, code, {
      message: error && error.message, rolledBack, gameDir
    });
  }

  if (!result || !result.ok) {
    const code = result && (result.code || 'errAutoInstall');
    const rolledBack = Boolean(NOTHING_WRITTEN.has(code)) ? false : Boolean(result && result.rolledBack);
    log(gameDir, plan.recommendedRoute, mode, 'install', 'failed', 'error', code);
    recovery.failInstall(gameDir, plan, { code, message: result && result.message }, rolledBack, { userData });
    return outcome(false, rolledBack ? STATES.ROLLED_BACK : STATES.FAILED, code, {
      message: result && result.message, gameDir
    });
  }

  // 6. Success: record a candidate and wait for runtime verification.
  const replaced = result.replaced != null ? result.replaced : (manifest ? manifest.replaced.length : 0);
  const added = result.added != null ? result.added : (manifest ? manifest.added.length : 0);
  const loader = deps.loader || 'dxgi';
  const dllHashes = result.dllHashes || {};
  recovery.completeInstall(gameDir, plan, manifest, { userData, loader, dllHashes, exePath: detection.exe.path });
  log(gameDir, plan.recommendedRoute, mode, 'install', 'done', 'success', null);
  send({ code: 'autoInstalled', params: { route: plan.recommendedRoute, replaced, added } });
  return outcome(true, STATES.WAITING_FOR_VERIFICATION, 'autoInstalled', {
    replaced, added, route: plan.recommendedRoute, mode, gameDir
  });
}

module.exports = { runSmartInstall, buildSmartConfig, NOTHING_WRITTEN };
