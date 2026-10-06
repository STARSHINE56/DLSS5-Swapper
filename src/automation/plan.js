'use strict';

// Starshine Auto - preflight check and install plan.
//
// A plan is produced before anything is written, and a preflight failure with
// a `fail` status stops the automatic install outright. Warnings pass through
// to the user's confirmation instead of silently installing.

const path = require('path');
const fs = require('fs');
const apply = require('../core/apply');
const feederRelease = require('../core/feeder-release');
const renodx = require('../core/renodx-release');
const optiscaler = require('../core/optiscaler');
const journal = require('../core/file-journal');

const COMPONENT_SOURCES = Object.freeze({
  'DLSS5-Feeder': { url: feederRelease.archive[1], sha256: feederRelease.archive[2], version: feederRelease.version },
  'RenoDX DLSS5 consumer': { url: renodx.CONSUMER.archive[1], sha256: renodx.CONSUMER.archive[2], version: renodx.CONSUMER.version },
  'RenoDX DLSS Tool (multipass)': { url: renodx.MULTIPASS.archive[1], sha256: renodx.MULTIPASS.archive[2], version: renodx.MULTIPASS.version },
  'OptiScaler DLSS-NR': { url: optiscaler.RELEASE.url, sha256: optiscaler.RELEASE.sha256, version: optiscaler.RELEASE.version }
});

function fail(status, name, message) {
  return { name, status, message };
}

