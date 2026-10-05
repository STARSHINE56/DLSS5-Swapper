'use strict';
// Exact allowlist: checksums and uploads refer to these newly built files only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { version } = require('../package.json');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const names = [`DLSS5-Swapper-Setup-${version}-starshine-auto.exe`, `DLSS5-Swapper-${version}-starshine-auto-portable.exe`];
const assets = names.map(name => {
  const file = path.join(dist, name);
  const bytes = fs.readFileSync(file);
  if (bytes.length < 1024 * 1024 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error(`Invalid Windows build: ${name}`);
  return { name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
});
fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), assets.map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n');
fs.writeFileSync(path.join(dist, 'release-assets.json'), JSON.stringify(assets, null, 2) + '\n');
console.log(JSON.stringify(assets, null, 2));
