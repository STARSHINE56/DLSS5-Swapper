'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const automation = require('../src/automation');

test('saved per-EXE API choices reach detection, plan and the smart installer', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const game = path.join(root, 'game'), exe = path.join(game, 'bin', 'Game.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, 'fixture');
  const target = { path: exe, rel: path.relative(game, exe), bitness: 64, api: 'opengl', apiLabel: 'OpenGL', via: 'undetected' };
  const scan = { chosen: target, exeCandidates: [target], reshade: { installed: false }, dlssFiles: [], streamlineFiles: [] };
  const main = path.resolve(__dirname, '../main.js'), realRequire = createRequire(main), handlers = new Map();
  const installRequests = [], payloadStub = { source: { feeder: { ok64: true }, hasNeuralRendering: true } };
  let installed = null;
  const stubs = {
    electron: { app: { setAppUserModelId() {}, whenReady: () => ({ then() {} }), on() {}, getPath: () => root },
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) } },
    './src/core/scan.js': { scanGame: async () => scan, scanSource: () => ({ ok: false }) },
    './src/core/backend-manager': { readManifest: () => installed },
    './src/automation': { ...automation, detect: (options, deps) => automation.detect(options, {
      ...deps, scanGame: async () => scan, gpuInfo: async () => [{ name: 'NVIDIA GeForce RTX 5070', driver: '616.56' }],
      antiCheatPresent: () => false, canWrite: () => true
    }) }
  };
  const context = vm.createContext({ require: name => stubs[name] || realRequire(name),
    __dirname: path.dirname(main), process, Buffer, console, setTimeout, clearTimeout, installRequests, payloadStub });
  vm.runInContext(fs.readFileSync(main, 'utf8'), context, { filename: main });
  vm.runInContext(`payload = () => payloadStub;
    officialInstallFlow = async (_event, dir, exePath, route, apiChoice) => {
      installRequests.push({ exePath, route, apiChoice });
      return { ok: true, manifest: { game: { exe: require('path').relative(dir, exePath) }, replaced: [], added: [] } };
    };`, context);
  const event = { sender: { send() {} } }, call = (name, ...args) => handlers.get(name)(event, ...args);
  assert.equal((await call('auto-plan', game, 'auto', exe)).recommendation.blocked, true);
  assert.equal((await call('set-api-override', game, exe, 'd3d11')).ok, true);
  assert.equal((await call('auto-detect', game, exe)).exe.apiLabel, 'DirectX 11');
  assert.equal((await call('auto-recommend', game, 'auto', exe)).recommendation.confidence, 'MEDIUM');
  const plan = await call('auto-plan', game, 'auto', exe);
  assert.equal(plan.recommendation.recommendedRoute, 'feeder');
  assert.equal(plan.preflight.ok, true);
  assert.equal((await call('auto-install', game, 'auto', exe)).ok, true);
  assert.equal(installRequests[0].apiChoice, 'd3d11');
  assert.equal(target.api, 'opengl', 'the upstream scan is never overwritten');

  // Verification follows the installed executable even when the scanner
  // prefers a different launcher, and consumes only post-install log bytes.
  installed = { route: 'feeder', game: { exe: target.rel } };
  scan.install = installed;
  const launcher = { ...target, path: path.join(game, 'Launcher.exe'), rel: 'Launcher.exe' };
  scan.exeCandidates.push(launcher); scan.chosen = launcher;
  fs.writeFileSync(path.join(path.dirname(exe), 'dlss5-feed.log'), '[feed] frame 1 delivered');
  fs.writeFileSync(path.join(path.dirname(exe), 'ReShade.log'), 'feature 18 created\nevaluation succeeded');
  const when = new Date(Date.now() + 1000);
  for (const name of ['dlss5-feed.log', 'ReShade.log']) fs.utimesSync(path.join(path.dirname(exe), name), when, when);
  assert.equal((await call('auto-verify', game)).verdict, 'SUCCESS');
  assert.equal((await call('auto-diagnose', game)).verdict, 'SUCCESS');
  installed = null;
  const restored = await call('auto-verify', game);
  assert.equal(restored.verdict, 'NOT_TESTED');
  assert.equal(restored.engaged, false, 'retained logs cannot verify an uninstalled configuration');
  assert.ok((await call('auto-diagnose', game)).findings.some(f => /当前安装记录/.test(f.what)));
});
