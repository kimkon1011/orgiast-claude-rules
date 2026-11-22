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

export function parseCliArgs(argv) {
  const args = [...argv];
  let timeout = 6 * 60 * 60 * 1000;
  if (args[0] === '--timeout-ms') {
    const value = args.splice(0, 2)[1];
    timeout = Number(value);
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new Error('rclone-copy --timeout-ms requires a positive safe integer');
    }
  }
  const [executable, source, destination, ...extraArgs] = args;
  if (!executable || !source || !destination) {
    throw new Error('rclone-copy requires executable, source and destination');
  }
  return { executable, source, destination, extraArgs, timeout };
}

if (isEntry(import.meta.url)) {
  try {
    const { executable, source, destination, extraArgs, timeout } = parseCliArgs(process.argv.slice(2));
    await copyToRclone({ source, destination, extraArgs,
      run: args => runRclone(args, { executable, timeout }),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
