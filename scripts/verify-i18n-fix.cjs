'use strict';
// Verifies the i18n lock regression fix:
// 1. locked keys appear exactly twice (en+ar) in i18n.js raw source
// 2. after the full load chain (i18n.js -> i18n-extra.js -> feature-i18n.js),
//    S.zh still provides Chinese for every locked key
// 3. official zh keys remain intact
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.join(__dirname, '..');

const ctx = { window: {}, console };
vm.createContext(ctx);
for (const f of ['src/renderer/i18n.js', 'src/renderer/i18n-extra.js', 'src/shared/feature-i18n.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
}
const i18n = ctx.window.i18n;
const zh = i18n.S.zh;
console.log('zh keys after full chain:', Object.keys(zh).length);

const locked = [
  'errNoWriteAccess', 'sheetCommunityTitle', 'overlayNotForRoute', 'multipassNext',
  'fReshadeFile', 'reshadeProxyWrapHint', 'reshadeProxyHint', 'setSafeGraphicsHint',
  'setSkins', 'skinOne', 'skinTwo', 't2Play', 't2Setup', 't2Search',
];
let ok = true;
for (const k of locked) {
  const v = zh[k];
  const s = typeof v === 'function' ? v('bits', 'DirectX 11') : v;
  const isZh = /[\u4e00-\u9fff]/.test(String(s));
  console.log(`${isZh ? 'OK  ' : 'MISS'} ${k}: ${String(s).slice(0, 42)}`);
  if (!isZh) ok = false;
}
for (const k of ['navHome', 'gamesTitle', 'install', 'restore', 'setLang', 'setAutoScan', 'smartTitle']) {
  if (!zh[k]) { console.log('LOST zh key:', k); ok = false; }
  else console.log(`OK  official/feature key ${k}: ${String(typeof zh[k] === 'function' ? zh[k]() : zh[k]).slice(0, 30)}`);
}
const raw = fs.readFileSync(path.join(root, 'src/renderer/i18n.js'), 'utf8');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const k of locked) {
  // function-style keys are defined as `key: (args) =>`, string keys as `key: '`
  const pattern = k === 'overlayNotForRoute' ? `${esc(k)}: \\(why, api\\) =>`
    : k === 'multipassNext' ? `${esc(k)}: \\(dlss\\) =>`
    : `${esc(k)}: '`;
  const n = (raw.match(new RegExp(pattern, 'g')) || []).length;
  if (n !== 2) { console.log(`COUNT ${k}: ${n} (want 2)`); ok = false; }
}
console.log(ok ? 'ALL OK' : 'HAS PROBLEMS');
process.exit(ok ? 0 : 1);
