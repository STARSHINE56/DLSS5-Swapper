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
    ...['main.js', 'preload.js', 'THIRD_PARTY_NOTICES.md',
      ...fs.readdirSync(path.join(root, 'src', 'automation')).filter(name => name.endsWith('.js')).map(name => 'src/automation/' + name)]
      .map(rel => [`source matches tag: ${rel}`, read(rel) === fs.readFileSync(path.join(root, rel), 'utf8')]),
    ['package version matches source', JSON.parse(read('package.json')).version === require('../package.json').version],
    ['Starshine Auto UI is wired', read('src/renderer/renderer.js').includes('id="smartCard"') && read('preload.js').includes('autoVerify')],
    ['update endpoint points at fork', read('main.js').includes('https://api.github.com/repos/STARSHINE56/DLSS5-Swapper/releases/latest')],
    ['i18n-extra zh inject', read('src/renderer/i18n-extra.js').includes('Object.assign(window.i18n.S.zh')],
    ['feature-i18n smart zh', read('src/shared/feature-i18n.js').includes('smartTitle')],
    ['i18n.js lock keys en/ar only (2 each)', lockCount('errNoWriteAccess') === 2 && lockCount('t2Search') === 2 && lockCount('setSafeGraphicsHint') === 2],
    ['index.html style-starshine link', read('src/renderer/index.html').includes('style-starshine.css')],
    ['style-starshine.css packaged', fs.existsSync(path.join(tmp, 'src', 'renderer', 'style-starshine.css'))],
    ['project links point at the fork', read('src/core/project-links.js').includes('STARSHINE56/DLSS5-Swapper') && !read('src/core/project-links.js').includes('rakanki911')],
    ['sponsor block removed from About', !read('src/renderer/index.html').includes('buymeacoffee') && !read('src/renderer/index.html').includes('support-qr')],
  ];
  function walk(directory, prefix = '') {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const rel = prefix + entry.name;
      return entry.isDirectory() ? walk(path.join(directory, entry.name), rel + '/') : [rel];
    });
  }
  const paths = walk(tmp);
  const forbidden = paths.filter(rel => /(^|\/)(\.git|\.github|test|tests|scripts|dist|vendor|tools|\.cache)(\/|$)|(^|\/)\.env(?:\.|$)|\.(log|pdb)$/i.test(rel));
  checks.push(['no development files or credentials in app.asar', forbidden.length === 0]);
  if (forbidden.length) console.error('Forbidden packaged paths:', forbidden.join(', '));
  const resources = path.dirname(archive);
  for (const rel of ['payload/streamline/nvngx_dlssnr.dll', 'payload/renodx-dlss5.addon64',
    'payload/feeder/host64/renodx-dlss.addon64', 'overlay/dlss5-lab-overlay.addon64']) {
    checks.push([`runtime resource: ${rel}`, fs.existsSync(path.join(resources, rel))]);
  }
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}`);
    if (!pass) ok = false;
  }
  console.log(ok ? 'PACKAGE OK' : 'PACKAGE HAS PROBLEMS');
  process.exitCode = ok ? 0 : 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
