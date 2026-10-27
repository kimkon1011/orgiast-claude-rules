import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run } from './stop-gate-runner.mjs';

const runner = fileURLToPath(new URL('./stop-gate-runner.mjs', import.meta.url));

// invoke() は process.env を子プロセスへそのまま渡す。自動セッション（CLAUDE_HEADLESS=1）の中で
// 走らせると規則が伝播し、AUTOPILOT-NO-SESSION-WAKEUP の検査がskipされて「起床手段が無いのに
// 通る」ケースが落ちる（2026-10-25 実測）。このファイルは通常セッションの判定を検証するので外す。
delete process.env.CLAUDE_HEADLESS;
const request = 'GitHub の画面で Merge をクリックしてください。';

function invoke(home, sessionId, text, extra = {}) {
  return spawnSync(process.execPath, [runner], {
    input: JSON.stringify({ session_id: sessionId, assistant_text: text, ...extra }),
    encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, ORGIAST_HANDOFF_AUDIT: 'off', ORGIAST_HOSTNAME: 'kim-PC' },
  });
}

test('複数gateの理由を1つのblockへ合流する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-combined-'));
  const result = invoke(home, 'combined', request);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  // 形式ゲートは仕様変更により単一セクションの箇条書きへまとめる。
  assert.match(output.reason, /- manual-request-fullsteps-gate[\s\S]*FULL-STEPS/);
  assert.match(output.reason, /- handoff-info-guard[\s\S]*HANDOFF-INFO-GUARD/);
  assert.match(output.reason, /ピギーバック・ヒント/);
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
  assert.ok(record.blockedBy.includes('manual-request-fullsteps-gate'));
  assert.ok(record.blockedBy.includes('handoff-info-guard'));
});

test('同一ターンは既存上限の3回目からpass_after_capを台帳に残す', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-cap-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(JSON.parse(invoke(home, 'cap', request).stdout).decision, 'block');
  assert.equal(JSON.parse(invoke(home, 'cap', request).stdout).decision, 'block');
  assert.match(JSON.parse(invoke(home, 'cap', request).stdout).systemMessage, /次の応答で必ず訂正.*残存コード/);
  const records = fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(records.map(({ verdict }) => verdict), ['block', 'block', 'pass_after_cap']);
  assert.deepEqual(records.map(({ sameTextRetries }) => sameTextRetries), [1, 2, 3]);
  const state = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-state.json'), 'utf8'));
  assert.equal(state.cap.blocks, 3);
  assert.equal(state.cap.lastHash, crypto.createHash('sha256').update(request).digest('hex').slice(0, 16));
});

for (const [name, texts, counts] of [
  ['本文A・Bは同一ターンのblockとして累積', [request, `${request} B`], [1, 2]],
  ['本文変更を含め3回目は上限通過', [request, request, `${request} B`], [1, 2, 3]],
]) {
  test(name, t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-reset-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    for (const [index, text] of texts.entries()) {
      const result = invoke(home, 'reset', text);
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      if (counts.at(-1) === 3 && index === texts.length - 1) assert.match(output.systemMessage, /次の応答で必ず訂正/);
      else assert.equal(output.decision, 'block');
    }
    const records = fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(record => record.sameTextRetries), counts);
    assert.equal(records.filter(record => record.retryCap).length, counts.at(-1) === 3 ? 1 : 0);
  });
}

test('block不要ならstateを作成・変更せず、sessionIdなしでも変更しない', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-no-write-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateFile = path.join(home, '.claude', 'stop-gate-runner-state.json');
  const passText = '次に kim がすること: なし';
  assert.equal(invoke(home, 'pass', passText).stdout, '');
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(JSON.parse(invoke(home, 'pass', request).stdout).decision, 'block');
  const before = fs.readFileSync(stateFile, 'utf8');
  const mtime = fs.statSync(stateFile).mtimeMs;
  assert.equal(invoke(home, 'pass', passText).stdout, '');
  assert.equal(JSON.parse(invoke(home, '', request).stdout).decision, 'block');
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  assert.equal(fs.statSync(stateFile).mtimeMs, mtime);
  const records = fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records[2].verdict, 'pass');
  assert.equal(records[2].sameTextRetries, 0);
});

