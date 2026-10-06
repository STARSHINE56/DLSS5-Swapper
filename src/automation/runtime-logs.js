'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GAME_LOGS = ['dlss5-feed.log', 'ReShade.log', path.join('host64', 'dlss5-feed-host.log'),
  path.join('host64', 'ReShade.log'), 'dlss5-feed-crash.dmp.txt', 'OptiScaler.log'];
const MAX_READ = 8 * 1024 * 1024;
const WINDOW = 256;

function bytes(fd, start, size) {
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const count = fs.readSync(fd, buffer, read, size - read, start + read);
    if (!count) break;
    read += count;
  }
  return buffer.subarray(0, read);
}
function hashWindow(fd, start, size) {
  return crypto.createHash('sha256').update(bytes(fd, start, size)).digest('hex');
}
function fingerprint(fd, stat) {
  const length = Math.min(stat.size, WINDOW);
  return { size: stat.size, dev: stat.dev, ino: stat.ino,
    prefix: hashWindow(fd, 0, length), boundary: hashWindow(fd, stat.size - length, length) };
}

// Saved when installation completes. Later touches/appends cannot turn an old
// successful session into evidence for the new candidate.
function snapshotLogs(exeDir) {
  const snapshot = {};
  for (const name of GAME_LOGS) {
    let fd;
    try {
      fd = fs.openSync(path.join(exeDir, name), 'r');
      const stat = fs.fstatSync(fd);
      snapshot[name] = stat.isFile() ? fingerprint(fd, stat) : { unreadable: true };
    } catch (error) {
      snapshot[name] = error.code === 'ENOENT' ? null : { unreadable: true };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return snapshot;
}

function logInfo(exeDir, name, baseline) {
  const file = path.join(exeDir, name);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    const info = { name, path: file, size: stat.size, modifiedTime: stat.mtime.toISOString(), head: '', truncated: false };
    if (baseline?.unreadable) return { ...info, readError: true };
    let start = 0;
    if (baseline && Number.isSafeInteger(baseline.size) && baseline.size >= 0 &&
        stat.size >= baseline.size && stat.dev === baseline.dev && stat.ino === baseline.ino) {
      const length = Math.min(baseline.size, WINDOW);
      if (hashWindow(fd, 0, length) === baseline.prefix &&
          hashWindow(fd, baseline.size - length, length) === baseline.boundary) start = baseline.size;
    }
    const available = stat.size - start;
    info.truncated = available > MAX_READ;
    info.head = bytes(fd, Math.max(start, stat.size - MAX_READ), Math.min(available, MAX_READ))
      .toString('utf8').replace(/\u0000/g, '');
    return info;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return { name, path: file, size: 0, modifiedTime: '', head: '', readError: true };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { GAME_LOGS, snapshotLogs, logInfo };
