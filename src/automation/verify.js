'use strict';

// Starshine Auto - runtime verification, diagnosis and safe auto-repair.
//
// "File copied" is not "DLSS 5 working". After an install the state is
// WAITING_FOR_VERIFICATION; only real game logs - the ones each route's
// components actually write - move it forward. Nothing here guesses by
// launching the game or by trying DLLs in a loop.

const fs = require('fs');
const path = require('path');
const recovery = require('./recovery');
const { STATES, outcome } = require('./state');

const GAME_LOGS = ['dlss5-feed.log', 'ReShade.log', path.join('host64', 'dlss5-feed-host.log'), path.join('host64', 'ReShade.log'), 'dlss5-feed-crash.dmp.txt'];

// Markers that indicate the route actually engaged. Route-specific so a log
// from the wrong route is not counted as success.
const SUCCESS_MARKERS = {
  feeder: [/dlss5-feed/i, /host64/i, /loaded/i, /initialized/i, /started/i, /shader/i, /motion/i, /feedback/i],
  native: [/addon/i, /renodx/i, /loaded/i, /initialized/i, /dlss/i],
  renodx: [/addon/i, /renodx/i, /loaded/i, /initialized/i, /dlss/i],
  optiscaler: [/optiscaler/i, /loaded/i, /initialized/i, /dlss/i, /gfx/i]
};
const FAILURE_MARKERS = [
  /dll load error/i, /failed to load/i, /failed to initialize/i, /initialization failed/i,
  /exception/i, /fatal/i, /error/i, /unable to/i, /could not/i
];
// Lines that only look alarming but are routine. Ignored before failure
// detection so a healthy log is not misread.
const BENIGN_MARKERS = [/not found, skipping/i, /warning:/i, /no preset/i];

function logInfo(exeDir, name) {
  const file = path.join(exeDir, name);
  let stat = null;
  try { stat = fs.statSync(file); } catch { return null; }
  if (!stat.isFile()) return null;
  let head = '';
  try {
    const buf = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.toString('utf8').replace(/\u0000/g, '');
  } catch { head = ''; }
  return { name, path: file, size: stat.size, modifiedTime: stat.mtime.toISOString(), head };
}

function parseLogs(logs) {
  const findings = [];
  for (const log of logs) {
    if (!log) continue;
    const lines = log.head.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      if (BENIGN_MARKERS.some(re => re.test(line))) continue;
      if (FAILURE_MARKERS.some(re => re.test(line))) {
        findings.push({ severity: 'error', log: log.name, message: line.slice(0, 400) });
        continue;
      }
    }
  }
  return findings;
}

function routeEngaged(logs, route) {
  const markers = SUCCESS_MARKERS[route] || [];
  for (const log of logs) {
    if (!log || !log.head) continue;
    const lines = log.head.split(/\r?\n/);
    const hits = lines.filter(line => markers.some(re => re.test(line))).length;
    if (hits >= 2) return true;
  }
  return false;
}

// Verification is a read: logs, files, nothing written.
function verifyInstallation(gameDir, planData, deps = {}) {
  const exeDir = deps.exeDir || gameDir;
  const route = (planData && planData.recommendedRoute) || (deps.route) || null;
  const logs = GAME_LOGS.map(name => logInfo(exeDir, name)).filter(Boolean);
  const findings = parseLogs(logs);
  const engaged = route ? routeEngaged(logs, route) : false;
  const newest = logs.reduce((m, l) => (l.modifiedTime > m ? l.modifiedTime : m), '');
  const lastRun = newest ? new Date(newest).getTime() : null;
  const fresh = lastRun && (Date.now() - lastRun) < 60 * 60 * 1000;

  let verdict = 'NOT_TESTED';
  if (!logs.length) verdict = 'NOT_TESTED';
  else if (findings.length) verdict = 'FAILED';
  else if (engaged) verdict = 'SUCCESS';
  else if (fresh && !engaged) verdict = 'PARTIAL';
  else verdict = 'UNKNOWN';

  return {
    ok: verdict !== 'FAILED',
    verdict,
    state: verdict === 'SUCCESS' ? STATES.WORKING
      : verdict === 'PARTIAL' ? STATES.NEEDS_ATTENTION
        : verdict === 'FAILED' ? STATES.FAILED
          : verdict === 'NOT_TESTED' ? STATES.WAITING_FOR_VERIFICATION
            : STATES.NEEDS_ATTENTION,
    logs: logs.map(l => ({ name: l.name, size: l.size, modifiedTime: l.modifiedTime })),
    findings: findings.slice(0, 12),
    engaged: Boolean(engaged),
    fresh,
    route,
    gameDir
  };
}