// `deps.payload` describes what the running app actually carries (from
// main.js payload()). A missing payload is a fail: no download exists for it.
function preflightCheck(detection, recommendation, deps = {}) {
  const checks = [];
  const errors = [];
  const warnings = [];

  // GPU - judged from detection, never from a recommendation the caller may
  // have hand-built.
  const gpu = detection.gpu || {};
  if (detection.multiGpu) {
    checks.push(fail('warn', 'multi-gpu', '检测到多张显卡；不能从列表顺序确认游戏使用的 GPU。'));
    warnings.push('multi-gpu');
  }
  if (!gpu.available) {
    checks.push(fail('fail', 'gpu', '未检测到 NVIDIA GPU（nvidia-smi 不可用）。'));
    errors.push('gpu');
  } else if (!gpu.isNvidia) {
    checks.push(fail('fail', 'gpu', '当前智能安装主要面向 NVIDIA RTX GPU。'));
    errors.push('gpu');
  } else if (!gpu.isRtx) {
    checks.push(fail('warn', 'gpu', 'NVIDIA GPU 非 RTX 显卡；神经网络渲染可能需要自行提供 modded 模型。'));
    warnings.push('gpu');
  } else if (gpu.driverNumber != null && gpu.driverNumber < 61656) {
    checks.push(fail('warn', 'driver', `NVIDIA 驱动 ${gpu.driver} 低于 616.56；神经网络渲染可能无法初始化。`));
    warnings.push('driver');
  } else if (gpu.driverNumber == null) {
    checks.push(fail('warn', 'driver', '驱动版本未知，不能确认驱动兼容性。'));
    warnings.push('driver');
  } else {
    checks.push(fail('pass', 'gpu', gpu.primary ? `${gpu.primary.name} — ${gpu.driver}` : 'GPU 正常'));
  }

  // API
  if (!detection.exe) {
    checks.push(fail('fail', 'api', '未检测到游戏可执行文件。'));
    errors.push('api');
  } else if (detection.apiConfidence === 'UNKNOWN') {
    checks.push(fail('fail', 'api', '渲染 API 未知；请在高级设置中手动选择。'));
    errors.push('api');
  } else {
    const status = detection.apiConfidence === 'HIGH' ? 'pass' : 'warn';
    checks.push(fail(status, 'api', `${detection.exe.apiLabel}（${detection.exe.via || '检测'}）`));
    if (status === 'warn') warnings.push('api');
  }

  // Anti-cheat
  if (detection.antiCheat && detection.antiCheat.blocked) {
    checks.push(fail('fail', 'anti-cheat', '检测到反作弊系统；智能 DLL 注入已停止。'));
    errors.push('anti-cheat');
  } else {
    checks.push(fail('pass', 'anti-cheat', '未检测到反作弊系统。'));
  }

  // Mod manager
  if (detection.managedModRoot) {
    checks.push(fail('fail', 'mod-manager', '检测到 Mod Organizer Stock Game / Root Builder。'));
    errors.push('mod-manager');
  } else {
    checks.push(fail('pass', 'mod-manager', '未检测到受管理的 Mod 整合根目录。'));
  }

  // Write access - detection carries the measured answer; an explicit probe
  // wins when the caller supplies one.
  const exeDir = detection.exe ? path.dirname(detection.exe.path) : detection.gameDir;
  const writable = deps.canWrite ? deps.canWrite(exeDir) : (detection.writable !== undefined ? detection.writable : apply.canWrite(exeDir));
  if (!writable) {
    checks.push(fail('fail', 'writable', '当前游戏目录需要更高权限。'));
    errors.push('writable');
  } else {
    checks.push(fail('pass', 'writable', '游戏目录可写。'));
  }

  // Disk space
  const disk = detection.diskSpace;
  if (disk && !disk.ok) {
    checks.push(fail('fail', 'disk', `磁盘空间不足：剩余 ${Math.floor(disk.free / 1024 / 1024)} MB。`));
    errors.push('disk');
  } else if (disk) {
    checks.push(fail('pass', 'disk', `剩余 ${Math.floor(disk.free / 1024 / 1024 / 1024 * 10) / 10} GB。`));
  }

  // DLL conflicts
  const conflicts = (detection.existingDlls || []).filter(d => d.conflict && d.kind !== 'managed');
  const unknown = conflicts.filter(c => c.kind === 'unknown');
  if (unknown.length) {
    checks.push(fail('fail', 'conflicts', `未知代理 DLL：${unknown.map(c => c.name).join(', ')}。智能安装已停止。`));
    errors.push('conflicts');
  } else if (conflicts.length) {
    checks.push(fail('warn', 'conflicts', `存在 Mod（不会被覆盖）：${conflicts.map(c => c.name).join(', ')}。`));
    warnings.push('conflicts');
  } else {
    checks.push(fail('pass', 'conflicts', '未检测到冲突的画质 Mod。'));
  }

  // Backup integrity: a pending transaction must be resolved first.
  if (fs.existsSync(journal.pendingPath(detection.gameDir))) {
    checks.push(fail('fail', 'backup', '存在之前中断的切换，需要恢复。请先点击「恢复原文件」。'));
    errors.push('backup');
  } else {
    checks.push(fail('pass', 'backup', '备份目录就绪。'));
  }

  // Components: the payload the app ships must carry the runtime for the route.
  const payload = deps.payload || null;
  const route = recommendation && recommendation.recommendedRoute;
  if (route && !payload) {
    checks.push(fail('fail', 'components', '应用组件包缺失；请重新安装应用。'));
    errors.push('components');
  } else if (route === 'feeder' && payload && (!payload.source.feeder || !payload.source.hasNeuralRendering)) {
    checks.push(fail('fail', 'components', 'Feeder 组件包不完整或缺少神经网络运行时。'));
    errors.push('components');
  } else if (route === 'optiscaler' && payload && !payload.source.hasNeuralRendering) {
    checks.push(fail('fail', 'components', 'OptiScaler 缺少神经网络运行时组件。'));
    errors.push('components');
  } else if (route) {
    checks.push(fail('pass', 'components', `${route} 路线的组件在本地可用。`));
  }

  // Download source / network. The offline path is a warning, not a block:
  // every pinned component is cached after first download, and the bundled
  // payload covers the runtime.
  if (route && deps.network) {
    checks.push(deps.network === 'offline'
      ? fail('warn', 'network', '在线组件更新检查失败，当前继续使用本地版本。')
      : fail('pass', 'network', '网络可用，可更新组件。'));
    if (deps.network === 'offline') warnings.push('network');
  }

  return {
    ok: errors.length === 0,
    blocked: errors.length > 0,
    checks,
    errors,
    warnings,
    gameDir: detection.gameDir
  };
}

