'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const detect = require('../src/automation/detect');

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-detect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// pe.versionMentions only reads a PE version resource (UTF-16). In tests we
// inject a content-based stand-in so plain fixture files classify the same way
// a real DLL's version resource would.
function fakeVersionMentions(file, needle) {
  let content = '';
  try { content = fs.readFileSync(file).toString(); } catch { return false; }
  return content.includes(needle);
}

function fakeScan(root, overrides = {}) {
  const exe = {
    path: overrides.exePath || path.join(root, 'game.exe'),
    rel: overrides.rel || 'game.exe',
    api: overrides.api || 'dxgi',
    apiLabel: overrides.apiLabel || 'DirectX 12',
    bitness: overrides.bitness || 64,
    via: overrides.via || 'imports',
    emulator: overrides.emulator || null,
    apiChoices: []
  };
  return {
    exeCandidates: [exe],
    chosen: exe,
    reshade: overrides.reshade || { installed: false, version: null, file: null, installedByUs: false },
    primaryDlss: overrides.primaryDlss || null,
    install: overrides.install || null,
    ok: true
  };
}

const RTX = [{ name: 'NVIDIA GeForce RTX 5070', driver: '616.56' }];
const GTX = [{ name: 'NVIDIA GeForce GTX 1080', driver: '551.86' }];
const AMD = [{ name: 'AMD Radeon RX 7800 XT', driver: '31.0.23000.0' }];
const MULTI = [{ name: 'NVIDIA GeForce RTX 5070', driver: '616.56' }, { name: 'NVIDIA GeForce GTX 1080', driver: '551.86' }];

test('NVIDIA RTX GPU is detected with driver and Blackwell model', async t => {
  const root = temp(t);
  const d = await detect.detectGame({ gameDir: root }, { scanGame: () => fakeScan(root), gpuInfo: () => RTX, versionMentions: fakeVersionMentions });
  assert.equal(d.gpu.available, true);
  assert.equal(d.gpu.isNvidia, true);
  assert.equal(d.gpu.isRtx, true);
  assert.equal(d.gpu.isBlackwell, true);
  assert.equal(d.gpu.driverNumber, 61656);
  assert.equal(d.multiGpu, false);
});

test('non-RTX NVIDIA card is NVIDIA but not RTX', async t => {
  const root = temp(t);
  const d = await detect.detectGame({ gameDir: root }, { scanGame: () => fakeScan(root), gpuInfo: () => GTX, versionMentions: fakeVersionMentions });
  assert.equal(d.gpu.isNvidia, true);
  assert.equal(d.gpu.isRtx, false);
  assert.equal(d.gpu.isBlackwell, false);
});

test('multi-GPU environment reports the primary card and multiGpu', async t => {
  const root = temp(t);
  const d = await detect.detectGame({ gameDir: root }, { scanGame: () => fakeScan(root), gpuInfo: () => MULTI, versionMentions: fakeVersionMentions });
  assert.equal(d.multiGpu, true);
  assert.equal(d.gpu.primary.name, 'NVIDIA GeForce RTX 5070');
});

test('non-NVIDIA GPU is flagged as such', async t => {
  const root = temp(t);
  const d = await detect.detectGame({ gameDir: root }, { scanGame: () => fakeScan(root), gpuInfo: () => AMD, versionMentions: fakeVersionMentions });
  assert.equal(d.gpu.isNvidia, false);
  assert.equal(d.gpu.isRtx, false);
});

test('API detection carries confidence from detection method', async t => {
  const root = temp(t);
  for (const via of ['imports', 'strings', 'undetected']) {
    const d = await detect.detectGame({ gameDir: root }, { scanGame: () => fakeScan(root, { via }), gpuInfo: () => RTX, versionMentions: fakeVersionMentions });
    const want = via === 'imports' ? 'HIGH' : via === 'undetected' ? 'UNKNOWN' : 'MEDIUM';
    assert.equal(d.apiConfidence, want, `via=${via}`);
  }
});

test('DX11 / DX12 / Vulkan games keep their api key', async t => {
  const root = temp(t);
  const cases = [['d3d11', 'DirectX 11'], ['dxgi', 'DirectX 12'], ['vulkan', 'Vulkan']];
  for (const [api, label] of cases) {
    const d = await detect.detectGame({ gameDir: root }, { scanGame: () => fakeScan(root, { api, apiLabel: label }), gpuInfo: () => RTX, versionMentions: fakeVersionMentions });
    assert.equal(d.exe.api, api);
    assert.equal(d.exe.apiLabel, label);
  }
});

test('existing ReShade proxy beside the game is classified as reshade, not unknown', async t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'dxgi.dll'), 'ReShade runtime');
  const d = await detect.detectGame({ gameDir: root }, { scanGame: () => fakeScan(root), gpuInfo: () => RTX, versionMentions: fakeVersionMentions });
  const found = d.existingDlls.find(x => x.name.toLowerCase() === 'dxgi.dll');
  assert.ok(found, 'dxgi.dll should be scanned');
  assert.equal(found.kind, 'reshade');
  assert.equal(found.conflict, false);
});

test('an unknown proxy DLL is high risk', async t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'version.dll'), 'something else entirely');
  const d = await detect.detectGame({ gameDir: root }, { scanGame: () => fakeScan(root), gpuInfo: () => RTX, versionMentions: fakeVersionMentions });
  const found = d.existingDlls.find(x => x.name.toLowerCase() === 'version.dll');
  assert.equal(found.kind, 'unknown');
  assert.equal(found.conflict, true);
});

