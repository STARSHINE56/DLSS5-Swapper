'use strict';
// Packaged-app verification: extracts dist/win-unpacked/resources/app.asar to a
// temp dir and checks that the final localized + polished renderer code is in
// the shipped build. Run after `npm run build`.
//   node scripts/verify-package.cjs
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const archive = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
if (!fs.existsSync(archive)) {
  console.error('app.asar not found - run npm run build first');
  process.exit(1);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dlss5-asar-check-'));
try {
  const asarCli = path.join(root, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
  execFileSync(process.execPath, [asarCli, 'extract', archive, tmp], { stdio: 'pipe' });
  const read = (rel) => fs.readFileSync(path.join(tmp, ...rel.split('/')), 'utf8');
  const i18nRaw = read('src/renderer/i18n.js');
  const lockCount = (key) => (i18nRaw.match(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ": '", 'g')) || []).length;
  let ok = true;
  const checks = [
    ['i18n-extra zh inject', read('src/renderer/i18n-extra.js').includes('Object.assign(window.i18n.S.zh')],
    ['feature-i18n smart zh', read('src/shared/feature-i18n.js').includes('smartTitle')],
    ['i18n.js lock keys en/ar only (2 each)', lockCount('errNoWriteAccess') === 2 && lockCount('t2Search') === 2 && lockCount('setSafeGraphicsHint') === 2],
    ['index.html style-starshine link', read('src/renderer/index.html').includes('style-starshine.css')],
    ['style-starshine.css packaged', fs.existsSync(path.join(tmp, 'src', 'renderer', 'style-starshine.css'))],
  ];
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? 'PACKAGE OK' : 'PACKAGE HAS PROBLEMS');
  process.exit(ok ? 0 : 1);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
