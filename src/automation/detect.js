'use strict';

// Starshine Auto - detection layer.
//
// Answers, from the machine and the game folder, everything a recommendation
// needs: GPU family and driver, rendering API, which proxy DLLs already sit
// beside the game and who owns them, NVIDIA runtime files, anti-cheat and
// online-competitive risk, write access and disk space.
//
// Nothing here writes to the game folder. Detection only reads. Unknown is a
// real answer: when the API cannot be determined, it is reported as UNKNOWN
// rather than guessed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pe = require('../core/pe');
const apply = require('../core/apply');
const guards = require('../core/install-guards');
const compatibility = require('../core/compatibility');
const { safePath } = require('../core/file-journal');

// Proxy names ReShade/OptiScaler/Special K register under, in the order they
// are reported. dinput8.dll is a legitimate modding hook name as well.
const PROXY_DLLS = ['dxgi.dll', 'd3d11.dll', 'd3d12.dll', 'd3d9.dll', 'd3d8.dll', 'ddraw.dll', 'dinput8.dll', 'version.dll', 'winmm.dll', 'opengl32.dll'];

// NVIDIA runtime files managed by the routes. Feeder's helper also carries
// nvngx_dlssnr.dll / nvngx_dlss.dll inside host64.
const NVIDIA_FILES = /^nvngx(?:_dlss[a-z_]*)?\.dll$/i;

const COMPETITIVE_MARKERS = /^(?:easyanticheat|battleye|eaanticheat|(?:^|[-_])(?:eac|be)launcher|ricochet|vanguard|anticheat|anti-cheat|be_|eac_)/i;

// An unknown proxy DLL with its own version resource is high risk: it may be
// another graphics injector (ENB, dgVoodoo without a marker, an ASI loader
// copy) and overwriting it would break the person's setup. Windows/system
// files and anything this app manages are recognised and not treated as such.

function digest(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch { return null; }
}