test('書き込み時に7日超・不正日時を削除し、旧形式の累計はリセットする', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-prune-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stateFile = path.join(home, '.claude', 'stop-gate-runner-state.json');
  const now = Date.now();
  const recent = { blocks: 2, lastTs: new Date(now - 6 * 86400000).toISOString(), lastHash: 'other' };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    old: { blocks: 2, lastTs: new Date(now - 8 * 86400000).toISOString() },
    invalid: { lastTs: 'invalid' }, missing: {}, recent,
    legacy: { blocks: 99, lastTs: new Date(now).toISOString() },
  }));
  const result = invoke(home, 'legacy', request);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, 'block');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(Object.keys(state).sort(), ['legacy', 'recent']);
  assert.deepEqual(state.recent, recent);
  assert.equal(state.legacy.blocks, 1);
  assert.ok(Date.parse(state.legacy.lastTs) >= now);
});

test('stop_hook_activeでも書き直しを再評価する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-active-'));
  assert.equal(JSON.parse(invoke(home, 'active', request, { stop_hook_active: true }).stdout).decision, 'block');
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
  assert.equal(record.verdict, 'block');
  assert.ok(record.reasonCodes.length > 0);
});

test('次の行があればピギーバック・ヒントを重ねない', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-hint-'));
  const output = JSON.parse(invoke(home, 'hint', `${request}\n次に kim がすること: Merge をクリック\nこの後の自動進行: kim のマージ後に Codex が確認してチャットで通知\nこのセッション: まだ閉じない（作業中・2099-12-31 23:59 まで待つ）`).stdout);
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
  const output = invoke(home, 'evidence', 'GA4 は存在しない\n次に kim がすること: なし\nこの後の自動進行: なし（完了）\nこのセッション: /session-close は不要なので、このセッションを閉じてよい', { transcript_path: transcript });
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
    ['three-lines', `${body}\n${footer}\nこのセッション: /session-close は不要なので、このセッションを閉じてよい`, null],
    ['background-close', `${body} Codex がバックグラウンドで実行中です。\n次に kim がすること: なし\nこの後の自動進行: 処理が完了したら私がこの画面で結果を報告します\nこのセッション: /session-close は終わっているので、このセッションを閉じてよい`, 'SESSION-BACKGROUND-CONTRADICTION'],
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
  const text = `${'作業内容を整理し、関連箇所を確認しました。'.repeat(15)}\n次に kim がすること: なし\nこの後の自動進行: なし（完了）\nこのセッション: /session-close は終わっているので、このセッションを閉じてよい`;
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
          encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, ORGIAST_HANDOFF_AUDIT: 'off', ORGIAST_HOSTNAME: 'kim-PC' },
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
  assert.match(output.reason, /- handoff-branch-coverage-gate[\s\S]*\[BRANCH-COVERAGE\][\s\S]*分岐:既存の場合/);
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

