import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./stop-gate-runner.mjs', import.meta.url));
const request = 'GitHub の画面で Merge をクリックしてください。';

function invoke(home, sessionId, text, extra = {}) {
  return spawnSync(process.execPath, [runner], {
    input: JSON.stringify({ session_id: sessionId, assistant_text: text, ...extra }),
    encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, ORGIAST_HANDOFF_AUDIT: 'off' },
  });
}

test('複数gateの理由を1つのblockへ合流する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-combined-'));
  const result = invoke(home, 'combined', request);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /### manual-request-fullsteps-gate[\s\S]*FULL-STEPS/);
  assert.match(output.reason, /### handoff-info-guard[\s\S]*HANDOFF-INFO-GUARD/);
  assert.match(output.reason, /ピギーバック・ヒント/);
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
  assert.ok(record.blockedBy.includes('manual-request-fullsteps-gate'));
  assert.ok(record.blockedBy.includes('handoff-info-guard'));
});

test('同一sessionの3回目はretry-capでpassする', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-cap-'));
  assert.equal(JSON.parse(invoke(home, 'cap', request).stdout).decision, 'block');
  assert.equal(JSON.parse(invoke(home, 'cap', request).stdout).decision, 'block');
  assert.equal(invoke(home, 'cap', request).stdout, '');
  const records = fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(records.map(({ verdict }) => verdict), ['block', 'block', 'retry-cap']);
});

test('stop_hook_activeは評価せずskippedでpassする', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-active-'));
  assert.equal(invoke(home, 'active', request, { stop_hook_active: true }).stdout, '');
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
  assert.equal(record.verdict, 'skipped');
  assert.deepEqual(record.reasonCodes, ['stop_hook_active']);
});

test('次の行があればピギーバック・ヒントを重ねない', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-hint-'));
  const output = JSON.parse(invoke(home, 'hint', `${request}\n次に kim がすること: Merge をクリック\nこの後の自動進行: kim のマージ後に Codex が確認してチャットで通知\nこのセッション: まだアーカイブしない（/session-close 未実行）`).stdout);
  assert.doesNotMatch(output.reason, /ピギーバック・ヒント/);
});

test('他gateがpassでもnext-action-gate単独でblockする', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-next-action-'));
  const text = '作業内容を整理し、関連箇所を確認しました。'.repeat(15);
  const output = JSON.parse(invoke(home, 'next-action-only', text).stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /### next-action-gate/);
  assert.doesNotMatch(output.reason, /ピギーバック・ヒント/);
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
  assert.deepEqual(record.blockedBy, ['next-action-gate']);
});

test('外部状態の否定断定を EXTERNAL-STATE で block する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-external-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const output = invoke(home, 'external', 'GA4 は存在しない可能性が高い');
  assert.equal(output.status, 0, output.stderr);
  const verdict = JSON.parse(output.stdout);
  assert.equal(verdict.decision, 'block');
  assert.match(verdict.reason, /\[EXTERNAL-STATE\]/);
});

test('assistant_text と transcript_path の併用でも直接照会証拠を読む', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-evidence-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'GA4 を確認して' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'gcloud projects list' } }] } },
  ].map(entry => JSON.stringify(entry)).join('\n'));
  const output = invoke(home, 'evidence', 'GA4 は存在しない', { transcript_path: transcript });
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stdout, '');
});

test('stdin経由の2行・3行・バックグラウンド矛盾を他gateと分離して検証', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-three-lines-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const body = '作業内容を整理し、関連箇所を確認しました。'.repeat(15);
  const footer = '次に kim がすること: なし\nこの後の自動進行: なし（完了）';
  const cases = [
    ['two-lines', `${body}\n${footer}`, 'NEXT-ACTION-FOOTER'],
    ['three-lines', `${body}\n${footer}\nこのセッション: アーカイブしてよい（/session-close 不要）`, null],
    ['background-close', `${body} Codex がバックグラウンドで実行中です。\n次に kim がすること: なし\nこの後の自動進行: 処理が完了したら私がこの画面で結果を報告します\nこのセッション: アーカイブしてよい（/session-close 実行済み）`, 'SESSION-BACKGROUND-CONTRADICTION'],
  ];
  for (const [id, text, code] of cases) {
    const result = invoke(home, id, text);
    assert.equal(result.status, 0, result.stderr);
    if (code) assert.equal(JSON.parse(result.stdout).decision, 'block');
    else assert.equal(result.stdout, '');
    const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8').trim().split('\n').at(-1));
    assert.equal(record.verdict, code ? 'block' : 'pass');
    assert.deepEqual(record.blockedBy, code ? ['next-action-gate'] : []);
    assert.deepEqual(record.reasonCodes, code ? [code] : []);
  }
});

