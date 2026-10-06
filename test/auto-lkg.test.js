'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const recovery = require('../src/automation/recovery');
const verify = require('../src/automation/verify');

function fixture(t, withLkg = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-lkg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const gameDir = path.join(root, 'game');
  fs.mkdirSync(gameDir);
  const deps = { userData: path.join(root, 'data') };
  const a = { route: 'native', loader: 'dxgi', verifiedAt: '2026-01-01T00:00:00.000Z', config: { name: 'A' } };
  recovery.patchGameState(gameDir, { lastKnownGood: withLkg ? a : null }, deps);
  recovery.beginInstall(gameDir, { recommendedRoute: 'feeder' }, deps);
  recovery.completeInstall(gameDir, { recommendedRoute: 'feeder', components: [] }, null,
    { ...deps, config: { name: 'B' } });
  return { gameDir, deps, a, state: () => recovery.readGameState(gameDir, deps) };
}

test('install B preserves verified A and records pending B', t => {
  const { state, a } = fixture(t);
  assert.deepEqual(state().lastKnownGood, a);
  assert.equal(state().pendingCandidate.config.name, 'B');
  assert.equal(state().pendingCandidate.verifiedAt, null);
});

test('SUCCESS promotes B, stamps verifiedAt and clears candidate', t => {
  const { gameDir, deps, state } = fixture(t);
  recovery.recordVerification(gameDir, { verdict: 'SUCCESS', route: 'feeder', state: 'working' }, deps);
  assert.equal(state().lastKnownGood.config.name, 'B');
  assert.ok(Number.isFinite(Date.parse(state().lastKnownGood.verifiedAt)));
  assert.equal(state().pendingCandidate, null);
});

for (const verdict of ['FAILED', 'PARTIAL', 'UNKNOWN', 'NOT_TESTED']) {
  test(`${verdict} never replaces verified A`, t => {
    const { gameDir, deps, state, a } = fixture(t);
    recovery.recordVerification(gameDir, { verdict, route: 'feeder', state: 'needs_attention' }, deps);
    assert.deepEqual(state().lastKnownGood, a);
    assert.equal(state().pendingCandidate.config.name, 'B');
  });
}

test('first install has no LKG until SUCCESS', t => {
  const { gameDir, deps, state } = fixture(t, false);
  assert.equal(state().lastKnownGood, null);
  recovery.recordVerification(gameDir, { verdict: 'NOT_TESTED', route: 'feeder', state: 'waiting_for_verification' }, deps);
  assert.equal(state().lastKnownGood, null);
  recovery.recordVerification(gameDir, { verdict: 'SUCCESS', route: 'feeder', state: 'working' }, deps);
  assert.equal(state().lastKnownGood.route, 'feeder');
  assert.ok(state().lastKnownGood.verifiedAt);
});

test('legacy unverified LKG migrates without losing history and cannot restore', async t => {
  const { gameDir, deps } = fixture(t, false);
  const legacy = { route: 'feeder', loader: 'dxgi', verifiedAt: null, config: { legacy: true } };
  recovery.writeStore(deps.userData, { version: 1, games: { [recovery.key(gameDir)]: {
    gameDir, lastKnownGood: legacy, installHistory: [{ at: '2026-01-01T00:00:00.000Z' }]
  } } });
  let called = false;
  const result = await recovery.restoreLastKnownGood(gameDir, {}, { ...deps,
    restore: async () => { called = true; }, installFlow: async () => { called = true; } });
  assert.equal(result.code, 'errNoLastKnownGood');
  assert.equal(called, false);
  const migrated = recovery.readGameState(gameDir, deps);
  assert.equal(migrated.lastKnownGood, null);
  assert.deepEqual(migrated.pendingCandidate.config, legacy.config);
  assert.equal(migrated.installHistory.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(deps.userData, 'automation.json'))).version, 1);
});

test('legacy migration preserves both an existing candidate and unverified LKG', t => {
  const { gameDir, deps, state } = fixture(t);
  const candidate = state().pendingCandidate;
  recovery.patchGameState(gameDir, { lastKnownGood: { route: 'native', verifiedAt: null } }, deps);
  assert.deepEqual(state().pendingCandidate, candidate);
  assert.equal(state().legacyUnverifiedLastKnownGood.route, 'native');
});

test('a rollback invalidates B and prevents later SUCCESS from promoting it', async t => {
  const { gameDir, deps, state, a } = fixture(t);
  await recovery.rollbackInstall(gameDir, { ...deps, restore: async () => true });
  recovery.recordVerification(gameDir, { verdict: 'SUCCESS', route: 'feeder', state: 'working' }, deps);
  assert.deepEqual(state().lastKnownGood, a);
  assert.equal(state().pendingCandidate, null);
});

