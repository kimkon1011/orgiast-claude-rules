import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectUserEffortKpi, formatUserEffortKpi, parseArgs, summarizeUserEffortKpi } from './user-effort-kpi.mjs';

const NOW = Date.parse('2026-09-06T12:00:00Z');
const recent = (seconds = 0) => new Date(NOW - seconds * 1000).toISOString();

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'user-effort-kpi-'));
  const project = path.join(home, '.claude', 'projects', 'fixture');
  fs.mkdirSync(project, { recursive: true });
  const events = [
    { type: 'user', timestamp: recent(10), message: { content: 'すすめて' } },
    { type: 'user', timestamp: recent(9), message: { content: [{ type: 'text', text: '具体的な依頼です' }] } },
    { type: 'user', timestamp: recent(8), message: { content: '<command-name>ignored' } },
    { type: 'user', timestamp: recent(7), isSidechain: true, message: { content: 'はい' } },
    { type: 'assistant', timestamp: recent(6), message: { content: [{ type: 'text', text: 'a\n'.repeat(10) + 'してください' }] } },
    { type: 'assistant', timestamp: recent(5), isSidechain: true, message: { content: 'クリック' } },
  ];
  const body = `${events.map(JSON.stringify).join('\n')}\n${' '.repeat(2_100)}\n`;
  const transcript = path.join(project, 'session.jsonl');
  fs.writeFileSync(transcript, body);
  fs.utimesSync(transcript, NOW / 1000, NOW / 1000);
  fs.writeFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), `${JSON.stringify({ ts: recent(4), stop_hook_active: true })}\n${JSON.stringify({ ts: recent(100), stop_hook_active: false })}\n`);
  fs.writeFileSync(path.join(home, '.claude', 'handoff-ledger.jsonl'), `${JSON.stringify({ ts: recent(3), reason: 'stop_hook_active' })}\n${JSON.stringify({ ts: recent(20), reason: 'stop_hook_active' })}\n`);
  return home;
}

test('fixture から各指標を定義どおり集計する', () => {
  const home = fixture();
  const result = collectUserEffortKpi({ home, now: NOW, days: 7, manualMerges: () => 3 });
  assert.deepEqual(result, { days: 7, sessions: 1, human_turns: 2, followups_per_session: 1, kick_turns: 1, rewrite_stops: 2, chars_read: 26, long_turns: 1, handoffs: 1, manual_merges: 3 });
  fs.rmSync(home, { recursive: true, force: true });
});

test('2KB 以下・期間外 mtime の transcript は session に含めない', () => {
  const home = fixture();
  const project = path.join(home, '.claude', 'projects', 'fixture');
  fs.writeFileSync(path.join(project, 'small.jsonl'), '{}\n');
  const old = path.join(project, 'old.jsonl');
  fs.writeFileSync(old, ' '.repeat(2_100));
  fs.utimesSync(old, (NOW - 8 * 86_400_000) / 1000, (NOW - 8 * 86_400_000) / 1000);
  assert.equal(collectUserEffortKpi({ home, now: NOW, manualMerges: () => null }).sessions, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('Markdown・5行以内要約・引数を安定して出力する', () => {
  const kpi = { days: 7, sessions: 1, human_turns: 2, followups_per_session: 1, kick_turns: 1, rewrite_stops: 2, chars_read: 35, long_turns: 1, handoffs: 1, manual_merges: null };
  assert.match(formatUserEffortKpi(kpi), /\| manual_merges \| n\/a \| 0 \|/);
  assert.ok(summarizeUserEffortKpi(kpi).split('\n').length <= 5);
  assert.deepEqual(parseArgs(['--days', '14', '--json']), { days: 14, json: true });
  assert.throws(() => parseArgs(['--days', '0']), /正の整数/);
});