test('runnerと単体hookの両方が会話のsession-close証拠を評価する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-close-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const transcript = path.join(home, 'transcript.jsonl');
  const text = `${'作業内容を整理し、関連箇所を確認しました。'.repeat(15)}\n次に kim がすること: なし\nこの後の自動進行: なし（完了）\nこのセッション: アーカイブしてよい（/session-close 実行済み）`;
  const gate = fileURLToPath(new URL('./next-action-gate.mjs', import.meta.url));
  for (const evidence of [false, true]) {
    fs.writeFileSync(transcript, [
      { type: 'user', message: { role: 'user', content: evidence ? '<command-name>/session-close</command-name>' : '/session-close 実行予定' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    ].map(entry => JSON.stringify(entry)).join('\n'));
    for (const target of [runner, gate]) {
      for (const directText of [false, true]) {
        const result = spawnSync(process.execPath, [target], {
          input: JSON.stringify({ session_id: `${evidence}-${directText}-${path.basename(target)}`, transcript_path: transcript, ...(directText ? { assistant_text: text } : {}) }),
          encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, ORGIAST_HANDOFF_AUDIT: 'off' },
        });
        assert.equal(result.status, 0, result.stderr);
        if (evidence) assert.equal(result.stdout, '');
        else {
          assert.equal(JSON.parse(result.stdout).decision, 'block');
          assert.match(JSON.parse(result.stdout).reason, /実行した形跡がありません/);
        }
      }
    }
  }
});

test('handoff-branch-coverage-gate: 初回決め打ちで既存分岐が無い手渡しを BRANCH-COVERAGE で block する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-branch-block-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = invoke(home, 'branch-block', '設定してください。\n1. 初回は新規に作成します。');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /### handoff-branch-coverage-gate[\s\S]*\[BRANCH-COVERAGE\][\s\S]*分岐:既存の場合/);
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
  assert.ok(record.blockedBy.includes('handoff-branch-coverage-gate'));
  // 必要性(fullsteps) → 分岐網羅(branch) の順で並ぶ。
  assert.ok(record.blockedBy.indexOf('manual-request-fullsteps-gate') < record.blockedBy.indexOf('handoff-branch-coverage-gate'));
});

test('handoff-branch-coverage-gate: 本流に既存分岐があれば他gateの結果に関わらず自分は block しない', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-branch-pass-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = invoke(home, 'branch-pass', '設定してください。\n1. 初回は新規に作成します。\n2. 既存の設定が表示されていたら、その設定を開きます。');
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
  assert.ok(!record.blockedBy.includes('handoff-branch-coverage-gate'));
  if (result.stdout) assert.doesNotMatch(JSON.parse(result.stdout).reason, /BRANCH-COVERAGE/);
});

test('handoff-branch-coverage-gate: 手作業依頼ではない完了報告では起動しない', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-branch-report-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = invoke(home, 'branch-report', '初回の run は success でした。完了しました。');
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
  assert.ok(!record.blockedBy.includes('handoff-branch-coverage-gate'));
  if (result.stdout) assert.doesNotMatch(JSON.parse(result.stdout).reason, /BRANCH-COVERAGE/);
});

test('gh-handoff-gate: gh が未認証であることを理由に PR 作成などを人に頼むと block する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-gh-block-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = invoke(home, 'gh-block', 'gh が未認証なので、PR の作成をお願いします');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /### gh-handoff-gate[\s\S]*\[GH-HANDOFF\]/);
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
  assert.ok(record.blockedBy.includes('gh-handoff-gate'));
});