function readManifest(gameDir) {
  const file = path.join(apply.backupRoot(gameDir), 'manifest.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (data && data.version !== 1) return null;
  return data || null;
}

function managedSet(manifest) {
  const out = new Set();
  if (!manifest) return out;
  for (const rel of manifest.added || []) out.add(String(rel).replace(/\\/g, '/').toLowerCase());
  for (const row of manifest.replaced || []) {
    if (row && row.rel) out.add(String(row.rel).replace(/\\/g, '/').toLowerCase());
  }
  return out;
}

// Classify one candidate proxy DLL by content, not by name alone.
function classifyDll(file, rel, manifest, deps) {
  const versionMentions = deps.versionMentions || pe.versionMentions;
  const info = { name: path.basename(file), rel, path: file, version: pe.getFileVersion(file), sha256: digest(file) };
  info.managed = managedSet(manifest).has(rel.replace(/\\/g, '/').toLowerCase());
  try {
    if (versionMentions(file, 'ReShade')) return { ...info, kind: 'reshade', conflict: false };
    if (versionMentions(file, 'OptiScaler')) return { ...info, kind: 'optiscaler', conflict: true };
    if (versionMentions(file, 'Special K')) return { ...info, kind: 'specialk', conflict: true };
    if (versionMentions(file, 'dgVoodoo')) return { ...info, kind: 'dgvoodoo', conflict: true };
    if (versionMentions(file, 'DXVK') || versionMentions(file, 'vkd3d')) return { ...info, kind: 'vulkan-wrapper', conflict: true };
    if (info.managed) return { ...info, kind: 'managed', conflict: false };
    // A Windows/system DLL carries a Microsoft version resource; a hook or
    // loader copy without one is unknown and therefore high risk. The file
    // name alone never decides this (version.dll is both a Windows file and
    // a favourite hook name).
    if (versionMentions(file, 'Microsoft')) return { ...info, kind: 'system', conflict: false };
    return { ...info, kind: 'unknown', conflict: true, note: 'Unknown proxy DLL' };
  } catch {
    return { ...info, kind: 'unknown', conflict: true, note: 'Unreadable proxy DLL' };
  }
}

function confidenceFor(via) {
  if (!via) return 'UNKNOWN';
  if (via === 'imports' || via === 'game-profile' || via === 'vulkan-wrapper') return 'HIGH';
  if (via === 'undetected') return 'UNKNOWN';
  return 'MEDIUM';
}

function scanExeDir(exeDir, gameDir, manifest, deps) {
  const found = [];
  let names = [];
  try { names = fs.readdirSync(exeDir); } catch { return found; }
  const lower = name => name.toLowerCase();
  for (const name of names) {
    if (PROXY_DLLS.includes(lower(name))) {
      const file = path.join(exeDir, name);
      if (!fs.statSync(file).isFile()) continue;
      let rel;
      try { rel = path.relative(gameDir, file); } catch { rel = name; }
      found.push(classifyDll(file, rel, manifest, deps));
    }
  }
  return found;
}

function scanNvidia(exeDir, gameDir, manifest) {
  const found = [];
  let names = [];
  try { names = fs.readdirSync(exeDir); } catch { return found; }
  for (const name of names) {
    if (!NVIDIA_FILES.test(name)) continue;
    const file = path.join(exeDir, name);
    if (!fs.statSync(file).isFile()) continue;
    let rel;
    try { rel = path.relative(gameDir, file); } catch { rel = name; }
    found.push({
      name, rel, path: file,
      version: pe.getFileVersion(file),
      sha256: digest(file),
      managed: managedSet(manifest).has(rel.replace(/\\/g, '/').toLowerCase())
    });
  }
  return found;
}

function scanMods(gameDir, exeDir, reshade) {
  const mods = [];
  if (reshade && reshade.installed) {
    mods.push({ kind: 'reshade', rel: reshade.file || 'dxgi.dll', path: reshade.file ? path.join(exeDir, reshade.file) : null, version: reshade.version, managed: reshade.installedByUs === true });
  }
  for (const name of ['dlss5-feed.addon64', 'dlss5-feed.addon32', 'renodx-dlss5.addon64', 'renodx-dlss.addon64']) {
    const file = path.join(exeDir, name);
    if (fs.existsSync(file)) {
      mods.push({ kind: name.startsWith('dlss5-feed') ? 'feeder' : 'renodx', rel: name, path: file, version: pe.getFileVersion(file), managed: false });
    }
  }
  const host = path.join(exeDir, 'host64');
  if (fs.existsSync(host)) {
    for (const name of ['dlss5-feed-host64.exe', 'renodx-dlss5.addon64', 'renodx-dlss.addon64']) {
      const file = path.join(host, name);
      if (fs.existsSync(file)) mods.push({ kind: name.includes('addon') ? 'renodx' : 'feeder', rel: path.join('host64', name), path: file, version: pe.getFileVersion(file), managed: false });
    }
  }
  return mods;
}

function detectAntiCheat(gameDir, exeDir, deps) {
  const antiCheatPresent = deps.antiCheatPresent || guards.antiCheatPresent;
  const present = antiCheatPresent(gameDir);
  const names = [];
  const queue = [[gameDir, 0]];
  let examined = 0;
  while (queue.length && examined < 600) {
    const [dir, depth] = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (examined++ >= 600) break;
      if (COMPETITIVE_MARKERS.test(entry.name)) names.push(entry.name);
      if (entry.isDirectory() && depth < 2 && !/^_DLSS5_Backup$|^node_modules$/i.test(entry.name)) {
        queue.push([path.join(dir, entry.name), depth + 1]);
      }
    }
  }
  return {
    present: Boolean(present) || names.length > 0,
    names: [...new Set(names)].slice(0, 8),
    blocked: Boolean(present) || names.length > 0
  };
}

function diskSpace(dir, deps) {
  const statfs = deps.statfs || (typeof fs.statfsSync === 'function' ? fs.statfsSync : null);
  if (!statfs) return null;
  try {
    const info = statfs(dir);
    const free = info.bavail * info.bsize;
    const total = info.blocks * info.bsize;
    return { free, total, ok: free > 512 * 1024 * 1024 };
  } catch { return null; }
}

