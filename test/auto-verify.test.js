'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const verifyMod = require('../src/automation/verify');
const recovery = require('../src/automation/recovery');
const { snapshotLogs } = require('../src/automation/runtime-logs');

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

test('delivered frames plus neural feature execution yield SUCCESS', async t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'ReShade.log'), [
    'ReShade runtime version: 6.4.1',
    'Loading and initializing add-ons...',
    'Loaded DLSS5 feed add-on',
    'feature 18 created',
    'evaluation succeeded'
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'dlss5-feed.log'), [
    '[feed] frame 1 delivered (1920x1080, reset=0)'
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
    'Loaded renodx-dlss5.addon64',
    'feature 18 created',
    'evaluation succeeded'
  ].join('\n'));
  const v = verifyMod.verifyInstallation(root, { recommendedRoute: 'native' }, { exeDir: root });
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

test('generic add-on startup and feature-1 DLAA never prove neural rendering', t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'ReShade.log'), 'Loaded unrelated texture pack\nInitialized unrelated overlay');
  for (const route of ['native', 'renodx', 'feeder', 'optiscaler']) {
    assert.equal(verifyMod.verifyInstallation(root, { recommendedRoute: route }).verdict, 'PARTIAL');
  }
  fs.writeFileSync(path.join(root, 'ReShade.log'), 'Loaded renodx-dlss5.addon64\nfeature 1 created\nevaluation succeeded');
  assert.equal(verifyMod.verifyInstallation(root, { recommendedRoute: 'native' }).verdict, 'PARTIAL');
});

test('route identity plus feature-18 execution verifies only the matching route', t => {
  const root = temp(t);
  for (const [route, identity] of [['native', 'renodx-dlss5.addon64'], ['renodx', 'renodx-dlss.addon64'], ['optiscaler', 'OptiScaler']]) {
    fs.writeFileSync(path.join(root, 'ReShade.log'), `Loaded ${identity}\nfeature 18 created\nevaluation succeeded`);
    assert.equal(verifyMod.verifyInstallation(root, { recommendedRoute: route }).verdict, 'SUCCESS');
    assert.equal(verifyMod.verifyInstallation(root, { recommendedRoute: 'feeder' }).verdict, 'PARTIAL');
  }
});

test('warning-prefixed initialization failure is not suppressed', t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'ReShade.log'), 'Loaded renodx-dlss5.addon64\nfeature 18 created\nevaluation succeeded\nWarning: failed to initialize DLSS');
  assert.equal(verifyMod.verifyInstallation(root, { recommendedRoute: 'native' }).verdict, 'FAILED');
});

test('a fatal error beyond the old 64KB limit defeats earlier positive evidence', t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'ReShade.log'), 'Loaded renodx-dlss5.addon64\nfeature 18 created\nevaluation succeeded\n' + 'x'.repeat(70 * 1024) + '\nFatal: evaluate failed');
  assert.equal(verifyMod.verifyInstallation(root, { recommendedRoute: 'native' }).verdict, 'FAILED');
});

test('touching or appending unrelated messages cannot reuse pre-install success', t => {
  const root = temp(t), file = path.join(root, 'ReShade.log');
  fs.writeFileSync(file, 'Loaded renodx-dlss5.addon64\nfeature 18 created\nevaluation succeeded\n');
  const logSnapshot = snapshotLogs(root), installedAt = new Date(Date.now() - 1000).toISOString();
  fs.appendFileSync(file, 'New session: Loaded unrelated texture pack\nInitialized overlay\n');
  const result = verifyMod.verifyInstallation(root, { recommendedRoute: 'native' }, { installedAt, logSnapshot });
  assert.equal(result.verdict, 'PARTIAL');
  assert.equal(result.engaged, false);
});

test('a rotated log with a new neural session can still verify', t => {
  const root = temp(t), file = path.join(root, 'ReShade.log');
  fs.writeFileSync(file, 'old log'.repeat(100));
  const logSnapshot = snapshotLogs(root);
  fs.writeFileSync(file, 'Loaded renodx-dlss5.addon64\nfeature 18 created\nevaluation succeeded');
  assert.equal(verifyMod.verifyInstallation(root, { recommendedRoute: 'native' }, {
    installedAt: new Date(Date.now() - 1000).toISOString(), logSnapshot
  }).verdict, 'SUCCESS');
});

test('missing session baseline, unreadable or oversized logs cannot report success', t => {
  const root = temp(t), file = path.join(root, 'ReShade.log');
  fs.writeFileSync(file, 'Loaded renodx-dlss5.addon64\nfeature 18 created\nevaluation succeeded');
  assert.equal(verifyMod.verifyInstallation(root, { recommendedRoute: 'native' }, {
    installedAt: new Date(Date.now() - 1000).toISOString()
  }).verdict, 'PARTIAL');
  assert.equal(verifyMod.verifyInstallation(root, { recommendedRoute: 'native' }, {
    logSnapshot: { 'ReShade.log': { unreadable: true } }
  }).verdict, 'PARTIAL');
  fs.appendFileSync(file, '\n' + 'x'.repeat(8 * 1024 * 1024));
  const result = verifyMod.verifyInstallation(root, { recommendedRoute: 'native' });
  assert.notEqual(result.verdict, 'SUCCESS');
  assert.equal(result.logs[0].truncated, true);
});

test('32-bit host evidence is kept separate from the game process', t => {
  const root = temp(t); fs.mkdirSync(path.join(root, 'host64'));
  fs.writeFileSync(path.join(root, 'dlss5-feed.log'), '[feed] frame 1 delivered');
  fs.writeFileSync(path.join(root, 'host64', 'ReShade.log'), 'feature 18 created\nevaluation succeeded');
  assert.equal(verifyMod.verifyInstallation(root, { recommendedRoute: 'feeder' }).verdict, 'PARTIAL');
  fs.writeFileSync(path.join(root, 'host64', 'dlss5-feed-host.log'), '[host] frame 1 evaluated (0 presents skipped)');
  assert.equal(verifyMod.verifyInstallation(root, { recommendedRoute: 'feeder' }).verdict, 'SUCCESS');
});

test('log instructions containing success keywords are not execution evidence', t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'ReShade.log'), "Loaded renodx-dlss5.addon64\ncheck the host log for 'feature 18 created' / 'evaluation succeeded'");
  assert.equal(verifyMod.verifyInstallation(root, { recommendedRoute: 'native' }).verdict, 'PARTIAL');
});

test('dgVoodoo proxy repair requires a loader failure and is not offered twice', t => {
  const root = temp(t), file = path.join(root, 'ReShade.log');
  const detection = { exe: { api: 'd3d9' }, existingDlls: [{ kind: 'dgvoodoo' }] };
  fs.writeFileSync(file, 'DLL Load Error');
  assert.equal(verifyMod.diagnoseInstallation(root, { recommendedRoute: 'feeder' }, { detection }).repairId, 'fix-reshade-proxy');
  assert.equal(verifyMod.diagnoseInstallation(root, { recommendedRoute: 'feeder' }, { detection, loader: 'd3d11' }).repairId, null);
  fs.writeFileSync(file, 'Warning: failed to initialize DLSS');
  assert.equal(verifyMod.diagnoseInstallation(root, { recommendedRoute: 'feeder' }, { detection }).repairId, null);
});