// 単体判定と実際の Stop ランナーの両方で同じケースを検証する。
import { judgeUserBurden } from './user-burden-gate.mjs';
const burdenAudit = '手間監査: CLI を試したが OAuth の本人同意が必要。user は1クリック・年1回。';
const burdenCommand = '```powershell\nStart-Process https://example.com/consent\n```';
const desktopPath = 'C:\\Users\\日本語 user\\OneDrive\\Desktop\\登録（ダブルクリック）.cmd';
const desktopAudit = '手間監査: ①Claude の実行は classifier に拒否。②MCP を試したが権限不足で失敗。user は1操作。';
// 形式検査の既存ケースは明示的な操作依頼に揃える（報告・返信は新仕様で降格するため）。
const burdenCases = [
  ['pwsh 単独は block', `実行してください。\n\`\`\`pwsh\npwsh -File task.ps1\n\`\`\`\n${burdenAudit}`, true, /make-desktop-launcher/],
  ['Desktop cmd と二経路の監査', `次に kim がすること: ダブルクリックする\n${desktopPath}\n${desktopAudit}`, false],
  ['Desktop cmd だけは監査不足', `次に kim がすること: ダブルクリックする\n${desktopPath}\n${burdenAudit}`, true, /①Claude/],
  ['Claude 自身の実行説明', 'Claude 自身が実行しました。\n```pwsh\npwsh -File task.ps1\n```', false],
  ['遡り参照の実例', '次に kim がすること: 前に送った PowerShell の1行を実行してください', true, /遡り参照/],
  ['コマンドと監査だけでは不可', `次に kim がすること: PowerShell で実行してください\n${burdenCommand}\n${burdenAudit}`, true, /make-desktop-launcher/],
  ['完成品なし', `次に kim がすること: 同意ボタンを押す\n${burdenAudit}`, true, /完成品/],
  ['監査なし', `次に kim がすること: PowerShell で実行してください\n${burdenCommand}`, true, /手間監査/],
  ['依頼なし', '次に kim がすること: なし', false],
  ['理由付き例外', '次に kim がすること: ケーブルを挿す\n[BURDEN-OK] 物理作業で渡すファイルがないため。', false],
  ['本文だけの依頼', 'リンクを開いてください。', true, /完成品/],
  ['なしでも本文に依頼', 'ボタンを押してください。\n次に kim がすること: なし', true, /完成品/],
  ['監査に根拠なし', '次に kim がすること: 同意ボタンを押す\nhttps://example.com\n手間監査: こちらでは無理。1クリック。', true, /手間監査/],
  ['監査に操作回数なし', '次に kim がすること: 同意ボタンを押す\nhttps://example.com\n手間監査: OAuth 本人同意のため。', true, /手間監査/],
  ['根拠は同じ監査行に必要', '次に kim がすること: 同意ボタンを押す\nhttps://example.com\n手間監査: 1クリック\nOAuth 本人同意のため。', true, /手間監査/],
  ['理由なしの例外は無効', '次に kim がすること: 実行してください\n[BURDEN-OK]', true],
  ['URL同梱', `次に kim がすること: 本人同意ボタンを押す\nhttps://example.com/consent\n${burdenAudit}`, false],
  ['Desktopファイルパスは完成品でない', `次に kim がすること: ショートカットを開く\nC:\\Users\\kim\\Desktop\\consent.lnk\n${burdenAudit}`, true, /Google Drive/],
  ['コード中の依頼では発火しない', '```text\n次に kim がすること: 実行してください\n```\n修正済みです。', false],
  ['コード中の監査は無効', `次に kim がすること: 同意ボタンを押す\n\`\`\`text\n${burdenAudit}\n\`\`\``, true, /手間監査/],
  ['通常報告の参照は対象外', '以前のファイルを修正しました。\n次に kim がすること: なし（完了）', false],
];
for (const prefix of ['前に送った', '先ほどの', 'さっきの', '上の', '前述の', '以前の', '前回の']) {
  burdenCases.push([`${prefix}の参照`, `次に kim がすること: ${prefix}コマンドを実行してください\n${burdenCommand}\n${burdenAudit}`, true, /遡り参照/]);
}
for (const [name, text, blocked, reason] of burdenCases) {
  test(`user-burden-gate: ${name}`, t => {
    const judged = judgeUserBurden(text);
    assert.equal(judged.decision, blocked ? 'block' : 'pass');
    if (reason) assert.match(judged.reason, reason);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-burden-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const result = invoke(home, 'burden', text);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
    assert.equal(record.blockedBy.includes('user-burden-gate'), blocked);
    assert.ok(!record.reasonCodes.includes('error:user-burden-gate'));
    if (blocked) assert.match(JSON.parse(result.stdout).reason, /- user-burden-gate[\s\S]*USER-BURDEN/);
  });
}

