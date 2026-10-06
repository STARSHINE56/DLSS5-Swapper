'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const planMod = require('../src/automation/plan');
const journal = require('../src/core/file-journal');

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function detection(root, overrides = {}) {
  return {
    gameDir: root,
    ok: true,
    exe: {
      path: path.join(root, 'game.exe'),
      rel: 'game.exe',
      api: overrides.api || 'dxgi',
      apiLabel: overrides.apiLabel || 'DirectX 12',
      bitness: 64,
      via: 'imports',
      emulator: null
    },
    apiConfidence: overrides.apiConfidence || 'HIGH',
    gpu: {
      available: true,
      primary: { name: 'NVIDIA GeForce RTX 5070', driver: '616.56' },
      isNvidia: true, isRtx: true, isBlackwell: true,
      driver: '616.56', driverNumber: 61656, driverSupported: true, modelSupported: true
    },
    multiGpu: false,
    existingDlls: overrides.existingDlls || [],
    nvidiaFiles: [],
    reshade: { installed: false, version: null, file: null, installedByUs: false },
    mods: [],
    antiCheat: overrides.antiCheat || { present: false, names: [], blocked: false },
    writable: overrides.writable !== undefined ? overrides.writable : true,
    diskSpace: overrides.diskSpace || { free: 40 * 1024 * 1024 * 1024, total: 100 * 1024 * 1024 * 1024, ok: true },
    managedModRoot: overrides.managedModRoot || null,
    scan: { primaryDlss: { rel: 'nvngx_dlss.dll' }, install: null }
  };
}

function recommendation(route = 'native') {
  return {
    blocked: false, blockReason: null, recommendedRoute: route,
    fallbackRoutes: [], optionalRoutes: [], confidence: 'HIGH',
    warnings: [], reasons: [], conflicts: [], antiCheat: { present: false, names: [], blocked: false },
    multipass: 1, experimental: false, mode: 'auto'
  };
}

const PAYLOAD = {
  source: {
    feeder: { ok64: true, ok32: true, version: '1.17.0' },
    renodx: { version: '6.5.3' },
    hasNeuralRendering: true
  }
};

test('preflight passes for a healthy RTX DX12 game', async t => {
  const root = temp(t);
  const p = planMod.preflightCheck(detection(root), recommendation('native'), { payload: PAYLOAD });
  assert.equal(p.ok, true);
  assert.equal(p.blocked, false);
  assert.ok(p.checks.every(c => c.status !== 'fail'));
});

test('preflight exposes multi-GPU, manual API and unknown-driver uncertainties', t => {
  const root = temp(t), d = detection(root, { apiConfidence: 'MEDIUM' });
  d.exe.via = 'manual'; d.multiGpu = true; d.gpu.driverNumber = null;
  const p = planMod.preflightCheck(d, recommendation(), { payload: PAYLOAD });
  assert.equal(p.ok, true);
  for (const name of ['multi-gpu', 'api', 'driver']) assert.ok(p.warnings.includes(name));
});

test('non-NVIDIA GPU fails preflight', async t => {
  const root = temp(t);
  const d = detection(root, {});
  d.gpu.isNvidia = false; d.gpu.isRtx = false; d.gpu.isBlackwell = false;
  d.gpu.primary = { name: 'AMD Radeon RX 7800 XT', driver: '31.0.0.0' };
  const p = planMod.preflightCheck(d, recommendation('native'), { payload: PAYLOAD });
  assert.equal(p.ok, false);
  assert.ok(p.errors.includes('gpu'));
});

test('unknown API fails preflight', async t => {
  const root = temp(t);
  const p = planMod.preflightCheck(detection(root, { apiConfidence: 'UNKNOWN' }), recommendation('native'), { payload: PAYLOAD });
  assert.equal(p.ok, false);
  assert.ok(p.errors.includes('api'));
});

test('read-only game folder fails preflight with the permission message', async t => {
  const root = temp(t);
  const p = planMod.preflightCheck(detection(root, { writable: false }), recommendation('native'), { payload: PAYLOAD });
  assert.equal(p.ok, false);
  const check = p.checks.find(c => c.name === 'writable');
  assert.equal(check.status, 'fail');
  assert.match(check.message, /更高权限/);
});

