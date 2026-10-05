'use strict';
// Release metadata and high-confidence credential/path checks. Generic words
// such as Authorization and token are legitimate protocol identifiers.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const lock = require('../package-lock.json');
function check(pass, description) { if (!pass) throw new Error(description); console.log('OK ' + description); }
check(pkg.version === lock.version && pkg.version === lock.packages[''].version, 'package and lock versions agree');
check(/^\d+\.\d+\.\d+$/.test(pkg.version), 'stable package version');
const fork = 'https://github.com/STARSHINE56/DLSS5-Swapper';
const links = require('../src/core/project-links').links;
check(links.github === fork && links.releases === fork + '/releases/latest', 'fork About destinations');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
check(read('main.js').includes('https://api.github.com/repos/STARSHINE56/DLSS5-Swapper/releases/latest'), 'fork update endpoint');
const readme = read('README.md');
check(!/https:\/\/github\.com\/rakanki911\/DLSS5-Swapper\/releases/.test(readme), 'README download links point at fork');
check(readme.includes('github/v/release/STARSHINE56/') && readme.includes('github/downloads/STARSHINE56/'), 'fork release and download badges');
check(readme.includes('Support upstream author') && readme.includes('Rakan Alkhaldi') && readme.includes('MIT'), 'upstream attribution and funding explanation');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
for (const rel of files) {
  const bytes = fs.readFileSync(path.join(root, rel));
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf8');
  // Fixture strings are documented synthetic data, never shipped.
  if (rel.startsWith('test/')) continue;
  check(!/(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(text), `no credential material: ${rel}`);
  check(!/C:[\\/]+Users[\\/]+Administrator[\\/]/i.test(text), `no developer user path: ${rel}`);
}
console.log('RELEASE SOURCE OK');
