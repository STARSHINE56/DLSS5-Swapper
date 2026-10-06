'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function ui(lab) {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  const nodes = { smartCard: {}, smartBody: { innerHTML: '' }, smartMode: { value: 'auto' }, smartNotes: { innerHTML: '' } };
  const context = vm.createContext({ $: id => nodes[id] || null, t: key => key, esc: String,
    window: { lab }, jobRunning: false, sheetDetails: null, jobLines: [], jobLog() {} });
  vm.runInContext(source.slice(source.indexOf('function smartStateText('), source.indexOf('async function openSheet(')), context);
  return { nodes, run: expression => vm.runInContext(expression, context) };
}
const plan = route => ({ recommendation: { recommendedRoute: route, confidence: 'HIGH' }, plan: { risk: 'low' } });

test('a delayed older mode cannot overwrite the current detection result', async () => {
  let finish;
  const { nodes, run } = ui({ autoPlan: (_, mode) => mode === 'auto' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(plan('NEW_QUALITY')), autoState: async () => null });
  const older = run('loadSmartCard("/game", null)');
  nodes.smartMode.value = 'quality';
  await run('loadSmartCard("/game", null)');
  finish(plan('OLD_AUTO')); await older;
  assert.match(nodes.smartBody.innerHTML, /NEW_QUALITY/);
  assert.doesNotMatch(nodes.smartBody.innerHTML, /OLD_AUTO/);
});

test('a result from a closed game sheet cannot paint a newly opened sheet', async () => {
  let finish;
  const { nodes, run } = ui({ autoPlan: () => new Promise(resolve => { finish = resolve; }), autoState: async () => null });
  const pending = run('loadSmartCard("/old-game", null)');
  nodes.smartBody = { innerHTML: 'new game' };
  finish(plan('OLD_GAME')); await pending;
  assert.equal(nodes.smartBody.innerHTML, 'new game');
});

test('failed verification displays the actual failure without invented confidence or risk', async () => {
  const { nodes, run } = ui({ autoVerify: async () => ({ verdict: 'FAILED', state: 'failed', findings: [{ log: 'ReShade.log', message: 'failed to initialize DLSS' }] }) });
  await run('runSmartAction("verify", "/game")');
  assert.match(nodes.smartBody.innerHTML, /smartFailed/);
  assert.match(nodes.smartBody.innerHTML, /failed to initialize DLSS/);
  assert.doesNotMatch(nodes.smartBody.innerHTML, /smartConfidenceHigh|smartRiskLow/);
  run('renderSmartBody({recommendation:{blocked:true},state:{verifyState:"failed",route:"native"}},"/game")');
  assert.match(nodes.smartNotes.innerHTML, /smartFailed/);
  assert.doesNotMatch(nodes.smartNotes.innerHTML, /smartReady/);
});
