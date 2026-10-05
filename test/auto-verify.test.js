'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const verifyMod = require('../src/automation/verify');
const recovery = require('../src/automation/recovery');

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('no logs yet means NOT_TESTED / waiting for the game', async t => {
  const root = temp(t);
  const v = verifyMod.verifyInstallation(root, { recommendedRoute: 'feeder' }, { exeDir: root });
  assert.equal(v.verdict, 'NOT_TESTED');
  assert.equal(v.state, 'waiting_for_verification');
});

test('healthy route logs yield SUCCESS', async t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'ReShade.log'), [
    'ReShade runtime version: 6.4.1',
    'Loading and initializing add-ons...',
    'Loaded DLSS5 feed add-on',
    'Initialized successfully'
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'dlss5-feed.log'), [
    'dlss5-feed host64 started',
    'shader loaded',
    'motion provider ready'
  ].join('\n'));
  const v = verifyMod.verifyInstallation(root, { recommendedRoute: 'feeder' }, { exeDir: root });
  assert.equal(v.verdict, 'SUCCESS');
  assert.equal(v.state, 'working');
});

test('DLL load errors yield FAILED with findings', async t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'ReShade.log'), 'DLL Load Error: failed to load dxgi.dll');
  fs.writeFileSync(path.join(root, 'dlss5-feed.log'), 'error: initialization failed');
  const v = verifyMod.verifyInstallation(root, { recommendedRoute: 'feeder' }, { exeDir: root });
  assert.equal(v.verdict, 'FAILED');
  assert.equal(v.state, 'failed');
  assert.ok(v.findings.length >= 1);
});

test('a fresh log that never engaged is PARTIAL', async t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'ReShade.log'), 'ReShade runtime version: 6.4.1');
  const v = verifyMod.verifyInstallation(root, { recommendedRoute: 'feeder' }, { exeDir: root });
  assert.equal(v.verdict, 'PARTIAL');
  assert.equal(v.state, 'needs_attention');
});

test('routine warning lines are not treated as failures', async t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'ReShade.log'), [
    'Warning: texture not found, skipping',
    'Loading and initializing add-ons...',
    'Loaded DLSS5 feed add-on',
    'Initialized successfully'
  ].join('\n'));
  const v = verifyMod.verifyInstallation(root, { recommendedRoute: 'feeder' }, { exeDir: root });
  assert.equal(v.verdict, 'SUCCESS');
});

test('diagnosis explains dgVoodoo loader mismatch and offers the safe repair', async t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'ReShade.log'), 'DLL Load Error');
  const detection = {
    exe: { api: 'd3d9', apiLabel: 'DirectX 9' },
    mods: [{ kind: 'dgvoodoo', rel: 'ddraw.dll' }]
  };
  const diag = verifyMod.diagnoseInstallation(root, { recommendedRoute: 'feeder' }, { exeDir: root, detection, verify: verifyMod.verifyInstallation(root, { recommendedRoute: 'feeder' }, { exeDir: root }) });
  assert.equal(diag.verdict, 'FAILED');
  assert.equal(diag.repairId, 'fix-reshade-proxy');
  assert.ok(diag.findings.some(f => f.repairId === 'fix-reshade-proxy'));
});

test('safe auto repair swaps the loader and reinstalls through the same flow', async t => {
  const root = temp(t);
  const userData = temp(t);
  const calls = [];
  const r = await verifyMod.safeAutoRepair(root, 'fix-reshade-proxy', { exePath: path.join(root, 'game.exe'), route: 'feeder', api: 'dxgi' }, {
    userData, loader: 'dxgi', send: () => {},
    install: async (config) => {
      calls.push(config.reshadeProxy);
      return { ok: true, replaced: 1, added: 1 };
    }
  });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'waiting_for_verification');
  assert.deepEqual(calls, ['d3d11'], 'repair must swap dxgi -> d3d11');
  const state = recovery.readGameState(root, { userData });
  assert.equal(state.loader, 'd3d11');
  assert.equal(state.repairHistory.length, 2, 'start + success entries');
  assert.equal(state.repairHistory[state.repairHistory.length - 1].result, 'success');
});

test('an unsafe repair id is refused', async t => {
  const root = temp(t);
  const userData = temp(t);
  let called = false;
  const r = await verifyMod.safeAutoRepair(root, 'fix-everything', { exePath: 'x', route: 'feeder', api: 'dxgi' }, {
    userData, loader: 'dxgi', send: () => {},
    install: async () => { called = true; return { ok: true }; }
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'errUnsafeRepair');
  assert.equal(called, false);
});

test('failed repair never reports success', async t => {
  const root = temp(t);
  const userData = temp(t);
  const r = await verifyMod.safeAutoRepair(root, 'fix-reshade-proxy', { exePath: 'x', route: 'feeder', api: 'dxgi' }, {
    userData, loader: 'dxgi', send: () => {},
    install: async () => { throw Object.assign(new Error('nope'), { code: 'boom' }); }
  });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'failed');
  const state = recovery.readGameState(root, { userData });
  assert.equal(state.repairHistory[state.repairHistory.length - 1].result, 'failed');
});

test('component status never trusts the file name alone', () => {
  const files = { feeder: { version: '1.17.0' }, renodx: { version: '6.5.3' } };
  const payload = { source: { feeder: { version: '1.17.0' }, renodx: { version: '6.5.3' }, hasNeuralRendering: true } };
  const list = recovery.componentStatus('D:\\x', { exePath: 'D:\\x\\game.exe', payload, files });
  const feeder = list.find(c => c.component === 'DLSS5-Feeder');
  const renodx = list.find(c => c.component === 'RenoDX consumer');
  assert.equal(feeder.status, 'CURRENT');
  assert.equal(renodx.status, 'CURRENT');
  const stale = recovery.componentStatus('D:\\x', { exePath: 'D:\\x\\game.exe', payload, files: { feeder: { version: '1.16.0' } } });
  assert.equal(stale.find(c => c.component === 'DLSS5-Feeder').status, 'OUTDATED');
});
