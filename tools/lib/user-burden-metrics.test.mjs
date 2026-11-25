import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionBurden, collectUserBurdenMetrics, formatUserBurdenLines } from './user-burden-metrics.mjs';
const user = content => ({ type: 'user', message: { content } });
const raw = entries => entries.map(JSON.stringify).join('\n');
test('人間・画像・Stop実データ・旧形式を数え、機械とsidechainは除く', () => {
  const text = raw([user('依頼'), user('[Image: a.png]'), user([{ type: 'image' }]), user('前にも試した'), user('Stop hook feedback: 直して'), user('<task-notification>通知'), user([{ type: 'tool_result' }]), { ...user('何回も'), isSidechain: true }, { type: 'attachment', attachment: { type: 'hook_blocking_error', hookEvent: 'Stop' } }]);
  assert.deepEqual(sessionBurden(text + '\n壊れた行'), { humanTurns: 4, roundTrips: 3, stopBlocks: 2, repeatComplaints: 1 });
});
test('直近ログを集計し古いログ・subagentsを除き現在のログも表示する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'burden-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'projects', 'p'); fs.mkdirSync(path.join(dir, 'subagents'), { recursive: true });
  const current = path.join(dir, 'aaa.jsonl'); fs.writeFileSync(current, raw([user('依頼'), user('また同じ'), user('完了')]));
  fs.writeFileSync(path.join(dir, 'bbb.jsonl'), raw([user('依頼')]));
  fs.writeFileSync(path.join(dir, 'subagents', 'sub.jsonl'), raw([user('除外')]));
  const old = path.join(dir, 'old.jsonl'); fs.writeFileSync(old, raw([user('古い')])); fs.utimesSync(old, 0, 0);
  fs.writeFileSync(path.join(dir, 'broken.jsonl'), '壊れたログ');
  const result = collectUserBurdenMetrics({ home, transcriptPath: current });
  assert.equal(result.sessions, 2); assert.equal(result.roundTripsPerObjective, 1); assert.equal(result.maxRoundTrips, 2); assert.equal(result.maxRoundTripsSession, 'aaa'); assert.equal(result.repeatComplaints, 1);
  const lines = formatUserBurdenLines(result, 7).join('\n'); assert.match(lines, /平均 1.0回/); assert.match(lines, /今セッション: 往復 2回/);
  assert.equal(collectUserBurdenMetrics({ home: path.join(home, 'missing') }).sessions, 0);
});
