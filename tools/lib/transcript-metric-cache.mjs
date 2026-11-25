import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Cache per-file metrics, not rolling totals: callers still apply their own
// time window and directory exclusions on every run. Bump each metric's name
// when its parsing rules change.
export function transcriptMetricCache({ home, name, cacheDir = path.join(home, '.claude') }) {
  const file = path.join(cacheDir, `${name}-cache.json`);
  let previous = {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.version === 1 && data.files && typeof data.files === 'object' && !Array.isArray(data.files)) previous = data.files;
  } catch { /* A missing or corrupt cache only costs a fresh scan. */ }
  const files = Object.create(null);
  return {
    read(transcript, parse) {
      const before = fs.statSync(transcript), old = files[transcript] || previous[transcript];
      if (old?.size === before.size && old?.mtimeMs === before.mtimeMs && old?.ctimeMs === before.ctimeMs && Object.hasOwn(old, 'value')) {
        files[transcript] = old;
        return old.value;
      }
      const value = parse(fs.readFileSync(transcript, 'utf8'));
      const after = fs.statSync(transcript);
      // A live transcript can grow while read; retry it on the next run.
      if (before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs) {
        files[transcript] = { size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, value };
      }
      return value;
    },
    save() {
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(temp, JSON.stringify({ version: 1, files }), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temp, file);
      } catch { /* Cache persistence must never fail the metric collection. */ }
      finally { try { fs.unlinkSync(temp); } catch {} }
    },
  };
}
