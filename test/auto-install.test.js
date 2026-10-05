'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const install = require('../src/automation/install');
const recovery = require('../src/automation/recovery');
const compat = require('../src/automation/compat');
const journal = require('../src/core/file-journal');

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function baseDetection(gameDir) {
  return {
    gameDir, ok: true,
    exe: { path: path.join(gameDir, 'game.exe'), rel: 'game.exe', api: 'dxgi', apiLabel: 'DirectX 12', bitness: 64, via: 'imports', emulator: null },
    apiConfidence: 'HIGH',
    gpu: { available: true, primary: { name: 'NVIDIA GeForce RTX 5070', driver: '616.56' }, isNvidia: true, isRtx: true, isBlackwell: true, driver: '616.56', driverNumber: 61656, driverSupported: true, modelSupported: true },
    multiGpu: false, existingDlls: [], nvidiaFiles: [],
    reshade: { installed: false, version: null, file: null, installedByUs: false },
    mods: [], antiCheat: { present: false, names: [], blocked: false },
    writable: true, diskSpace: { free: 40 * 1024 * 1024 * 1024, total: 100 * 1024 * 1024 * 1024, ok: true },
    managedModRoot: null,
    scan: { primaryDlss: { rel: 'nvngx_dlss.dll' }, install: null }
  };
}

const PAYLOAD = {
  source: { feeder: { ok64: true, ok32: true, version: '1.17.0' }, renodx: { version: '6.5.3' }, hasNeuralRendering: true }
};

function okInstallFlow(calls) {
  return async (config) => {
    calls.push({ kind: 'install', config });
    return { ok: true, replaced: 2, added: 3, manifest: { replaced: [1, 2], added: [1, 2, 3] } };
  };
}

test('successful smart install records LKG and waits for game verification', async t => {
  const gameDir = temp(t);
  const userData = temp(t);
  const calls = [];
  const r = await install.runSmartInstall({ gameDir, mode: 'auto' }, {
    userData, send: () => {}, payload: PAYLOAD,
    detection: baseDetection(gameDir),
    install: okInstallFlow(calls)
  });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'waiting_for_verification');
  assert.equal(r.route, 'native');
  const state = recovery.readGameState(gameDir, { userData });
  assert.equal(state.verifyState, 'waiting_for_verification');
  assert.ok(state.lastKnownGood, 'LKG must be recorded');
  assert.equal(state.lastKnownGood.route, 'native');
  assert.equal(state.lastKnownGood.verifiedAt, null);
  assert.equal(state.installHistory.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.antiCheatAcknowledged, false);
  assert.equal(calls[0].config.installReShade, true);
});

test('blocked recommendation never reaches the installer', async t => {
  const gameDir = temp(t);
  const userData = temp(t);
  const d = baseDetection(gameDir);
  d.antiCheat = { present: true, names: ['EAC'], blocked: true };
  let called = false;
  const r = await install.runSmartInstall({ gameDir, mode: 'auto' }, {
    userData, send: () => {}, payload: PAYLOAD, detection: d,
    install: async () => { called = true; return { ok: true }; }
  });
  assert.equal(r.ok, false);
  assert.equal(called, false, 'installer must not run on a blocked game');
  assert.equal(r.code, 'autoBlocked');
});

test('preflight failure stops before installing', async t => {
  const gameDir = temp(t);
  const userData = temp(t);
  const d = baseDetection(gameDir);
  d.writable = false;
  let called = false;
  const r = await install.runSmartInstall({ gameDir, mode: 'auto' }, {
    userData, send: () => {}, payload: PAYLOAD, detection: d,
    install: async () => { called = true; return { ok: true }; }
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'autoPreflight');
  assert.equal(called, false);
});

test('install failure with a pending journal rolls back through official restore', async t => {
  const gameDir = temp(t);
  const userData = temp(t);
  let restored = false;
  const r = await install.runSmartInstall({ gameDir, mode: 'auto' }, {
    userData, send: () => {}, payload: PAYLOAD, detection: baseDetection(gameDir),
    // Bypass preflight so the scenario below can exercise the installer
    // itself; preflight's own pending-journal block is covered elsewhere.
    preflight: { ok: true, blocked: false, checks: [], errors: [], warnings: [] },
    install: async () => {
      // Simulate a transaction that was interrupted mid-switch: the pending
      // journal appears only after the install started, never before.
      fs.mkdirSync(path.join(gameDir, '_DLSS5_Backup', '.transactions', 'abc'), { recursive: true });
      fs.writeFileSync(journal.pendingPath(gameDir), JSON.stringify({ version: 1, folder: '_DLSS5_Backup/.transactions/abc', dirs: [], files: [] }));
      throw Object.assign(new Error('half written'), { code: 'boom' });
    },
    restore: async () => { restored = true; }
  });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'rolled_back');
  assert.equal(restored, true);
  const state = recovery.readGameState(gameDir, { userData });
  assert.equal(state.verifyState, 'rolled_back');
  assert.ok(state.installHistory.some(e => e.rolledBack));
});

