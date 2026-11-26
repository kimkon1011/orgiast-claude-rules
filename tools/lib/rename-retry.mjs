import fs from 'node:fs';

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function retrySync(operation, file, { sleep = sleepSync, attempts = 8 } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 8) {
    throw new RangeError('attempts must be an integer from 1 to 8');
  }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (!RETRYABLE.has(error?.code)) throw error;
      if (attempt === attempts) {
        error.message += ` (file: ${file}; attempts: ${attempt})`;
        throw error;
      }
      sleep(Math.min(50 * 2 ** (attempt - 1), 1000));
    }
  }
}

export function renameWithRetry(from, to, { fsImpl = fs, ...options } = {}) {
  return retrySync(() => fsImpl.renameSync(from, to), from, options);
}

export function writeFileWithRetry(file, text, { fsImpl = fs, ...options } = {}) {
  return retrySync(() => fsImpl.writeFileSync(file, text), file, options);
}
