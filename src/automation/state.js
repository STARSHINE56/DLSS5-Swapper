'use strict';

// Starshine Auto - shared state vocabulary and outcome helper. Kept in its own
// module so the automation modules can require it without a circular import
// through the index.

// One state vocabulary across the whole automation layer. Different pages used
// to say "installed", "deployed", "enabled" and mean different things; every
// surface now derives from these.
const STATES = Object.freeze({
  NOT_INSTALLED: 'not_installed',
  READY: 'ready',
  INSTALLING: 'installing',
  WAITING_FOR_VERIFICATION: 'waiting_for_verification',
  VERIFYING: 'verifying',
  WORKING: 'working',
  NEEDS_ATTENTION: 'needs_attention',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled_back'
});

// The four ordinary-user modes plus the auto default. Experimental is the only
// mode that may raise the multipass count, and it carries its own warnings.
const MODES = Object.freeze({
  AUTO: 'auto',
  STABLE: 'stable',
  QUALITY: 'quality',
  PERFORMANCE: 'performance',
  EXPERIMENTAL: 'experimental'
});

const MODE_ORDER = Object.freeze([MODES.AUTO, MODES.STABLE, MODES.QUALITY, MODES.PERFORMANCE, MODES.EXPERIMENTAL]);
const VALID_MODES = new Set(MODE_ORDER);

function normalizeMode(value) {
  return VALID_MODES.has(value) ? value : MODES.AUTO;
}

// A compact, human-readable summary of an automation result. Callers (IPC and
// tests) use `ok` + `state` + `code`; UI text lives in feature-i18n.
function outcome(ok, state, code, extra) {
  return Object.assign({ ok, state, code: code || (ok ? 'ok' : 'errAuto') }, extra || {});
}

module.exports = { STATES, MODES, MODE_ORDER, normalizeMode, outcome };