test('user-burden-gate: transcript の最後の assistant だけを監査する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-burden-transcript-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const transcript = path.join(home, 'transcript.jsonl');
  const bad = '次に kim がすること: 前に送った PowerShell の1行を実行してください';
  const good = '次に kim がすること: なし';
  for (const [index, texts] of [[bad, good], [good, bad]].entries()) {
    fs.writeFileSync(transcript, texts.map(text => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })).join('\n'));
    const result = invoke(home, `transcript-${index}`, undefined, { transcript_path: transcript });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8').trim().split('\n').at(-1));
    assert.equal(record.blockedBy.includes('user-burden-gate'), index === 1);
  }
});

test('desktop handoff does not require the old three-step paste instructions', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-desktop-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = invoke(home, 'desktop', `ダブルクリックしてください。\n${desktopPath}\n${desktopAudit}`);
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8').trim());
  assert.ok(!record.blockedBy.includes('manual-request-fullsteps-gate'));
  assert.ok(!record.blockedBy.includes('user-burden-gate'));
});

test('user command request from transcript is passed to burden gate', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-command-request-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'コマンドを教えて' } }) + '\n');
  const result = invoke(home, 'command-request', `実行してください。\n${burdenCommand}\n${burdenAudit}`, { transcript_path: transcript });
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8').trim());
  assert.ok(!record.blockedBy.includes('user-burden-gate'));
});

// session-close SKILL.md §7.1: 閉じ際の3行（close-session.mjs 実行 → 新タブで Enter → このタブを ✕、/clear は使わない）
// は、それ自体が user への次の一手の指示。runner は手渡し系ゲートを適用せず pass させる
// （適用するとルール通りに閉じるだけで余分な1ターンが発生し、ログの書き戻しで退避済みセッションが一覧に復活する）。
const closeSteps = `本セッションの作業は完了しました。PR #585 は main に取り込まれ、回帰テストも 30 pass / 0 fail です。\n\nそれでは閉じます。次の順でお願いします。\n\n1. 私（Claude）が close-session.mjs --session abc123 を実行します（これがこのタブへの最後の送信です）\n2. kim さんは、自動で開いた新しいタブで Enter を1回押してください\n3. 続けて、この古いタブを ✕ で閉じてください。**/clear は使わないでください**\n\n理由: タブが開いている限りプロセスが会話ログを書き戻し、退避したはずのセッションが一覧に復活します。だから 1→2→3 の順で、3 の後にこのタブへ話しかけないでください。`;

test('§7.1の閉じ際3行は手渡し系gateをすべて通す', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-close-steps-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = invoke(home, 'close-steps', closeSteps);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8').trim());
  assert.equal(record.verdict, 'pass');
  assert.deepEqual(record.reasonCodes, ['close-steps']);
});

test('§7.1の3語に言及しただけの番号無し長文は従来どおりblockする', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-close-mention-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const mention = `GitHub の画面で Merge をクリックしてください。close-session.mjs と ✕ と /clear の扱いは別途レポートします。${'補足の説明。'.repeat(12)}`;
  const output = JSON.parse(invoke(home, 'close-mention', mention).stdout);
  assert.equal(output.decision, 'block');
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8').trim());
  assert.notDeepEqual(record.reasonCodes, ['close-steps']);
});

test('handoff-action-gate が stop-gate-runner 配線で動くことを確認', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-handoff-action-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'Yahooメールを確認してください' } },
  ].map(entry => JSON.stringify(entry)).join('\n'));
  const text = 'Yahoo メールを見てください。IMAP に接続できません。認証情報がありません。';
  const result = invoke(home, 'action-gate-test', text, { transcript_path: transcript });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, 'block');
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.ok(record.blockedBy.includes('handoff-action-gate'));
});

