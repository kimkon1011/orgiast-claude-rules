import fs from 'node:fs';
import path from 'node:path';

export const SHARED_MEMORY_STALE_MS = 72 * 60 * 60 * 1000;

export function sharedMemoryFreshness(home, now = Date.now()) {
  const file = path.join(home, '.claude', 'shared-memory', '.state.json');
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const generatedAt = String(state.generatedAt || '');
    const generatedMs = Date.parse(generatedAt);
    if (!Number.isFinite(generatedMs)) return { stale: true, generatedAt, ageMs: null, detail: 'generatedAt が不正' };
    const ageMs = Math.max(0, Number(now instanceof Date ? now.getTime() : now) - generatedMs);
    return { stale: ageMs > SHARED_MEMORY_STALE_MS, generatedAt, ageMs, detail: `${(ageMs / 86400000).toFixed(1)} 日前` };
  } catch (error) { return { stale: true, generatedAt: '', ageMs: null, detail: `.state.json を読めない: ${error.message}` }; }
}

export function staleMemoryContext(home, now = Date.now()) {
  const result = sharedMemoryFreshness(home, now);
  return result.stale ? `共有メモリが ${result.detail}で止まっている。memory の記述より repo の git log を優先` : '';
}
