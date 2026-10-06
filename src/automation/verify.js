'use strict';

// Starshine Auto - runtime verification, diagnosis and safe auto-repair.
//
// "File copied" is not "DLSS 5 working". After an install the state is
// WAITING_FOR_VERIFICATION; only real game logs - the ones each route's
// components actually write - move it forward. Nothing here guesses by
// launching the game or by trying DLLs in a loop.

const path = require('path');
const recovery = require('./recovery');
const { STATES, outcome } = require('./state');
const { GAME_LOGS, logInfo } = require('./runtime-logs');

// Markers that indicate the route actually engaged. Route-specific so a log
// from the wrong route is not counted as success.
const SUCCESS_MARKERS = {
  native: [/renodx[- ._]?dlss5/i, /RenoDX.*DLSS\s*5/i],
  renodx: [/renodx[- ._]?dlss(?:\.addon64|\s+tool)/i, /DLSS Tool/i],
  optiscaler: [/OptiScaler/i]
};
const FAILURE_MARKERS = [
  /dll load error/i, /failed to load/i, /failed to initialize/i, /initialization failed/i,
  /\bexception\b/i, /\bfatal\b/i, /\berror\b/i, /unable to/i, /could not/i,
  /\bevaluate failed\b/i, /feature\s*18.*failed/i, /failed to create feature\s*18/i,
  /0xBAD[0-9a-f]+/i, /neural consumer outcome: consumer did not intercept/i,
  /neural pass is OFF|NEURAL RENDERING WILL DO NOTHING/i
];
const BENIGN_MARKERS = [/not found, skipping/i, /no preset/i, /\bno errors?\b/i, /\b0 errors?\b/i];

function failedLine(line) {
  if (!FAILURE_MARKERS.some(re => re.test(line))) return false;
  // Optional assets may be absent; an explicit load/initialization failure is
  // still a failure even when a logger prefixes it with "Warning:".
  if (BENIGN_MARKERS.some(re => re.test(line)) &&
      !/failed|fatal|exception|dll load error|0xBAD/i.test(line)) return false;
  return true;
}

function parseLogs(logs) {
  const findings = [];
  for (const log of logs) {
    if (!log) continue;
    const lines = log.head.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      if (failedLine(line)) {
        findings.push({ severity: 'error', log: log.name, message: line.slice(0, 400) });
        continue;
      }
    }
  }
  return findings;
}

function evidenceLines(log) {
  return (log?.head || '').split(/\r?\n/).filter(line =>
    !failedLine(line) && !/\b(?:not|no|never|disabled|passthrough)\b|check.*log|read.*log|\b(?:if|when)\b.*(?:created|evaluat)/i.test(line));
}

// The pinned Feeder 1.17.0 host uses these same feature-18/evaluation markers
// in LogNeuralConsumerOutcome. Feature 1/DLAA, a loaded add-on and transported
// frames alone do not prove neural rendering.
function neuralEvidence(log) {
  const lines = evidenceLines(log);
  if (lines.some(line => /neural consumer outcome: neural feature active \(feature 18 created and evaluated\)/i.test(line))) return true;
  const created = lines.some(line => /feature\s*18.*\bcreated\b|\bDLSSD\b.*\bcreated\b/i.test(line));
  const evaluated = lines.some(line => /evaluation succeeded|feature\s*18 evaluated|DLSSD evaluate succeeded/i.test(line));
  return created && evaluated;
}

function routeEngaged(logs, route) {
  const byName = new Map(logs.map(log => [log.name, log]));
  if (route === 'feeder') {
    const feed = byName.get('dlss5-feed.log');
    const host = byName.get(path.join('host64', 'dlss5-feed-host.log'));
    const delivered = evidenceLines(feed).some(line => /\[feed\].*frame\s+[1-9]\d* delivered/i.test(line));
    const evaluated = evidenceLines(host).some(line => /\[host\].*frame\s+[1-9]\d* evaluated/i.test(line));
    return (delivered && neuralEvidence(byName.get('ReShade.log'))) ||
      (evaluated && (neuralEvidence(host) || neuralEvidence(byName.get(path.join('host64', 'ReShade.log')))));
  }
  const markers = SUCCESS_MARKERS[route] || [];
  return logs.some(log => !log.name.startsWith('host64' + path.sep) &&
    evidenceLines(log).some(line => markers.some(re => re.test(line))) && neuralEvidence(log));
}