// Turn the raw logs and detection facts into plain language. Each finding
// carries a repairId only when the fix is provably safe and reversible.
function diagnoseInstallation(gameDir, planData, deps = {}) {
  const verify = deps.verify || verifyInstallation(gameDir, planData, deps);
  const detection = deps.detection || null;
  const findings = [];
  const exeDir = deps.exeDir || gameDir;
  const api = detection && detection.exe ? detection.exe.api : null;
  const dgvoodoo = (detection && detection.mods || []).some(m => m.kind === 'dgvoodoo');
  const reshadeLog = logInfo(exeDir, 'ReShade.log');
  const feedLog = logInfo(exeDir, 'dlss5-feed.log');
  const route = verify.route || (planData && planData.recommendedRoute) || null;

  if (verify.verdict === 'NOT_TESTED') {
    findings.push({
      severity: 'info',
      what: 'No game logs yet.',
      why: 'The game has not been started since this install.',
      suggestion: '启动游戏后返回本页重新验证。',
      repairId: null
    });
  } else if (verify.verdict === 'SUCCESS') {
    findings.push({ severity: 'ok', what: `${route || 'Route'} engaged.`, why: 'Route logs show normal startup.', suggestion: null, repairId: null });
  } else if (verify.verdict === 'FAILED') {
    for (const f of verify.findings.slice(0, 3)) {
      findings.push({ severity: 'error', what: f.message, why: 'Found in ' + f.log, suggestion: null, repairId: null });
    }
    // ReShade not loading on a dgVoodoo title is the classic dxgi-vs-d3d11
    // mismatch. The fix is reversible: swap the proxy and reinstall through
    // the same transaction; failure rolls back.
    if (route && route !== 'optiscaler' && dgvoodoo && (api === 'd3d8' || api === 'd3d9' || api === 'ddraw')) {
      findings.push({
        severity: 'warn',
        what: '当前游戏通过 dgVoodoo 转换到 D3D11，但当前加载器使用 dxgi.dll。',
        why: 'ReShade/Feeder 需要通过游戏实际加载的代理文件注入。',
        suggestion: '切换到 d3d11.dll 并重新安装（自动）。',
        repairId: 'fix-reshade-proxy'
      });
    } else if (!reshadeLog && !feedLog) {
      findings.push({
        severity: 'warn',
        what: 'No ReShade or Feeder log was produced.',
        why: 'The game may be failing before the hook, or another loader is intercepting.',
        suggestion: '检查游戏是否被反作弊/其他加载器拦截；查看诊断导出。',
        repairId: null
      });
    }
  } else if (verify.verdict === 'PARTIAL') {
    findings.push({
      severity: 'warn',
      what: '部分组件已加载，但完整链路未确认。',
      why: '日志存在但关键标志缺失。',
      suggestion: '启动游戏并检查 DLSS 菜单/F8 Overlay；或导出诊断。',
      repairId: null
    });
  }

  const repair = findings.find(f => f.repairId) || null;
  return {
    ok: verify.verdict !== 'FAILED',
    verdict: verify.verdict,
    state: verify.state,
    likelyCause: repair ? repair.why : (verify.verdict === 'FAILED' ? '初始化或加载阶段出现错误。' : null),
    recommendedAction: repair ? repair.suggestion : null,
    repairId: repair ? repair.repairId : null,
    findings
  };
}

// Only reversible, low-risk, explicit repairs are automated. The current
// loader choice is a per-game preference and the reinstall runs inside the
// official transaction, so a failed switch restores the previous state.
async function safeAutoRepair(gameDir, repairId, options, deps = {}) {
  const userData = deps.userData;
  const send = deps.send || (() => {});
  if (!repairId) return outcome(false, STATES.NEEDS_ATTENTION, 'errNoRepair', { gameDir });
  if (repairId !== 'fix-reshade-proxy') {
    return outcome(false, STATES.NEEDS_ATTENTION, 'errUnsafeRepair', { gameDir, repairId });
  }
  const current = deps.loader || 'dxgi';
  const targetLoader = current === 'd3d11' ? 'dxgi' : 'd3d11';
  recovery.recordRepair(gameDir, { repairId, from: current, to: targetLoader, result: 'started' }, { userData });
  recovery.setVerifyState(gameDir, STATES.INSTALLING, {}, { userData });
  send({ code: 'autoRepairing', params: { repairId, from: current, to: targetLoader } });
  try {
    const result = await deps.install({
      gameDir,
      exePath: options.exePath,
      route: options.route,
      api: options.api || 'auto',
      reshadeProxy: targetLoader,
      antiCheatAcknowledged: false,
      installReShade: true,
      addMissingDlss: true,
      addStreamline: false,
      upgradeReShade: false
    });
    if (!result || !result.ok) {
      recovery.setVerifyState(gameDir, STATES.FAILED, {}, { userData });
      recovery.recordRepair(gameDir, { repairId, from: current, to: targetLoader, result: 'failed', error: result && result.code }, { userData });
      return outcome(false, STATES.FAILED, (result && result.code) || 'errRepairFailed', { gameDir });
    }
    recovery.setVerifyState(gameDir, STATES.WAITING_FOR_VERIFICATION, { loader: targetLoader }, { userData });
    recovery.recordRepair(gameDir, { repairId, from: current, to: targetLoader, result: 'success' }, { userData });
    return outcome(true, STATES.WAITING_FOR_VERIFICATION, 'autoRepaired', { loader: targetLoader, gameDir });
  } catch (error) {
    recovery.setVerifyState(gameDir, STATES.FAILED, {}, { userData });
    recovery.recordRepair(gameDir, { repairId, from: current, to: targetLoader, result: 'failed', error: error.code || error.message }, { userData });
    return outcome(false, STATES.FAILED, error.code || 'errRepairFailed', { message: error.message, gameDir });
  }
}

module.exports = { verifyInstallation, diagnoseInstallation, safeAutoRepair, parseLogs, GAME_LOGS, SUCCESS_MARKERS, FAILURE_MARKERS, logInfo };
