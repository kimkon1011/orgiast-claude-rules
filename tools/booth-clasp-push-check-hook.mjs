import { spawn } from 'node:child_process';
import { backgroundSpawnOptions } from './lib/background-spawn.mjs';

const BOOTH_CLASP_PUSH_CHECK = 'C:\\Users\\uers\\.claude\\hooks\\booth-clasp-push-check.mjs';

export function launchBoothClaspPushCheck({ spawnImpl = spawn } = {}) {
  try {
    const child = spawnImpl(process.execPath, [BOOTH_CLASP_PUSH_CHECK], {
      ...backgroundSpawnOptions(),
      stdio: 'ignore',
    });
    child.on?.('error', () => {});
    child.unref();
  } catch {
    // SessionStart must continue even when the detached check cannot be launched.
  }
}

launchBoothClaspPushCheck();