test('install failure without a pending journal is FAILED, not rolled back', async t => {
  const gameDir = temp(t);
  const userData = temp(t);
  let restored = false;
  const r = await install.runSmartInstall({ gameDir, mode: 'auto' }, {
    userData, send: () => {}, payload: PAYLOAD, detection: baseDetection(gameDir),
    install: async () => { throw Object.assign(new Error('network'), { code: 'errOptiDownload' }); },
    restore: async () => { restored = true; }
  });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'failed');
  assert.equal(restored, false, 'no pending journal means no rollback');
});

test('per-game state is isolated: changing one game never touches another', async t => {
  const gameDirA = temp(t);
  const gameDirB = temp(t);
  const userData = temp(t);
  await install.runSmartInstall({ gameDir: gameDirA, mode: 'stable' }, {
    userData, send: () => {}, payload: PAYLOAD, detection: baseDetection(gameDirA),
    install: async () => ({ ok: true, replaced: 1, added: 1 })
  });
  await install.runSmartInstall({ gameDir: gameDirB, mode: 'auto' }, {
    userData, send: () => {}, payload: PAYLOAD, detection: baseDetection(gameDirB),
    install: async () => ({ ok: true, replaced: 1, added: 1 })
  });
  const a = recovery.readGameState(gameDirA, { userData });
  const b = recovery.readGameState(gameDirB, { userData });
  assert.equal(a.installHistory.length, 1);
  assert.equal(b.installHistory.length, 1);
  a.installHistory.push({ probe: true });
  assert.equal(recovery.readGameState(gameDirB, { userData }).installHistory.length, 1, 'A change must not leak into B');
});

test('restoreLastKnownGood reinstalls the recorded route', async t => {
  const gameDir = temp(t);
  const userData = temp(t);
  const calls = [];
  await install.runSmartInstall({ gameDir, mode: 'auto' }, {
    userData, send: () => {}, payload: PAYLOAD, detection: baseDetection(gameDir),
    install: okInstallFlow(calls)
  });
  let restored = false;
  const r = await recovery.restoreLastKnownGood(gameDir, { exePath: path.join(gameDir, 'game.exe'), api: 'dxgi' }, {
    userData,
    restore: async () => { restored = true; },
    installFlow: async (cfg) => {
      calls.push({ kind: 'lkg-reinstall', config: cfg });
      return { ok: true, replaced: 2, added: 2 };
    }
  });
  assert.equal(r.ok, true);
  assert.equal(restored, true);
  assert.equal(calls.some(c => c.kind === 'lkg-reinstall' && c.config.route === 'native'), true);
  const state = recovery.readGameState(gameDir, { userData });
  assert.equal(state.verifyState, 'waiting_for_verification');
  assert.equal(state.lastKnownGood.route, 'native');
});

test('restoreLastKnownGood without a saved config is refused', async t => {
  const gameDir = temp(t);
  const userData = temp(t);
  const r = await recovery.restoreLastKnownGood(gameDir, { exePath: 'x' }, { userData });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'errNoLastKnownGood');
});

test('a failed attempt never overwrites the last known good', async t => {
  const gameDir = temp(t);
  const userData = temp(t);
  await install.runSmartInstall({ gameDir, mode: 'auto' }, {
    userData, send: () => {}, payload: PAYLOAD, detection: baseDetection(gameDir),
    install: async () => ({ ok: true, replaced: 1, added: 1 })
  });
  const before = recovery.readGameState(gameDir, { userData }).lastKnownGood;
  await install.runSmartInstall({ gameDir, mode: 'quality' }, {
    userData, send: () => {}, payload: PAYLOAD, detection: baseDetection(gameDir),
    install: async () => { throw new Error('boom'); }
  });
  const after = recovery.readGameState(gameDir, { userData }).lastKnownGood;
  assert.deepEqual(after, before, 'LKG must survive a failed attempt');
});