test('low disk space fails preflight', async t => {
  const root = temp(t);
  const d = detection(root);
  d.diskSpace = { free: 100 * 1024 * 1024, total: 10 * 1024 * 1024 * 1024, ok: false };
  const p = planMod.preflightCheck(d, recommendation('native'), { payload: PAYLOAD });
  assert.equal(p.ok, false);
  assert.ok(p.errors.includes('disk'));
});

test('anti-cheat fails preflight', async t => {
  const root = temp(t);
  const d = detection(root, { antiCheat: { present: true, names: ['BattlEye'], blocked: true } });
  const p = planMod.preflightCheck(d, recommendation('native'), { payload: PAYLOAD });
  assert.equal(p.ok, false);
  assert.ok(p.errors.includes('anti-cheat'));
});

test('unknown proxy DLL fails preflight', async t => {
  const root = temp(t);
  const d = detection(root, { existingDlls: [{ name: 'dxgi.dll', kind: 'unknown', conflict: true, path: path.join(root, 'dxgi.dll') }] });
  const p = planMod.preflightCheck(d, recommendation('native'), { payload: PAYLOAD });
  assert.equal(p.ok, false);
  assert.ok(p.errors.includes('conflicts'));
});

test('a pending journal transaction fails preflight until Restore originals', async t => {
  const root = temp(t);
  fs.mkdirSync(path.join(root, '_DLSS5_Backup', '.transactions', 'x'), { recursive: true });
  fs.writeFileSync(journal.pendingPath(root), JSON.stringify({ version: 1, folder: '_DLSS5_Backup/.transactions/x', dirs: [], files: [] }));
  const p = planMod.preflightCheck(detection(root), recommendation('native'), { payload: PAYLOAD });
  assert.equal(p.ok, false);
  assert.ok(p.errors.includes('backup'));
});

test('missing payload fails preflight', async t => {
  const root = temp(t);
  const p = planMod.preflightCheck(detection(root), recommendation('native'), { payload: null });
  assert.equal(p.ok, false);
  assert.ok(p.errors.includes('components'));
});

test('offline network is a warning, not a block', async t => {
  const root = temp(t);
  const p = planMod.preflightCheck(detection(root), recommendation('native'), { payload: PAYLOAD, network: 'offline' });
  assert.equal(p.ok, true);
  assert.ok(p.warnings.includes('network'));
});

test('install plan lists components and replacements per route', () => {
  const root = os.tmpdir();
  const d = detection(root);
  for (const route of ['native', 'renodx', 'feeder', 'optiscaler']) {
    const plan = planMod.buildInstallPlan(d, recommendation(route), 'auto');
    assert.equal(plan.recommendedRoute, route);
    assert.ok(plan.components.length >= 1, `${route} must list components`);
    assert.ok(plan.replacements.length >= 1, `${route} must list replacements`);
    assert.equal(plan.rollbackPoint, 'auto');
    assert.ok(plan.steps.some(s => s.step === 'backup'));
    assert.ok(plan.steps.some(s => s.step === 'verify'));
  }
});

test('feeder plan includes dgVoodoo for DX8/9/DDraw and motion provider', () => {
  const root = os.tmpdir();
  const d = detection(root, { api: 'd3d9', apiLabel: 'DirectX 9' });
  const plan = planMod.buildInstallPlan(d, recommendation('feeder'), 'auto');
  const names = plan.components.map(c => c.name);
  assert.ok(names.includes('dgVoodoo2'));
  assert.ok(names.some(n => /Motion provider/.test(n)));
});

test('renodx plan uses the multipass consumer', () => {
  const root = os.tmpdir();
  const plan = planMod.buildInstallPlan(detection(root), recommendation('renodx'), 'auto');
  assert.ok(plan.components.some(c => /multipass/i.test(c.name)));
});

test('experimental mode marks risk high', () => {
  const root = os.tmpdir();
  const rec = recommendation('renodx');
  rec.experimental = true;
  const plan = planMod.buildInstallPlan(detection(root), rec, 'experimental');
  assert.equal(plan.risk, 'high');
});
