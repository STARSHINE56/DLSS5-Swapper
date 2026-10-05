'use strict';

// Starshine Auto - per-game automation state, history, rollback and
// Last Known Good.
//
// State lives in the app data folder, never inside a game folder, and is keyed
// by a digest of the game path, so changing one game can never change another.
// The official Restore Originals remains the single restore mechanism; these
// functions only record what happened around it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { STATES } = require('./state');

function storeFile(userData) {
  return path.join(userData, 'automation.json');
}

function key(gameDir) {
  return crypto.createHash('sha256').update(String(gameDir).toLowerCase()).digest('hex').slice(0, 32);
}

function readStore(userData) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(storeFile(userData), 'utf8'));
  } catch { /* first run or corrupt file - start fresh */ }
  if (data && typeof data === 'object' && data.version === 1 && data.games) {
    let migrated = false;
    for (const state of Object.values(data.games)) {
      if (state && state.lastKnownGood && !state.lastKnownGood.verifiedAt) {
        // Keep every legacy record, including when a newer candidate exists.
        if (state.pendingCandidate) state.legacyUnverifiedLastKnownGood = state.lastKnownGood;
        else state.pendingCandidate = { ...state.lastKnownGood, installedAt: state.lastInstall?.at || state.updatedAt || new Date().toISOString() };
        state.lastKnownGood = null;
        migrated = true;
      }
    }
    // A failed migration write must propagate, never replace existing data
    // with an empty store on the next mutation.
    if (migrated) writeStore(userData, data);
    return data;
  }
  return { version: 1, games: {} };
}

function writeStore(userData, store) {
  const file = storeFile(userData);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file);
}

function readGameState(gameDir, deps = {}) {
  const userData = deps.userData;
  if (!userData) return null;
  const store = readStore(userData);
  return store.games[key(gameDir)] || null;
}

function patchGameState(gameDir, patch, deps = {}) {
  const userData = deps.userData;
  if (!userData) return null;
  const store = readStore(userData);
  const id = key(gameDir);
  const current = store.games[id] || { gameDir, createdAt: new Date().toISOString() };
  store.games[id] = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeStore(userData, store);
  return store.games[id];
}

function setGameMode(gameDir, mode, deps = {}) {
  return patchGameState(gameDir, { mode }, deps);
}

// A pending install record lets a crash between steps leave the state in a
// known place instead of "unknown".
function beginInstall(gameDir, plan, deps = {}) {
  const entry = {
    at: new Date().toISOString(),
    action: 'install',
    route: plan && plan.recommendedRoute,
    mode: plan && plan.mode,
    result: 'started',
    verified: null,
    rolledBack: false
  };
  patchGameState(gameDir, {
    verifyState: STATES.INSTALLING,
    pendingCandidate: null,
    route: plan ? plan.recommendedRoute : null,
    mode: plan ? plan.mode : null,
    lastInstall: entry
  }, deps);
  return entry;
}

function componentVersionsFromPlan(plan) {
  const versions = {};
  for (const c of (plan && plan.components) || []) versions[c.name] = c.version || 'payload';
  return versions;
}

// File installation only creates a candidate. Runtime SUCCESS is required
// before replacing the last verified configuration.
function completeInstall(gameDir, plan, manifest, deps = {}) {
  const now = new Date().toISOString();
  const entry = {
    at: now,
    action: 'install',
    route: plan ? plan.recommendedRoute : null,
    mode: plan ? plan.mode : null,
    result: 'success',
    verified: false,
    rolledBack: false
  };
  const lkg = {
    route: plan ? plan.recommendedRoute : null,
    loader: deps.loader || 'dxgi',
    componentVersions: componentVersionsFromPlan(plan),
    config: deps.config || {},
    dllHashes: deps.dllHashes || {},
    verifiedAt: null,
    installedAt: now
  };
  const state = readGameState(gameDir, deps) || {};
  const history = state.installHistory || [];
  history.push(entry);
  patchGameState(gameDir, {
    verifyState: STATES.WAITING_FOR_VERIFICATION,
    route: lkg.route,
    loader: lkg.loader,
    lastKnownGood: state.lastKnownGood || null,
    pendingCandidate: lkg,
    lastInstall: entry,
    installHistory: history.slice(-50)
  }, deps);
  return lkg;
}

function failInstall(gameDir, plan, error, rolledBack, deps = {}) {
  const entry = {
    at: new Date().toISOString(),
    action: 'install',
    route: plan ? plan.recommendedRoute : null,
    mode: plan ? plan.mode : null,
    result: 'failed',
    error: error && (error.code || error.message || String(error)),
    rolledBack: Boolean(rolledBack),
    verified: null
  };
  const state = readGameState(gameDir, deps) || {};
  const history = state.installHistory || [];
  history.push(entry);
  patchGameState(gameDir, {
    verifyState: rolledBack ? STATES.ROLLED_BACK : STATES.FAILED,
    pendingCandidate: null,
    lastInstall: entry,
    installHistory: history.slice(-50)
  }, deps);
  return entry;
}