// Verification is a read: logs, files, nothing written.
function verifyInstallation(gameDir, planData, deps = {}) {
  const exeDir = deps.exeDir || gameDir;
  const route = (planData && planData.recommendedRoute) || (deps.route) || null;
  // Old logs from configuration A cannot verify newly installed B.
  const installedAt = deps.installedAt ? Date.parse(deps.installedAt) : null;
  const logs = GAME_LOGS.map(name => logInfo(exeDir, name, deps.logSnapshot?.[name])).filter(Boolean)
    .filter(log => log.readError || !installedAt || Date.parse(log.modifiedTime) > installedAt);
  const findings = parseLogs(logs);
  const sessionProven = !installedAt || GAME_LOGS.every(name =>
    Object.prototype.hasOwnProperty.call(deps.logSnapshot || {}, name));
  const complete = sessionProven && !logs.some(log => log.readError || log.truncated);
  for (const log of logs) {
    if (log.readError || log.truncated) findings.push({ severity: 'warn', log: log.name,
      message: log.readError ? '日志无法完整读取，不能确认运行成功。' : '日志超过读取上限，不能确认完整链路。' });
  }
  if (logs.length && !sessionProven) findings.push({ severity: 'warn', log: 'session',
    message: '旧安装记录缺少日志基线，本次检查不能确认成功；重新启动游戏后再验证。' });
  const engaged = complete && route ? routeEngaged(logs, route) : false;
  if (logs.length && complete && !engaged && !findings.some(f => f.severity === 'error')) {
    findings.push({ severity: 'warn', log: 'route', message: '日志存在，但缺少当前路线的神经渲染执行证据。' });
  }
  const newest = logs.reduce((m, l) => (l.modifiedTime > m ? l.modifiedTime : m), '');
  const lastRun = newest ? new Date(newest).getTime() : null;
  const fresh = lastRun && (Date.now() - lastRun) < 60 * 60 * 1000;

  let verdict = 'NOT_TESTED';
  if (!logs.length) verdict = 'NOT_TESTED';
  else if (findings.some(f => f.severity === 'error')) verdict = 'FAILED';
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
    logs: logs.map(l => ({ name: l.name, size: l.size, modifiedTime: l.modifiedTime,
      truncated: l.truncated, readError: Boolean(l.readError) })),
    findings: findings.slice(0, 12),
    engaged: Boolean(engaged),
    fresh,
    route,
    evidenceComplete: complete,
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
  const dgvoodoo = [...(detection?.mods || []), ...(detection?.existingDlls || [])].some(m => m.kind === 'dgvoodoo');
  const reshadeLog = logInfo(exeDir, 'ReShade.log');
  const feedLog = logInfo(exeDir, 'dlss5-feed.log');
  const route = verify.route || (planData && planData.recommendedRoute) || null;

  if (verify.verdict === 'NOT_TESTED') {
    if (verify.findings?.length) findings.push(...verify.findings.map(f => ({
      severity: f.severity, what: f.message, why: null, suggestion: '检查当前安装状态后再验证。', repairId: null
    })));
    else findings.push({
      severity: 'info',
      what: '尚无游戏日志。',
      why: '安装后游戏尚未启动过。',
      suggestion: '启动游戏后返回本页重新验证。',
      repairId: null
    });
  } else if (verify.verdict === 'SUCCESS') {
    findings.push({ severity: 'ok', what: `${route || '路线'} 已生效。`, why: '路线日志显示正常启动。', suggestion: null, repairId: null });
  } else if (verify.verdict === 'FAILED') {
    for (const f of verify.findings.slice(0, 3)) {
      findings.push({ severity: 'error', what: f.message, why: '发现于 ' + f.log, suggestion: null, repairId: null });
    }
    // ReShade not loading on a dgVoodoo title is the classic dxgi-vs-d3d11
    // mismatch. The fix is reversible: swap the proxy and reinstall through
    // the same transaction; failure rolls back.
    const loaderFailure = verify.findings.some(f => /dll load error|failed to load.*(?:dxgi|d3d11|reshade)/i.test(f.message));
    if (route && route !== 'optiscaler' && dgvoodoo && deps.loader !== 'd3d11' && loaderFailure &&
        (api === 'd3d8' || api === 'd3d9' || api === 'ddraw')) {
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
        what: '未生成 ReShade 或 Feeder 日志。',
        why: '游戏可能在挂钩之前就失败了，或另一个加载器正在拦截。',
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
  recovery.setVerifyState(gameDir, STATES.INSTALLING, { pendingCandidate: null }, { userData });
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
    recovery.completeInstall(gameDir, { recommendedRoute: options.route, components: [] }, result.manifest,
      { userData, loader: targetLoader, dllHashes: result.dllHashes || {}, exePath: options.exePath });
    recovery.recordRepair(gameDir, { repairId, from: current, to: targetLoader, result: 'success' }, { userData });
    return outcome(true, STATES.WAITING_FOR_VERIFICATION, 'autoRepaired', { loader: targetLoader, gameDir });
  } catch (error) {
    recovery.setVerifyState(gameDir, STATES.FAILED, {}, { userData });
    recovery.recordRepair(gameDir, { repairId, from: current, to: targetLoader, result: 'failed', error: error.code || error.message }, { userData });
    return outcome(false, STATES.FAILED, error.code || 'errRepairFailed', { message: error.message, gameDir });
  }
}

module.exports = { verifyInstallation, diagnoseInstallation, safeAutoRepair, parseLogs, GAME_LOGS, SUCCESS_MARKERS, FAILURE_MARKERS, logInfo };
