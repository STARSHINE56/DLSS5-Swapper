'use strict';
// Build-only bootstrap. Reuse the exact upstream runtime inputs without
// changing any component URL, installer or payload collection logic.
// The fork application and overlay are always rebuilt from the checked-out source.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { execFileSync } = require('child_process');
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip');
const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'vendor');
const setup = path.join(vendor, 'upstream-2.2.9-setup.exe');
const digest = 'e89fb5e59b4304e1fb2bccba7d24353ef83ea22b7b699c68a33828ae4420f735';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function main() {
  fs.mkdirSync(vendor, { recursive: true });
  if (!fs.existsSync(setup) || hash(setup) !== digest) {
    const response = await fetch('https://github.com/rakanki911/DLSS5-Swapper/releases/download/v2.2.9/DLSS5-Swapper-Setup-2.2.9.exe', {
      signal: AbortSignal.timeout(300000), headers: { 'User-Agent': 'Starshine-Auto-release-build' }
    });
    if (!response.ok) throw new Error(`Upstream build inputs download failed: ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(setup));
  }
  if (hash(setup) !== digest) throw new Error('Upstream input SHA256 mismatch; nothing was extracted');
  const extracted = path.join(vendor, 'upstream-runtime');
  const sevenzip = await getPath7za();
  execFileSync(sevenzip, ['x', '-y', `-o${extracted}`, setup,
    'resources/payload/streamline/*', 'resources/payload/ReShade_Setup_*_Addon.exe'], { stdio: 'inherit' });
  const payload = path.join(extracted, 'resources', 'payload');
  const streamline = path.join(payload, 'streamline');
  if (!fs.existsSync(path.join(streamline, 'nvngx_dlssnr.dll'))) throw new Error('Upstream neural runtime missing');
  // collect-payload already searches beside the checkout. Never overwrite
  // a differing developer-supplied file when this helper runs locally.
  const destination = path.resolve(root, '..', 'streamline');
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(streamline)) {
    const source = path.join(streamline, name), target = path.join(destination, name);
    if (fs.existsSync(target) && hash(target) !== hash(source)) throw new Error(`Existing build input differs: ${name}`);
    fs.copyFileSync(source, target);
  }
  const reshade = fs.readdirSync(payload).find(name => /^ReShade_Setup_.*_Addon\.exe$/.test(name));
  if (!reshade) throw new Error('Upstream ReShade Addon setup missing');
  fs.copyFileSync(path.join(payload, reshade), path.join(vendor, reshade));
  console.log('Pinned upstream runtime inputs ready; application source was not copied.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