test('完了報告の引用に反応した形式gateは台帳だけに降格する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-demoted-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = invoke(home, 'done', '修正が完了しました。\n> 次に kim がすること: 実行してください\n次に kim がすること: 完了報告のみ');
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
  assert.equal(record.handoffKind, 'none'); assert.ok(record.demoted.includes('manual-request-fullsteps-gate')); assert.ok(record.demoted.includes('user-burden-gate'));
  assert.ok(!record.blockedBy.includes('manual-request-fullsteps-gate')); assert.doesNotMatch(result.stdout, /FULL-STEPS/);
});

test('Sheets書き込み後に第三者へ再送を頼むとhandoff-action-gateでblockする', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-restore-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'フォーム回答を確認してください' } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'mcp__booth___debug_writeAndRead', input: { ssId: 'sheet', a1Cell: 'A1', formula: '="test"' } },
    ] } },
  ].map(entry => JSON.stringify(entry)).join('\n'));
  const text = '上書きして消してしまいました。私の側からは元に戻せません。\n> お心当たりがあれば、もう一度フォームから送っていただけますか。';
  const result = invoke(home, 'restore-gate-test', text, { transcript_path: transcript });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, 'block');
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.ok(record.blockedBy.includes('handoff-action-gate'));
});
test('返信1回の依頼ではFULL-STEPSとUSER-BURDENを出さない', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-reply-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = invoke(home, 'reply', '一言返信してください。\n次に kim がすること: 返信してください');
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
  assert.equal(record.handoffKind, 'reply-only'); assert.ok(record.demoted.includes('manual-request-fullsteps-gate')); assert.ok(record.demoted.includes('user-burden-gate'));
  assert.doesNotMatch(result.stdout, /FULL-STEPS|USER-BURDEN/);
});

test('恒久策必須は返信のみでも形式gateと一緒に降格しない', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-permanent-fix-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const text = '一言返信してください。\n次に kim がすること: 返信してください\nこの後の自動進行: なし（完了）\nこのセッション: /session-close は不要なので、このセッションを閉じてよい';
  const result = invoke(home, 'permanent-fix', text);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /### next-action-gate[\s\S]*恒久策:/);
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
  assert.equal(record.handoffKind, 'reply-only');
  assert.ok(record.demoted.includes('user-burden-gate'));
  assert.ok(!record.demoted.includes('next-action-gate'));
  assert.ok(record.blockedBy.includes('next-action-gate'));
  assert.ok(record.reasonCodes.includes('PERMANENT-FIX-REQUIRED'));
});
test('MacroDroidの検索不足を先に示し形式は1セクションにまとめる', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-past-log-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const transcript_path = path.join(home, 't.jsonl'); fs.writeFileSync(transcript_path, JSON.stringify({ type: 'user', message: { content: 'MacroDroid を使いたい' } }));
  const result = invoke(home, 'manual', 'MacroDroid を開いてください。', { transcript_path });
  const output = JSON.parse(result.stdout);
  assert.match(output.reason, /^### past-log-search-gate/);
  assert.equal((output.reason.match(/### 手渡しの形式/g) || []).length, 1);
  assert.match(output.reason, /- manual-request-fullsteps-gate:/); assert.match(output.reason, /- user-burden-gate:/);
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
  assert.ok(record.blockedBy.includes('past-log-search-gate')); assert.deepEqual(record.demoted, []);
});

test('副作用の告知だけならStopで差し戻し、直後に対処を書けば通る', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-side-effect-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const text = '営業アプリは GitHub 通知を取り込まなくなる。';
  const result = invoke(home, 'side-effect', text);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /side-effect-left-gate[\s\S]*\[SIDE-EFFECT\]/);
  const repaired = invoke(home, 'side-effect', `${text}\n取り込み条件を修正済み、回帰テスト成功。`);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(repaired.stdout, '');
});

test('完了待ちと将来作業をStopで差し戻し、完了報告なら通す', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-deferral-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = invoke(home, 'deferral', '営業アプリは GitHub 通知を取り込まなくなる。\nCodex の実装完了を待っています（終わると通知が来ます）。');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /### deferral-wait-gate/);
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
  assert.ok(record.reasonCodes.includes('DEFERRAL-WAIT'));
  assert.ok(record.blockedBy.includes('side-effect-left-gate'));
  assert.equal(record.blockedBy.indexOf('deferral-wait-gate'), record.blockedBy.indexOf('side-effect-left-gate') + 1);
  const repaired = invoke(home, 'deferral', '作業はすべて完了しました。テストは全件 PASS、本番反映済みです。');
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(repaired.stdout, '');
});

