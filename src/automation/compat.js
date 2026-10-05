'use strict';

// Starshine Auto - compatibility model and recommendation engine.
//
// The recommendation is deterministic, repeatable and explainable. Every
// route comes with the reasons that led to it and the warnings that apply,
// built from detection facts - never from a remote guess. The engine only
// picks among the routes the official installer already implements; it never
// reimplements them.

const installRoutes = require('../shared/install-routes');

const CONFIDENCE = Object.freeze({ HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', UNKNOWN: 'UNKNOWN' });

// Conservative multipass guidance. There is no in-app evidence that raising
// the pass count improves these routes, so automatic modes never raise it;
// only the experimental mode suggests higher values, clearly labelled.
const MULTIPASS_BY_MODE = Object.freeze({ stable: 1, quality: 1, performance: 1, experimental: 3, auto: 1 });

// Confidence can only degrade, never climb: UNKNOWN < LOW < MEDIUM < HIGH.
const LEVELS = { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
function demote(confidence, level) {
  return LEVELS[confidence] > LEVELS[level] ? level : confidence;
}

// Drivers below 616.56 cannot be proven safe for the neural pass. It is a
// warning, not a hard block - the official OptiScaler path already runs on
// older drivers because the model ships with the app.
const MIN_DRIVER = 61656;

function apiLabel(detection) {
  return detection.exe ? detection.exe.apiLabel : null;
}

// The route set the official installer offers for this target.
function officialRoutes(detection) {
  const exe = detection.exe;
  if (!exe) return [];
  return installRoutes.routesFor({
    ...exe,
    hasNativeDlss: installRoutes.nativeDlssPresent(detection.scan || {}),
    emulator: exe.emulator
  }, exe.api);
}

function hasNativeDlss(detection) {
  return installRoutes.nativeDlssPresent(detection.scan || {});
}

function conflicts(detection) {
  return (detection.existingDlls || []).filter(d => d.conflict && d.kind !== 'managed');
}

function reshadePresent(detection) {
  return Boolean(detection.reshade && detection.reshade.installed);
}

// Build the CompatibilityResult for one game + mode.
function buildRecommendation(detection, mode, deps = {}) {
  const exe = detection.exe;
  const reasons = [];
  const warnings = [];
  const fallbackRoutes = [];
  const optionalRoutes = [];
  let confidence = CONFIDENCE.HIGH;
  let recommendedRoute = null;
  let blocked = false;
  let blockReason = null;
  let multipass = MULTIPASS_BY_MODE[mode] || 1;

  if (!exe) {
    return {
      api: null, gpu: detection.gpu && detection.gpu.primary ? detection.gpu.primary.name : null,
      driverVersion: detection.gpu ? detection.gpu.driver : null,
      mode, recommendedRoute: null, fallbackRoutes, optionalRoutes,
      confidence: CONFIDENCE.UNKNOWN,
      warnings: ['未在此文件夹中检测到游戏可执行文件。'],
      reasons: [], conflicts: [], antiCheat: detection.antiCheat,
      blocked: true, blockReason: 'no-exe', multipass: 1, experimental: mode === 'experimental'
    };
  }

  // --- GPU gate: the smart path is NVIDIA RTX first. ---
  const gpu = detection.gpu || {};
  const primary = gpu.primary;
  if (!gpu.available) {
    confidence = CONFIDENCE.LOW;
    warnings.push('未检测到 NVIDIA GPU（nvidia-smi 不可用）；智能安装不会自动运行。');
  } else if (!gpu.isNvidia) {
    blocked = true;
    blockReason = 'non-nvidia';
    confidence = CONFIDENCE.LOW;
    reasons.push(`GPU: ${primary.name}（非 NVIDIA）`);
    warnings.push('当前智能安装主要面向 NVIDIA RTX GPU。');
  } else if (!gpu.isRtx) {
    confidence = CONFIDENCE.LOW;
    reasons.push(`GPU: ${primary.name}（NVIDIA，非 RTX）`);
    warnings.push('当前智能安装主要面向 NVIDIA RTX GPU。旧架构运行神经网络需要自行提供 modded nvngx_dlssnr.dll。');
  } else {
    reasons.push(`GPU: ${primary.name}（RTX）`);
    if (gpu.isBlackwell) reasons.push('RTX Blackwell GPU — 官方神经网络运行时支持');
    else {
      confidence = demote(confidence, CONFIDENCE.LOW);
      warnings.push('非 Blackwell 显卡运行神经网络需要自行提供 modded nvngx_dlssnr.dll。');
    }
  }

  // --- Driver ---
  const driver = gpu.driverNumber;
  if (gpu.available && gpu.isNvidia && driver != null) {
    reasons.push(`驱动: ${gpu.driver}`);
    if (driver < MIN_DRIVER) {
      warnings.push(`NVIDIA 驱动 ${gpu.driver} 低于神经网络渲染推荐的 616.56。`);
      confidence = demote(confidence, CONFIDENCE.LOW);
    }
  }

  // --- API ---
  if (detection.apiConfidence === 'UNKNOWN') {
    blocked = true;
    blockReason = 'unknown-api';
    confidence = CONFIDENCE.UNKNOWN;
    warnings.push('无法确定游戏的渲染 API。智能安装已停止；请在高级设置中手动选择 API。');
  } else {
    reasons.push(`API: ${exe.apiLabel}（${exe.via || '检测'}）`);
  }

  // --- Anti-cheat / competitive ---
  if (detection.antiCheat && detection.antiCheat.blocked) {
    blocked = true;
    blockReason = 'anti-cheat';
    confidence = CONFIDENCE.LOW;
    warnings.push('检测到反作弊系统。修改游戏 DLL 可能导致游戏无法启动或账号风险，智能安装已停止。');
  }

  // --- Mod manager ---
  if (detection.managedModRoot) {
    blocked = true;
    blockReason = 'managed-modpack';
    confidence = CONFIDENCE.LOW;
    warnings.push('检测到 Mod Organizer Stock Game / Root Builder 安装；已阻止直接注入。');
  }

  // --- Existing proxy DLL conflicts ---
  const conflictList = conflicts(detection);
  if (conflictList.length) {
    const unknown = conflictList.filter(c => c.kind === 'unknown');
    if (unknown.length) {
      blocked = true;
      blockReason = 'unknown-dll';
      confidence = CONFIDENCE.UNKNOWN;
      warnings.push(`存在未知代理 DLL：${unknown.map(c => c.name).join(', ')}。智能安装已停止；请在高级设置中检查该文件。`);
    } else {
      warnings.push(`检测到冲突的 Mod：${conflictList.map(c => `${c.name} (${c.kind})`).join(', ')}。它们不会被覆盖。`);
      confidence = demote(confidence, CONFIDENCE.MEDIUM);
    }
  }

  if (blocked) {
    return {
      api: exe.api, gpu: primary ? primary.name : null, driverVersion: gpu.driver || null,
      mode, recommendedRoute: null, fallbackRoutes, optionalRoutes,
      confidence, warnings, reasons,
      conflicts: conflictList, antiCheat: detection.antiCheat,
      blocked, blockReason, multipass, experimental: mode === 'experimental'
    };
  }

  // --- Route selection ---
  const routes = officialRoutes(detection);
  if (!routes.length) {
    confidence = CONFIDENCE.LOW;
    warnings.push(`${exe.apiLabel} 没有支持的安装路线。`);
    return {
      api: exe.api, gpu: primary ? primary.name : null, driverVersion: gpu.driver || null,
      mode, recommendedRoute: null, fallbackRoutes, optionalRoutes,
      confidence, warnings, reasons, conflicts: conflictList,
      antiCheat: detection.antiCheat, blocked: false, blockReason: null,
      multipass, experimental: mode === 'experimental'
    };
  }

  const native = hasNativeDlss(detection);
  // The official router decides native vs feeder from the real scan (an
  // installed Feeder route stays Feeder; no native DLSS means Feeder). The
  // smart modes then refine that base route.
  const officialRecommended = installRoutes.recommendedRoute(detection.scan || {}, {
    ...exe, hasNativeDlss: native, emulator: exe.emulator
  });
  const reshade = reshadePresent(detection);
  if (reshade) reasons.push('已有 ReShade — 兼容时复用现有加载器');

  const optiPossible = routes.includes('optiscaler') && gpu.isBlackwell && driver != null && driver >= MIN_DRIVER;
  const presrPossible = optiPossible && (mode === 'quality' || mode === 'experimental');

  switch (mode) {
    case 'stable':
      recommendedRoute = officialRecommended === 'renodx' ? 'renodx' : officialRecommended;
      if (officialRecommended === 'renodx') warnings.push('已选择原生 RenoDX 路线（稳定）。Multipass 保持保守默认。');
      break;
    case 'quality':
      // Native DLSS output is the highest-fidelity path where it exists;
      // otherwise the Feeder route carries the same consumer. OptiScaler's
      // pre-SR build is offered (not forced) on capable hardware.
      recommendedRoute = routes.includes('native') && native ? 'native' : (routes.includes('renodx') ? 'renodx' : routes[0]);
      if (presrPossible) {
        optionalRoutes.push('optiscaler-presr');
        warnings.push('OptiScaler pre-SR 多遍渲染可作为可选画质路线；未经确认不会自动安装。');
      }
      break;
    case 'performance':
      recommendedRoute = native && routes.includes('native') ? 'native' : (routes.includes('feeder') ? 'feeder' : routes[0]);
      break;
    case 'experimental':
      recommendedRoute = routes.includes('native') && native ? 'native' : routes[0];
      if (recommendedRoute === 'renodx' || routes.includes('renodx')) {
        multipass = MULTIPASS_BY_MODE.experimental;
        warnings.push('实验功能可能导致：游戏崩溃、黑屏、画面异常、性能下降、Overlay 不工作、DLL 冲突。');
      }
      if (presrPossible) optionalRoutes.push('optiscaler-presr');
      break;
    default: // auto
      recommendedRoute = officialRecommended;
      break;
  }

  fallbackRoutes.push(...routes.filter(r => r !== recommendedRoute));

  if (!conflictList.length) reasons.push('未检测到高风险 DLL 冲突');

  return {
    api: exe.api,
    gpu: primary ? primary.name : null,
    driverVersion: gpu.driver || null,
    mode,
    recommendedRoute,
    fallbackRoutes,
    optionalRoutes,
    confidence,
    warnings,
    reasons,
    conflicts: conflictList,
    antiCheat: detection.antiCheat,
    blocked: false,
    blockReason: null,
    multipass,
    experimental: mode === 'experimental'
  };
}

module.exports = { buildRecommendation, CONFIDENCE, MULTIPASS_BY_MODE, MIN_DRIVER };