// `options.gameDir` is required. `options.exePath` may pin the executable;
// otherwise the scanner's chosen one is used.
async function detectGame(options, deps = {}) {
  const gameDir = options.gameDir;
  const scan = deps.scanGame ? await deps.scanGame(gameDir) : await (require('../core/scan').scanGame)(gameDir);
  const manifest = deps.readManifest ? deps.readManifest(gameDir) : readManifest(gameDir);
  const picked = (scan.exeCandidates || []).find(e => e.path === options.exePath) || scan.chosen || null;

  const result = {
    gameDir,
    ok: Boolean(picked),
    exe: picked ? {
      path: picked.path,
      rel: picked.rel,
      api: picked.api,
      apiLabel: picked.apiLabel,
      bitness: picked.bitness,
      via: picked.via,
      emulator: picked.emulator || null,
      apiChoices: picked.apiChoices || []
    } : null,
    apiConfidence: picked ? confidenceFor(picked.via) : 'UNKNOWN',
    scan
  };

  // GPU + driver. nvidia-smi absence is a real answer too: no NVIDIA tooling
  // means the smart path cannot prove the card, and stays conservative.
  let gpuRows = null;
  try {
    const rows = deps.gpuInfo ? await deps.gpuInfo() : await guards.gpuInfo();
    if (Array.isArray(rows)) gpuRows = rows.filter(r => r && r.name);
  } catch { gpuRows = null; }
  const primary = gpuRows && gpuRows[0] ? { name: gpuRows[0].name, driver: gpuRows[0].driver } : null;
  const isNvidia = primary ? /nvidia|geforce|rtx|gtx|quadro|tesla/i.test(primary.name) : false;
  const isRtx = primary ? /\bRTX\b/i.test(primary.name) : false;
  const isBlackwell = primary ? guards.gpuModelSupported(gpuRows) : false;
  const driverNumber = primary ? (() => {
    const m = /^(\d+)\.(\d+)/.exec(String(primary.driver || ''));
    return m ? Number(m[1]) * 100 + Number(m[2]) : null;
  })() : null;
  result.gpu = {
    available: Boolean(primary),
    rows: gpuRows,
    primary,
    isNvidia,
    isRtx,
    isBlackwell,
    driver: primary ? primary.driver : null,
    driverNumber,
    driverSupported: guards.driverSupported(gpuRows || []),
    modelSupported: guards.gpuModelSupported(gpuRows || [])
  };
  result.multiGpu = Boolean(gpuRows && gpuRows.length > 1);

  // Existing DLLs and NVIDIA files beside the executable.
  const exeDir = picked ? path.dirname(picked.path) : gameDir;
  result.existingDlls = scanExeDir(exeDir, gameDir, manifest, deps);
  result.nvidiaFiles = scanNvidia(exeDir, gameDir, manifest);

  // ReShade / add-ons / mods.
  result.reshade = picked ? scan.reshade : null;
  result.mods = scanMods(gameDir, exeDir, result.reshade);

  // Anti-cheat and competitive risk. Detection blocks the smart path; the
  // manual install keeps its own consent dialog, untouched.
  result.antiCheat = detectAntiCheat(gameDir, exeDir, deps);

  // Write access and disk space.
  result.writable = deps.canWrite ? deps.canWrite(exeDir) : apply.canWrite(exeDir);
  result.diskSpace = diskSpace(exeDir, deps);

  // A game whose folder is managed by a mod manager (MO2 Stock Game / Root
  // Builder) is refused by the official preflight; reflect that here.
  result.managedModRoot = picked ? compatibility.managedModRoot(gameDir, picked.path) : null;

  return result;
}

module.exports = { detectGame, classifyDll, confidenceFor, readManifest, PROXY_DLLS, NVIDIA_FILES, COMPETITIVE_MARKERS, digest };