test('自動進行の起床手段をtranscript_pathから検査しsubagentsは免除する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-wakeup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const text = '確認を続けます。\n次に kim がすること: なし\nこの後の自動進行: 私が毎時進捗を確認して変化時に報告します\nこのセッション: まだ閉じない（作業中・2099-12-31 23:59 まで待つ）';
  for (const [name, raw, subagent, blocked] of [
    ['missing', '', false, true],
    ['cron', JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'CronCreate', input: { cron: '17 * * * *' } }] } }), false, true],
    ['add-check', JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node tools/auto-progress.mjs --add-check --session s --check "cmd" --deadline +24h --label "l"' } }] } }), false, false],
    ['subagent', '', true, false],
  ]) {
    const dir = subagent ? path.join(home, 'subagents') : home;
    fs.mkdirSync(dir, { recursive: true });
    const transcript_path = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(transcript_path, raw);
    const result = invoke(home, name, text, { transcript_path });
    assert.equal(result.status, 0, result.stderr);
    const records = fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.at(-1).reasonCodes.includes('AUTOPILOT-NO-SESSION-WAKEUP'), blocked, result.stdout);
  }
});

test('先行ゲートが全て降格された場合は第2段の監査で手渡しを止める', async t => {
  // f94ee7a（2026-10-23T02:24:55Z）の再発防止。regex-blocked で第2段を飛ばした後に
  // policy/demote で block が0件になると、手渡しが無検査で通っていた。原文の先送り
  // （2026-10-23T02:25:45.629Z / 7e3e8cde）が「修正が本番で効いたか」を次回へ回した分を、
  // ここでは実際に第2段が走って block することを固定する。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-second-'));
  const previousHome = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.ORGIAST_HOME;
    else process.env.ORGIAST_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  // 手渡しは reply-only（manual-steps ではない）ので FORM_GATES は全て降格される。
  // 第1段は regex で skipped='regex-blocked'、残る block が0件のとき第2段だけが止められる。
  const text = [
    '本文です。結果をまとめました。',
    '',
    '恒久策: 一回限り: この判断だけは kim に確認する。',
    '',
    '次に kim がすること: A案とB案のどちらを選ぶか教えてください。',
    'この後の自動進行: なし',
    'このセッション: /session-close は不要なので、このセッションを閉じてよい',
  ].join('\n');
  const asks = [];
  const ask = async ({ provider }) => {
    asks.push(provider);
    return { text: JSON.stringify({ verdict: 'block', violations: [{ rule: 3, quote: 'A案とB案のどちらを選ぶか教えてください', fix: '推奨案を自分で決めて当ターン内に実行する' }], learned: [] }) };
  };
  const result = await run(
    { session_id: 'second-stage', assistant_text: text },
    { assistantText: text, humanText: '', raw: '' },
    { mode: 'block', ask, home },
  );
  assert.equal(asks.length, 1, '第2段の監査が1回だけ走る');
  assert.equal(result.record.verdict, 'block');
  assert.deepEqual(result.record.blockedBy, ['handoff-audit-gate']);
});
