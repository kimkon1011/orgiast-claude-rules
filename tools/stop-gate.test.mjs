import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bumpState, pruneState, shouldBlock, shouldBlockProgressQuestion } from './stop-gate.mjs';

test('1 完了報告と箇条書きの残TODOをblock', () => assert.equal(shouldBlock('完了しました。\n残TODO:\n- A を直す\n- B を消す'), true));
test('2 残TODOなしはpass', () => assert.equal(shouldBlock('完了しました。残TODO: なし'), false));
test('3 TODO-NONEはエスケープ優先', () => assert.equal(shouldBlock('完了しました。\n残TODO:\n- A\n\n[TODO-NONE]'), false));
test('4 質問で終わる場合はpass', () => assert.equal(shouldBlock('完了しました。\n残TODO:\n- A\nこれで進めて良いですか？'), false));
test('5 完了報告でなければpass', () => assert.equal(shouldBlock('調査中です'), false));
test('6 見出し後に箇条書きがなければpass', () => assert.equal(shouldBlock('完了しました。残TODO は特にありません'), false));
test('7 3回連続block後の4回目はblockしない', () => {
  let state = {};
  for (let i = 0; i < 3; i++) {
    const result = bumpState(state, 'session', true, new Date('2026-08-30T00:00:00Z'));
    assert.equal(result.blocked, true);
    state = result.state;
  }
  const fourth = bumpState(state, 'session', true, new Date('2026-08-30T00:00:00Z'));
  assert.equal(fourth.blocked, false);
});
test('8 途中で通したら連続カウントが0に戻る', () => {
  const first = bumpState({}, 'session', true, new Date('2026-08-30T00:00:00Z'));
  const passed = bumpState(first.state, 'session', false, new Date('2026-08-30T00:01:00Z'));
  assert.equal(passed.state.session.consecutive, 0);
});
test('9 24時間以上古いエントリを捨てる', () => {
  const state = {
    old: { consecutive: 2, updatedAt: '2026-08-28T23:59:59Z' },
    exact: { consecutive: 3, updatedAt: '2026-08-29T00:00:00Z' },
    fresh: { consecutive: 1, updatedAt: '2026-08-29T00:00:01Z' },
  };
  assert.deepEqual(pruneState(state, new Date('2026-08-30T00:00:00Z')), { fresh: state.fresh });
});
test('10 末尾がtool_useだけでも手前の本文で判定する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-tool-tail-'));
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '完了しました。\n残TODO:\n- A を直す' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'true' } }] } }),
  ].join('\n'));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./stop-gate.mjs', import.meta.url))], {
    input: JSON.stringify({ session_id: 'tool-tail', transcript_path: transcript }), encoding: 'utf8',
    env: { ...process.env, ORGIAST_HOME: home, ORGIAST_STOP_GATE: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, 'block');
  const ledger = fs.readFileSync(path.join(home, '.claude', 'stop-gate-ledger.jsonl'), 'utf8');
  assert.equal(JSON.parse(ledger).kind, 'remaining-todo');
});

test('11 承認不要の実装質問をblock', () => assert.equal(shouldBlockProgressQuestion('完了しました。実装しますか。'), true));
test('12 推奨案への着手質問をblock', () => assert.equal(shouldBlockProgressQuestion('①から着手するのが良いと思いますが、進めますか？'), true));
test('13 記憶への記録質問をblock', () => assert.equal(shouldBlockProgressQuestion('この判断根拠を記憶に残しておきますか。'), true));
test('14 本番デプロイの承認質問はpass', () => assert.equal(shouldBlockProgressQuestion('このまま本番にデプロイしますか？'), false));
test('15 マージの承認質問はpass', () => assert.equal(shouldBlockProgressQuestion('PR #192 をマージしていいですか？'), false));
test('16 先方への送信承認質問はpass', () => assert.equal(shouldBlockProgressQuestion('先方に送信してよいですか？'), false));
test('17 user固有の価格確認はpass', () => assert.equal(shouldBlockProgressQuestion('梅の価格は60万円でよいですか？'), false));
test('18 疑問文でない完了報告はpass', () => assert.equal(shouldBlockProgressQuestion('実装と検証が完了しました。'), false));
test('19 STOP-OKを含む質問はpass', () => assert.equal(shouldBlockProgressQuestion('理由を確認する必要があります。進めますか？ [STOP-OK]'), false));
test('20 空文字はpass', () => assert.equal(shouldBlockProgressQuestion(''), false));
test('21 既存の完了報告と残TODO判定は維持', () => assert.equal(shouldBlock('完了しました。\n残TODO:\n- A を直す'), true));

test('22 CLIは承認不要の質問をblockしSTOP-OKを案内する（末尾tool_useも許容）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-progress-cli-'));
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '作業を確認しました。実装しますか。' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'true' } }] } }),
  ].join('\n'));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./stop-gate.mjs', import.meta.url))], {
    input: JSON.stringify({ session_id: 'progress-cli', transcript_path: transcript }), encoding: 'utf8',
    env: { ...process.env, ORGIAST_HOME: home, ORGIAST_STOP_GATE: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /\[STOP-OK\]/);
  const ledger = fs.readFileSync(path.join(home, '.claude', 'stop-gate-ledger.jsonl'), 'utf8');
  assert.equal(JSON.parse(ledger).kind, 'progress-question');
});

test('23 CLIは本番デプロイの承認質問をpass', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-gate-consent-cli-'));
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'このまま本番にデプロイしますか？' }] } }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./stop-gate.mjs', import.meta.url))], {
    input: JSON.stringify({ session_id: 'consent-cli', transcript_path: transcript }), encoding: 'utf8',
    env: { ...process.env, ORGIAST_HOME: home, ORGIAST_STOP_GATE: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
