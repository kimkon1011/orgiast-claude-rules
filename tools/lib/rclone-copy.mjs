// Shared non-destructive transport for Drive backup and knowledge upstream.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isEntry } from '../is-entry.mjs';

const execFileAsync = promisify(execFile);

export async function runRclone(args, { executable = 'rclone', timeout = 600_000 } = {}) {
  const { stdout } = await execFileAsync(executable, args, {
    windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
  });
  return stdout;
}

export async function copyToRclone({ source, destination, directory = false, extraArgs = [], run = runRclone }) {
  // copy/copyto never remove other destination files (unlike sync).
  return run([directory ? 'copy' : 'copyto', source, destination, ...extraArgs]);
}

if (isEntry(import.meta.url)) {
  const [executable, source, destination, ...extraArgs] = process.argv.slice(2);
  try {
    if (!executable || !source || !destination) throw new Error('rclone-copy requires executable, source and destination');
    await copyToRclone({ source, destination, extraArgs,
      run: args => runRclone(args, { executable, timeout: 6 * 60 * 60 * 1000 }),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
