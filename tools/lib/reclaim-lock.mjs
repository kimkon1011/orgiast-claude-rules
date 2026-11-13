import fs from 'node:fs';

export const RECLAIM_STALE_MS = 60_000;

export function removeReclaimDirectory(directory) {
  try { fs.rmdirSync(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// Keep mkdir exclusive and retries bounded: a fresh competing claim stays busy.
// Never recursively remove a directory whose contents we do not own.
export function createReclaimDirectory(directory, { now = Date.now } = {}) {
  try { fs.mkdirSync(directory); return; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      if (now() - fs.statSync(directory).mtimeMs <= RECLAIM_STALE_MS) throw error;
      removeReclaimDirectory(directory);
    } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
  }
  fs.mkdirSync(directory);
}
