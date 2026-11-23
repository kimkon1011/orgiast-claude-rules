import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = fileURLToPath(new URL('./', import.meta.url));
const excluded = new Set([
  'notify-kim.mjs',
  'notify-owner.mjs',
  'bg-turn-report-gate.mjs',
  'selftest-guards.mjs',
  // 社員オーナーも対象となる notifyOwner の呼び出し。
  'auto-progress-check.mjs',
  'auto-progress-watch.mjs',
  // spooled を既に成功扱いしている。
  'auto-progress-digest.mjs',
  'lib/owner-dm-policy.mjs',
  'model-scout.mjs',
]);

function* modules(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* modules(file);
    else if (entry.isFile() && file.endsWith('.mjs') && !file.endsWith('.test.mjs')) yield file;
  }
}

test('kim 宛通知の配信判定は isKimDelivered に統一する', () => {
  const allowlist = /\[\s*['"]dm['"]\s*,\s*['"]session-inbox['"][^\]]*\]\s*\.\s*includes\s*\(/g;
  const violations = [];
  for (const file of modules(toolsDir)) {
    const relative = path.relative(toolsDir, file).split(path.sep).join('/');
    if (excluded.has(relative)) continue;
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(allowlist)) {
      // 同じファイル内の社員オーナー宛ての判定だけを除外する。
      if (relative === 'lib/fleet-chase-actions.mjs' && source.slice(match.index).startsWith("['dm', 'session-inbox'].includes(response?.delivered)) throw new Error('owner DM failed')")) continue;
      const line = source.slice(0, match.index).split('\n').length;
      violations.push(`${relative}:${line}`);
    }
  }
  assert.deepEqual(violations, [], '配信判定には isKimDelivered を使う');
});
