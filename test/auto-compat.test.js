'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const compat = require('../src/automation/compat');

function detection(overrides = {}) {
  return {
    gameDir: 'D:\\Games\\TestGame',
    ok: true,
    exe: {
      path: 'D:\\Games\\TestGame\\game.exe',
      rel: 'game.exe',
      api: overrides.api || 'dxgi',
      apiLabel: overrides.apiLabel || 'DirectX 12',
      bitness: overrides.bitness || 64,
      via: overrides.via || 'imports',
      emulator: overrides.emulator || null
    },
    apiConfidence: overrides.apiConfidence || 'HIGH',
    gpu: {
      available: overrides.gpuAvailable !== undefined ? overrides.gpuAvailable : true,
      primary: overrides.primary || { name: 'NVIDIA GeForce RTX 5070', driver: '616.56' },
      isNvidia: overrides.isNvidia !== undefined ? overrides.isNvidia : true,
      isRtx: overrides.isRtx !== undefined ? overrides.isRtx : true,
      isBlackwell: overrides.isBlackwell !== undefined ? overrides.isBlackwell : true,
      driver: overrides.driver || '616.56',
      driverNumber: overrides.driverNumber !== undefined ? overrides.driverNumber : 61656,
      driverSupported: true,
      modelSupported: true
    },
    multiGpu: false,
    existingDlls: overrides.existingDlls || [],
    nvidiaFiles: [],
    reshade: overrides.reshade || { installed: false, version: null, file: null, installedByUs: false },
    mods: [],
    antiCheat: overrides.antiCheat || { present: false, names: [], blocked: false },
    writable: true,
    diskSpace: { free: 40 * 1024 * 1024 * 1024, total: 100 * 1024 * 1024 * 1024, ok: true },
    managedModRoot: overrides.managedModRoot || null,
    scan: overrides.scan || { primaryDlss: { rel: 'nvngx_dlss.dll' }, install: null }
  };
}

test('RTX + DX12 + native DLSS recommends the native route with HIGH confidence', () => {
  const r = compat.buildRecommendation(detection(), 'auto');
  assert.equal(r.blocked, false);
  assert.equal(r.recommendedRoute, 'native');
  assert.equal(r.confidence, 'HIGH');
  assert.ok(r.reasons.length >= 3, 'reasons must be explainable');
  assert.ok(r.reasons.some(x => /RTX/i.test(x)));
  assert.ok(r.reasons.some(x => /API/i.test(x)));
});

test('no native DLSS steers to Feeder', () => {
  const r = compat.buildRecommendation(detection({ scan: { primaryDlss: null, install: null } }), 'auto');
  assert.equal(r.recommendedRoute, 'feeder');
});

test('non-RTX NVIDIA is not auto-installed', () => {
  const r = compat.buildRecommendation(detection({ isRtx: false, primary: { name: 'NVIDIA GeForce GTX 1080', driver: '551.86' }, driverNumber: 55186 }), 'auto');
  assert.equal(r.blocked, false);
  assert.equal(r.confidence, 'LOW');
  assert.ok(r.warnings.some(w => /NVIDIA RTX/i.test(w)), 'must carry the non-RTX warning');
});

test('non-NVIDIA GPU blocks with the RTX-only message', () => {
  const r = compat.buildRecommendation(detection({ isNvidia: false, isRtx: false, primary: { name: 'AMD Radeon RX 7800 XT', driver: '31.0.0.0' } }), 'auto');
  assert.equal(r.blocked, true);
  assert.equal(r.blockReason, 'non-nvidia');
  assert.ok(r.warnings.some(w => /NVIDIA RTX/i.test(w)));
});

test('anti-cheat blocks the smart path', () => {
  const r = compat.buildRecommendation(detection({ antiCheat: { present: true, names: ['EasyAntiCheat'], blocked: true } }), 'auto');
  assert.equal(r.blocked, true);
  assert.equal(r.blockReason, 'anti-cheat');
});

test('unknown API blocks with UNKNOWN confidence', () => {
  const r = compat.buildRecommendation(detection({ apiConfidence: 'UNKNOWN' }), 'auto');
  assert.equal(r.blocked, true);
  assert.equal(r.blockReason, 'unknown-api');
  assert.equal(r.confidence, 'UNKNOWN');
});

test('unknown proxy DLL blocks the smart path', () => {
  const r = compat.buildRecommendation(detection({ existingDlls: [{ name: 'dxgi.dll', kind: 'unknown', conflict: true }] }), 'auto');
  assert.equal(r.blocked, true);
  assert.equal(r.blockReason, 'unknown-dll');
});

test('existing ReShade is reused, never counted as a conflict', () => {
  const r = compat.buildRecommendation(detection({ reshade: { installed: true, version: '6.4.1', file: 'dxgi.dll', installedByUs: false } }), 'auto');
  assert.equal(r.blocked, false);
  assert.ok(r.reasons.some(x => /ReShade/i.test(x)), 'should mention ReShade reuse');
});

test('multipass stays conservative: auto/stable/quality/performance use 1, experimental uses 3', () => {
  for (const mode of ['auto', 'stable', 'quality', 'performance']) {
    const r = compat.buildRecommendation(detection({ scan: { primaryDlss: null, install: null } }), mode);
    assert.equal(r.multipass, 1, `${mode} multipass must be 1`);
  }
  const exp = compat.buildRecommendation(detection({ scan: { primaryDlss: null, install: null } }), 'experimental');
  assert.equal(exp.multipass, 3);
  assert.ok(exp.warnings.some(w => /实验功能可能导致/i.test(w)), 'experimental mode carries its warning');
});

test('quality mode prefers native and offers OptiScaler pre-SR only on capable hardware', () => {
  const r = compat.buildRecommendation(detection(), 'quality');
  assert.equal(r.recommendedRoute, 'native');
  assert.ok(r.optionalRoutes.includes('optiscaler-presr'), 'RTX Blackwell + new driver should offer pre-SR');
});

test('quality mode on older driver does not offer pre-SR', () => {
  const r = compat.buildRecommendation(detection({ driverNumber: 55186, driver: '551.86' }), 'quality');
  assert.ok(!r.optionalRoutes.includes('optiscaler-presr'));
});

test('performance mode avoids extra layers', () => {
  const r = compat.buildRecommendation(detection({ scan: { primaryDlss: null, install: null } }), 'performance');
  assert.equal(r.recommendedRoute, 'feeder');
});

test('managed modpack root blocks', () => {
  const r = compat.buildRecommendation(detection({ managedModRoot: true }), 'auto');
  assert.equal(r.blocked, true);
  assert.equal(r.blockReason, 'managed-modpack');
});

test('DX9 + dgVoodoo route availability flows from the official route table', () => {
  const d = detection({ api: 'd3d9', apiLabel: 'DirectX 9', scan: { primaryDlss: null, install: null } });
  const r = compat.buildRecommendation(d, 'auto');
  assert.equal(r.blocked, false);
  assert.ok(['feeder', 'renodx', 'optiscaler'].includes(r.recommendedRoute));
});

test('fallback routes are a subset of official routes', () => {
  const r = compat.buildRecommendation(detection(), 'auto');
  assert.ok(Array.isArray(r.fallbackRoutes));
  assert.ok(!r.fallbackRoutes.includes(r.recommendedRoute));
});
