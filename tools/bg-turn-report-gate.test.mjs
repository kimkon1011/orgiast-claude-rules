import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { judgeBgTurnReport } from './bg-turn-report-gate.mjs';
import { judgeNextAction } from './next-action-gate.mjs';

const now = Date.parse('2026-11-05T01:00:00Z');
const row = (role, content, extra = {}) => JSON.stringify({ type: role, message: { role, content }, ...extra });
const human = age => row('user', '作業を進めて', { timestamp: new Date(now - age).toISOString() });
const notice = row('user', '<task-notification>完了</task-notification>', { isMeta: true });
const report = row('assistant', [{ type: 'text', text: '成功。テスト17件合格。次はPRを作成します。' }]);
const call = (command = 'node tools/notify-kim.mjs --kind info "成功。テスト17件合格。次はPR作成"', extra = {}) => row('assistant', [
  { type: 'tool_use', name: 'Bash', id: 'notify', input: { command } },
], extra);
const receipt = (value = { delivered: 'session-inbox', id: 'item-1', kind: 'info' }, extra = {}) => row('user', [
  { type: 'tool_result', tool_use_id: 'notify', content: JSON.stringify(value), ...extra },
]);
const judge = (...rows) => judgeBgTurnReport(rows.join('\n'), { now });

test('通知後のtool-only応答は過去のテキストがあってもblock', () => {
  assert.equal(judge(human(60_000), report, notice, call(), receipt()).decision, 'block');
  assert.equal(judge(notice).decision, 'block');
});
test('通知後のテキストとinbox保存成功でpass', () => {
  assert.equal(judge(human(700_000), notice, report, call(), receipt()).decision, 'pass');
});
test('人のターンは対象外、通知後の人の入力でリセット', () => {
  assert.equal(judge(human(700_000), call()).decision, 'pass');
  assert.equal(judge(notice, human(0)).decision, 'pass');
});
test('stop_hook_activeは無限ループを防ぐ', () => {
  assert.equal(judgeBgTurnReport(notice, { stop_hook_active: true }).decision, 'pass');
  assert.equal(judgeNextAction('', notice, { stop_hook_active: true }).decision, 'pass');
});
test('10分以内はinboxのみ免除、境界超過・日時不明・未来日時は免除しない', () => {
  for (const age of [0, 599_999, 600_000]) assert.equal(judge(human(age), notice, report).decision, 'pass');
  for (const age of [600_001, -1]) assert.equal(judge(human(age), notice, report).decision, 'block');
  assert.equal(judge(row('user', '作業して'), notice, report).decision, 'block');
  assert.equal(judge(human(0), notice, call()).decision, 'block');
});
test('言及・未完了・失敗・抑制・DM送信はinbox保存の証拠にならない', () => {
  for (const evidence of [report, call(), call() + '\n' + receipt({}, { is_error: true }),
    call() + '\n' + receipt({ delivered: 'blocked' }), call() + '\n' + receipt({ delivered: 'dm', id: 'x', kind: 'info' }),
    call() + '\n' + receipt({ delivered: 'session-inbox', id: null, kind: 'info' })]) {
    assert.equal(judge(notice, report, evidence).decision, 'block');
  }
});
test('コマンドの引用・別ツール・sidechain・通知より前の証拠は不可', () => {
  for (const command of ['echo "node tools/notify-kim.mjs report"', 'node tools/notify-kim.mjs --help', 'cat tools/notify-kim.mjs']) {
    assert.equal(judge(notice, report, call(command), receipt()).decision, 'block');
  }
  assert.equal(judge(notice, report, call(undefined, { isSidechain: true }), receipt()).decision, 'block');
  assert.equal(judge(call(), receipt(), notice, report).decision, 'block');
  assert.equal(judge(notice, report, call(), receipt(), notice, report).decision, 'block');
});
test('WindowsのNodeパスとPowerShell scriptを認識する', () => {
  const command = '& "C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\tools\\notify-kim.mjs" "成功"';
  const ps = row('assistant', [{ type: 'tool_use', id: 'notify', name: 'PowerShell', input: { script: command } }]);
  assert.equal(judge(notice, report, ps, receipt()).decision, 'pass');
});
test('不正JSON・sidechain通知・引用・Stop feedbackで誤リセットしない', () => {
  assert.equal(judge('invalid\nnull', row('user', '例: <task-notification>完了')).decision, 'pass');
  assert.equal(judge(human(0), row('user', '<task-notification>完了', { isSidechain: true })).decision, 'pass');
  assert.equal(judge(notice, row('user', 'Stop hook feedback: 修正して')).decision, 'block');
});
test('既存StopフックCLIは空文と過去のテキストを素通ししない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-report-'));
  try {
    const transcript = path.join(dir, 'transcript.jsonl');
    for (const raw of [notice, [human(700_000), report, notice, call()].join('\n')]) {
      fs.writeFileSync(transcript, raw);
      const result = spawnSync(process.execPath, ['tools/next-action-gate.mjs'], {
        input: JSON.stringify({ transcript_path: transcript }), encoding: 'utf8',
        env: { ...process.env, ORGIAST_NEXT_ACTION_GATE: '1' }, timeout: 15_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).decision, 'block');
      assert.match(JSON.parse(result.stdout).reason, /バックグラウンドの結果/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