// Describe which components a route touches and where they come from. The
// installer itself (src/core/apply.js) remains the authority on the exact
// file moves; this list is the plan the user reads and confirms.
function componentsForRoute(route, detection) {
  const list = [];
  switch (route) {
    case 'native':
    case 'renodx': {
      const multipass = route === 'renodx';
      list.push({
        name: multipass ? 'RenoDX DLSS Tool (multipass)' : 'RenoDX DLSS5 consumer',
        version: multipass ? renodx.MULTIPASS.version : renodx.CONSUMER.version,
        source: COMPONENT_SOURCES[multipass ? 'RenoDX DLSS Tool (multipass)' : 'RenoDX DLSS5 consumer'],
        action: 'download-verified',
        note: multipass ? '实验性 multipass 消费者' : '官方 RenoDX 消费者'
      });
      list.push({ name: 'Neural Rendering runtime', version: 'app payload', source: null, action: 'payload', note: 'nvngx_dlssnr.dll' });
      break;
    }
    case 'feeder': {
      list.push({
        name: 'DLSS5-Feeder', version: feederRelease.version,
        source: COMPONENT_SOURCES['DLSS5-Feeder'], action: 'download-verified',
        note: '着色器 + 主机 + 插件（随应用内置）'
      });
      const api = detection.exe && detection.exe.api;
      if (api === 'd3d8' || api === 'd3d9' || api === 'ddraw') {
        list.push({ name: 'dgVoodoo2', version: '2.87.5', source: null, action: 'download-verified', note: 'DX8/9/DDraw → D3D11 包装器' });
      }
      list.push({ name: 'Motion provider', version: 'LumeniteFX/VORT', source: null, action: 'download-verified', note: '离线回退 VORT' });
      list.push({ name: 'ReShade', version: 'addon build', source: null, action: 'reuse-or-install', note: '检测到已有 ReShade 时复用' });
      break;
    }
    case 'optiscaler': {
      list.push({
        name: 'OptiScaler DLSS-NR', version: optiscaler.RELEASE.version,
        source: COMPONENT_SOURCES['OptiScaler DLSS-NR'], action: 'download-verified',
        note: '官方 GitHub Release，固定 SHA256'
      });
      list.push({ name: 'Neural Rendering runtime', version: 'app payload', source: null, action: 'payload', note: 'nvngx_dlssnr.dll' });
      break;
    }
    default:
      break;
  }
  return list;
}

function replacementsForRoute(route, detection) {
  const out = [];
  const existing = (detection.existingDlls || []).filter(d => d.kind === 'reshade' || d.kind === 'managed');
  if (route === 'feeder' || route === 'native' || route === 'renodx') {
    out.push({ rel: 'dxgi.dll / d3d11.dll', action: existing.length ? 'reuse-tracked' : 'backup-then-replace', note: 'ReShade 挂钩' });
    out.push({ rel: 'renodx-dlss*.addon64', action: 'backup-then-add', note: '消费者插件' });
    out.push({ rel: 'nvngx_dlssnr.dll / nvngx_dlss.dll', action: 'backup-then-replace', note: '只升级不降级（官方规则）' });
  } else if (route === 'optiscaler') {
    out.push({ rel: 'dxgi.dll / winmm.dll', action: 'backup-then-replace', note: 'OptiScaler 挂钩' });
    out.push({ rel: 'OptiScaler/*', action: 'backup-then-add', note: '组件与许可证' });
  }
  return out;
}

function riskFor(recommendation, detection) {
  if (recommendation && recommendation.experimental) return 'high';
  const conflicts = (detection.existingDlls || []).filter(d => d.conflict && d.kind !== 'managed');
  if (conflicts.length) return 'medium';
  return 'low';
}

function buildInstallPlan(detection, recommendation, mode) {
  const route = recommendation ? recommendation.recommendedRoute : null;
  const api = detection.exe ? detection.exe.api : null;
  const steps = [
    { step: 'preflight', detail: '检查 GPU / API / 权限 / 冲突 / 反作弊' },
    { step: 'backup', detail: '官方事务备份（_DLSS5_Backup）' },
    { step: 'stage', detail: '下载并校验组件（固定 SHA256）' },
    { step: 'install', detail: `${route || '—'} 路线写入游戏目录（逐文件备份）` },
    { step: 'verify', detail: '安装后验证（等待启动游戏）' },
    { step: 'record', detail: '保存 Last Known Good 与安装历史' }
  ];
  return {
    game: detection.exe ? path.basename(detection.gameDir) : path.basename(detection.gameDir),
    gameDir: detection.gameDir,
    gpu: detection.gpu && detection.gpu.primary ? detection.gpu.primary.name : null,
    api: detection.exe ? detection.exe.apiLabel : null,
    apiKey: api,
    bitness: detection.exe ? detection.exe.bitness : null,
    mode,
    recommendedRoute: route,
    fallbackRoutes: recommendation ? recommendation.fallbackRoutes : [],
    optionalRoutes: recommendation ? recommendation.optionalRoutes : [],
    components: route ? componentsForRoute(route, detection) : [],
    replacements: route ? replacementsForRoute(route, detection) : [],
    conflicts: recommendation ? recommendation.conflicts : [],
    rollbackPoint: 'auto',
    risk: riskFor(recommendation, detection),
    multipass: recommendation ? recommendation.multipass : 1,
    steps
  };
}

module.exports = { preflightCheck, buildInstallPlan, componentsForRoute, replacementsForRoute, COMPONENT_SOURCES };
