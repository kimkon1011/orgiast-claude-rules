// Seat validity check for deadline jobs: requires both kim-operated seat AND the kim DWD key.
// Shared by setup-deadline-watch.mjs, deadline-detect.mjs, deadline-watch.mjs.
import fs from 'node:fs';
import os from 'node:os';
import { isKimOperated } from './kim-operated.mjs';
import { defaultDriveKeyPath } from './drive-auth.mjs';

export function hasDwdKey(keyPath = process.env.GOOGLE_SA_KEY ?? defaultDriveKeyPath()) {
  return fs.existsSync(keyPath);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.home]  - ORGIAST_HOME (defaults to homedir)
 * @param {string} [opts.keyPath] - DWD key path override (defaults to hasDwdKey default)
 */
export function seatCheck(home, opts) {
  // Support both (home) and ({ home, keyPath }) signatures.
  if (home && typeof home === 'object') opts = home;
  const resolvedHome = (opts?.home) || (typeof home === 'string' ? home : process.env.ORGIAST_HOME || os.homedir());
  const kimOperated = isKimOperated(resolvedHome);
  const dwdKey = opts?.keyPath !== undefined ? fs.existsSync(opts.keyPath) : hasDwdKey();
  return { kim: kimOperated && dwdKey, kimOperated, dwdKey };
}