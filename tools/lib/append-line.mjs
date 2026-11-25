import fs from 'node:fs';
import path from 'node:path';

const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function appendLineWithRetry(file, line, { attempts = 6, baseMs = 100, fsImpl = fs, sleepImpl = sleep } = {}) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fsImpl.appendFileSync(file, `${String(line).replace(/[\r\n]+$/u, '')}\n`, 'utf8');
      return;
    } catch (error) {
      last = error;
      if (!RETRYABLE.has(error?.code) || attempt === attempts - 1) throw error;
      await sleepImpl(baseMs * (2 ** attempt));
    }
  }
  throw last;
}