test('old game logs cannot verify a newly installed candidate', t => {
  const { gameDir, deps, state, a } = fixture(t);
  const log = path.join(gameDir, 'dlss5-feed.log');
  fs.writeFileSync(log, 'dlss5-feed host64 started\nshader loaded');
  const old = new Date('2026-01-01T00:00:00.000Z');
  fs.utimesSync(log, old, old);
  const result = verify.verifyInstallation(gameDir, { recommendedRoute: 'feeder' }, {
    installedAt: state().pendingCandidate.installedAt
  });
  assert.equal(result.verdict, 'NOT_TESTED');
  recovery.recordVerification(gameDir, result, deps);
  assert.deepEqual(state().lastKnownGood, a);
});

test('new-session neural execution logs verify and promote the candidate', t => {
  const { gameDir, deps, state } = fixture(t);
  const log = path.join(gameDir, 'dlss5-feed.log');
  fs.writeFileSync(log, '[feed] frame 1 delivered (1920x1080, reset=0)');
  const neuralLog = path.join(gameDir, 'ReShade.log');
  fs.writeFileSync(neuralLog, 'feature 18 created\nevaluation succeeded');
  const afterInstall = new Date(Date.parse(state().pendingCandidate.installedAt) + 1000);
  fs.utimesSync(log, afterInstall, afterInstall);
  fs.utimesSync(neuralLog, afterInstall, afterInstall);
  const result = verify.verifyInstallation(gameDir, { recommendedRoute: 'feeder' }, {
    installedAt: state().pendingCandidate.installedAt,
    logSnapshot: state().pendingCandidate.logSnapshot
  });
  assert.equal(result.verdict, 'SUCCESS');
  recovery.recordVerification(gameDir, result, deps);
  assert.ok(state().lastKnownGood.verifiedAt);
  assert.equal(state().pendingCandidate, null);
});

test('a different route cannot promote B', t => {
  const { gameDir, deps, state, a } = fixture(t);
  recovery.recordVerification(gameDir, { verdict: 'SUCCESS', route: 'native', state: 'working' }, deps);
  assert.deepEqual(state().lastKnownGood, a);
});

test('verification after promotion updates failure state without erasing the historical LKG', t => {
  const { gameDir, deps, state } = fixture(t);
  recovery.recordVerification(gameDir, { verdict: 'SUCCESS', route: 'feeder', state: 'working' }, deps);
  const lkg = state().lastKnownGood;
  recovery.recordVerification(gameDir, { verdict: 'FAILED', route: 'feeder', state: 'failed' }, deps);
  assert.equal(state().verifyState, 'failed');
  assert.equal(state().lastVerification.verdict, 'FAILED');
  assert.deepEqual(state().lastKnownGood, lkg);
});

test('an older candidate establishes a baseline, then verifies only a new session', t => {
  const { gameDir, deps, state } = fixture(t);
  const candidate = { ...state().pendingCandidate }; delete candidate.logSnapshot;
  recovery.patchGameState(gameDir, { pendingCandidate: candidate }, deps);
  fs.writeFileSync(path.join(gameDir, 'dlss5-feed.log'), '[feed] frame 1 delivered\n');
  fs.writeFileSync(path.join(gameDir, 'ReShade.log'), 'feature 18 created\nevaluation succeeded\n');
  const afterInstall = new Date(Date.parse(candidate.installedAt) + 1000);
  for (const name of ['dlss5-feed.log', 'ReShade.log']) fs.utimesSync(path.join(gameDir, name), afterInstall, afterInstall);
  let result = verify.verifyInstallation(gameDir, { recommendedRoute: 'feeder' }, { installedAt: candidate.installedAt });
  assert.equal(result.verdict, 'PARTIAL');
  recovery.recordVerification(gameDir, result, deps);
  assert.ok(state().pendingCandidate.logSnapshot);
  assert.notEqual(state().lastKnownGood?.route, 'feeder');
  fs.appendFileSync(path.join(gameDir, 'dlss5-feed.log'), '[feed] frame 2 delivered\n');
  fs.appendFileSync(path.join(gameDir, 'ReShade.log'), 'feature 18 created\nevaluation succeeded\n');
  for (const name of ['dlss5-feed.log', 'ReShade.log']) fs.utimesSync(path.join(gameDir, name), afterInstall, afterInstall);
  result = verify.verifyInstallation(gameDir, { recommendedRoute: 'feeder' }, state().pendingCandidate);
  assert.equal(result.verdict, 'SUCCESS');
});