function recordRepair(gameDir, entry, deps = {}) {
  const state = readGameState(gameDir, deps) || {};
  const history = state.repairHistory || [];
  history.push({ at: new Date().toISOString(), ...entry });
  patchGameState(gameDir, { repairHistory: history.slice(-50) }, deps);
}

function setVerifyState(gameDir, verifyState, extra = {}, deps = {}) {
  return patchGameState(gameDir, { verifyState, ...extra }, deps);
}

function recordVerification(gameDir, verification, deps = {}) {
  const state = readGameState(gameDir, deps);
  if (!state || !state.pendingCandidate || state.verifyState === STATES.INSTALLING) return state;
  const patch = { verifyState: verification.state, lastVerification: verification };
  if (verification.verdict === 'SUCCESS' && verification.route === state.pendingCandidate.route) {
    patch.lastKnownGood = { ...state.pendingCandidate, verifiedAt: new Date().toISOString() };
    patch.pendingCandidate = null;
  }
  return patchGameState(gameDir, patch, deps);
}

// Rollback through the official Restore Originals. Returns the new state.
async function rollbackInstall(gameDir, deps = {}) {
  const restore = deps.restore || (() => { throw new Error('No restore backend injected'); });
  try {
    await restore(gameDir);
  } catch (error) {
    patchGameState(gameDir, { verifyState: STATES.FAILED, lastError: String(error && (error.code || error.message)) }, deps);
    throw error;
  }
  const entry = {
    at: new Date().toISOString(), action: 'rollback', result: 'success', rolledBack: true, verified: null
  };
  const state = readGameState(gameDir, deps) || {};
  const history = state.installHistory || [];
  history.push(entry);
  patchGameState(gameDir, {
    verifyState: STATES.ROLLED_BACK,
    pendingCandidate: null,
    route: null,
    loader: null,
    lastInstall: entry,
    installHistory: history.slice(-50)
  }, deps);
  return entry;
}

// One-click restore of the last configuration that verified. Restores
// originals first (official), then reinstalls the recorded route/loader and
// returns to WAITING_FOR_VERIFICATION.
async function restoreLastKnownGood(gameDir, options, deps = {}) {
  const state = readGameState(gameDir, deps);
  if (!state || !state.lastKnownGood || !state.lastKnownGood.verifiedAt) {
    return { ok: false, code: 'errNoLastKnownGood', state: readGameState(gameDir, deps) };
  }
  const lkg = state.lastKnownGood;
  await rollbackInstall(gameDir, deps);
  const installFlow = deps.installFlow || (() => { throw new Error('No install flow injected'); });
  const result = await installFlow({
    gameDir,
    exePath: options.exePath,
    route: lkg.route,
    api: options.api || 'auto',
    reshadeProxy: lkg.loader || 'dxgi'
  });
  if (!result.ok) {
    failInstall(gameDir, null, result, false, deps);
    return { ok: false, ...result, state: readGameState(gameDir, deps) };
  }
  const manifest = result.manifest;
  completeInstall(gameDir, { recommendedRoute: lkg.route, mode: state.mode || 'auto', components: [] },
    manifest, { ...deps, loader: lkg.loader || 'dxgi', dllHashes: result.dllHashes || {} });
  return { ok: true, state: readGameState(gameDir, deps), lastKnownGood: lkg };
}

// Component version management: what the app carries vs what is beside the
// game, with a status that never comes from the file name alone.
function componentStatus(gameDir, deps = {}) {
  const exe = deps.exePath || null;
  const payload = deps.payload || null;
  const files = deps.files || {};
  const out = [];
  const available = {
    'DLSS5-Feeder': payload && payload.source && payload.source.feeder ? payload.source.feeder.version : null,
    'RenoDX consumer': payload && payload.source && payload.source.renodx ? payload.source.renodx.version : null,
    'OptiScaler': payload && payload.source && payload.source.optiscaler ? payload.source.optiscaler.version : null
  };
  const installed = {
    'DLSS5-Feeder': files.feeder ? (files.feeder.version || null) : null,
    'RenoDX consumer': files.renodx ? (files.renodx.version || null) : null,
    'OptiScaler': files.optiscaler ? (files.optiscaler.version || null) : null
  };
  for (const [name, avail] of Object.entries(available)) {
    const have = installed[name];
    let status = 'MISSING';
    if (have != null && avail != null) {
      status = have === avail ? 'CURRENT' : 'OUTDATED';
    } else if (have != null) {
      status = 'UNKNOWN';
    }
    out.push({ component: name, installedVersion: have, availableVersion: avail, source: 'official', sha256: null, status });
  }
  return out;
}

module.exports = {
  readGameState, patchGameState, setGameMode, beginInstall, completeInstall,
  failInstall, recordRepair, setVerifyState, recordVerification, rollbackInstall,
  restoreLastKnownGood, componentStatus, readStore, writeStore, key
};
