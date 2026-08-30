import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runEvening } from './evening-digest.mjs';

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'evening-digest-')); }
const response = () => ({ ok: true, status: 204, text: async () => '' });
test('formats no-results case and dry-run stays side-effect free', async () => {
  const dir = home(); const result = await runEvening({ home: dir, now: new Date('2026-08-31T18:00:00'), dryRun: true });
  assert.match(result.message, /特筆事項なし/); assert.equal(fs.existsSync(path.join(dir, '.claude', 'evening-digest-state.json')), false);
});
test('formats results, skips second send, and force sends again', async () => {
  const dir = home(); const now = new Date('2026-08-31T18:00:00'); const resultDir = path.join(dir, '.claude', 'batch-queue');
  fs.mkdirSync(resultDir, { recursive: true });
  fs.writeFileSync(path.join(resultDir, 'results-2026-08-31.jsonl'), `${JSON.stringify({ jobType: 'auto-session-digest', text: '完了しました' })}\n`);
  let sends = 0; const fetchImpl = async () => { sends++; return response(); };
  const first = await runEvening({ home: dir, now, webhookUrl: 'https://example.test/hook', fetchImpl });
  assert.match(first.message, /今日の自動セッション/); assert.match(first.message, /完了しました/);
  assert.equal((await runEvening({ home: dir, now, webhookUrl: 'https://example.test/hook', fetchImpl })).skipped, true);
  await runEvening({ home: dir, now, force: true, webhookUrl: 'https://example.test/hook', fetchImpl });
  assert.equal(sends, 2);
});