test('OptiScaler proxy DLL is a conflict', async t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'dxgi.dll'), 'OptiScaler build');
  const d = await detect.detectGame({ gameDir: root }, { scanGame: () => fakeScan(root), gpuInfo: () => RTX, versionMentions: fakeVersionMentions });
  const found = d.existingDlls.find(x => x.name.toLowerCase() === 'dxgi.dll');
  assert.equal(found.kind, 'optiscaler');
  assert.equal(found.conflict, true);
});

test('NVIDIA runtime files are listed with hash and managed flag', async t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'nvngx_dlss.dll'), 'runtime');
  const d = await detect.detectGame({ gameDir: root }, { scanGame: () => fakeScan(root), gpuInfo: () => RTX, versionMentions: fakeVersionMentions });
  assert.equal(d.nvidiaFiles.length, 1);
  assert.equal(d.nvidiaFiles[0].name, 'nvngx_dlss.dll');
  assert.equal(d.nvidiaFiles[0].sha256.length, 64);
  assert.equal(d.nvidiaFiles[0].managed, false);
});

test('anti-cheat directory names are detected and block the smart path', async t => {
  const root = temp(t);
  fs.mkdirSync(path.join(root, 'EasyAntiCheat'), { recursive: true });
  const d = await detect.detectGame({ gameDir: root }, { scanGame: () => fakeScan(root), gpuInfo: () => RTX, versionMentions: fakeVersionMentions });
  assert.equal(d.antiCheat.present, true);
  assert.equal(d.antiCheat.blocked, true);
  assert.ok(d.antiCheat.names.includes('EasyAntiCheat'));
});

test('BattlEye is detected', async t => {
  const root = temp(t);
  fs.mkdirSync(path.join(root, 'BattlEye'), { recursive: true });
  const d = await detect.detectGame({ gameDir: root }, { scanGame: () => fakeScan(root), gpuInfo: () => RTX, versionMentions: fakeVersionMentions });
  assert.equal(d.antiCheat.blocked, true);
});

test('read-only game folder is reported without pretending it is writable', async t => {
  const root = temp(t);
  const d = await detect.detectGame({ gameDir: root }, {
    scanGame: () => fakeScan(root), gpuInfo: () => RTX, versionMentions: fakeVersionMentions,
    canWrite: () => false
  });
  assert.equal(d.writable, false);
});

test('unicode and spaced paths are scanned without breaking', async t => {
  const root = temp(t);
  const game = path.join(root, '深海 迷航 2 (Game)');
  fs.mkdirSync(game, { recursive: true });
  fs.writeFileSync(path.join(game, 'dxgi.dll'), 'ReShade runtime');
  const d = await detect.detectGame({ gameDir: game }, { scanGame: () => fakeScan(game), gpuInfo: () => RTX, versionMentions: fakeVersionMentions });
  assert.equal(d.gameDir, game);
  assert.ok(d.existingDlls.length >= 1);
});

test('dgVoodoo marker in a proxy is classified, not unknown', async t => {
  const root = temp(t);
  fs.writeFileSync(path.join(root, 'ddraw.dll'), 'dgVoodoo wrapper');
  const d = await detect.detectGame({ gameDir: root }, { scanGame: () => fakeScan(root), gpuInfo: () => RTX, versionMentions: fakeVersionMentions });
  const found = d.existingDlls.find(x => x.name.toLowerCase() === 'ddraw.dll');
  assert.equal(found.kind, 'dgvoodoo');
  assert.ok(d.mods.some(mod => mod.kind === 'dgvoodoo'));
});

test('mixed GPUs never borrow Blackwell capability or driver from another card', async t => {
  const root = temp(t);
  for (const rows of [
    [{ name: 'NVIDIA GeForce RTX 3070', driver: '551.86' }, ...RTX],
    [{ name: 'NVIDIA GeForce RTX 5070', driver: '551.86' }, ...RTX]
  ]) {
    const d = await detect.detectGame({ gameDir: root }, { scanGame: () => fakeScan(root), gpuInfo: () => rows });
    assert.equal(d.gpu.isBlackwell, rows[0].name.includes('5070'));
    assert.equal(d.gpu.driverSupported, false);
    assert.equal(d.gpu.driverNumber, 55186);
    assert.equal(d.multiGpu, true);
  }
});

test('manual API choice changes the effective target without erasing scan evidence', async t => {
  const root = temp(t), scan = fakeScan(root, { via: 'undetected' });
  const d = await detect.detectGame({ gameDir: root, apiOverride: 'd3d11' }, { scanGame: () => scan, gpuInfo: () => RTX });
  assert.equal(d.exe.api, 'dxgi');
  assert.equal(d.exe.apiLabel, 'DirectX 11');
  assert.equal(d.exe.via, 'manual');
  assert.equal(d.apiConfidence, 'MEDIUM');
  assert.equal(scan.chosen.apiLabel, 'DirectX 12');
  assert.equal(scan.chosen.via, 'undetected');
});

test('an explicit executable outside the candidates never falls back to a different game', async t => {
  const root = temp(t);
  const d = await detect.detectGame({ gameDir: root, exePath: path.join(root, 'missing.exe') }, {
    scanGame: () => fakeScan(root), gpuInfo: () => RTX
  });
  assert.equal(d.ok, false);
  assert.equal(d.exe, null);
  assert.equal(d.apiConfidence, 'UNKNOWN');
});
