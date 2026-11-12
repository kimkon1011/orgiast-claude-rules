// Seat validity check for deadline jobs: requires both kim-operated seat AND the kim DWD key.
// Shared by setup-deadline-watch.mjs, deadline-detect.mjs, deadline-watch.mjs.
import fs from 'node:fs';
import os from 'node:os';
import { isKimOperated } from './kim-operated.mjs';
import { defaultDriveKeyPath } from './drive-auth.mjs';

export function hasDwdKey(keyPath = process.env.GOOGLE_SA_KEY ?? defaultDriveKeyPath()) {
  return fs.existsSync(keyPath);
}

export function seatCheck(home = process.env.ORGIAST_HOME || os.homedir()) {
  const kimOperated = isKimOperated(home);
  const dwdKey = hasDwdKey();
  return { kim: kimOperated && dwdKey, kimOperated, dwdKey };
}