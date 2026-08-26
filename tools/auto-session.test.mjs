import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-session-test-'));
process.env.ORGIAST_HOME = isolatedHome;
const { HISTORY_CWD, parseHandoff, todoExclusionReason, filterTodos, pickCwd, pickHistoryCwd, buildChildArgs, buildPrompt, resolveClaudeExe, decideRun, markTodoDone, extractSessionId, transcriptPath } = await import('./auto-session.mjs');
test.after(() => fs.rmSync(isolatedHome, { recursive: true, force: true }));

const sample = `前書き\n<!-- NEXT-SESSION v1 -->\n## 対象\nrepo A\n## 残TODO\n1. 実装する\n2. ~~完了済み~~\n3. 要判断: 色\n4. ブロック中: API\n## 完了条件\nテスト green\n<!-- NEXT-SESSION v1 -->\n## 残TODO\n1. 歴史上のTODO\n`;

test('parseHandoff は先頭ブロックだけから TODO と付帯セクションを抽出する', () => {
  const parsed = parseHandoff(sample);
  assert.deepEqual(parsed.todos, ['実装する', '~~完了済み~~', '要判断: 色', 'ブロック中: API']);
  assert.ok(parsed.block.includes('実装する'));
  assert.ok(!parsed.block.includes('歴史上のTODO'));
  assert.equal(parsed.sections['対象'], '## 対象\nrepo A');
  assert.equal(parsed.sections['完了条件'], '## 完了条件\nテスト green');
});

test('filterTodos は完了・判断待ち・未決・ブロック中を除外する', () => {
  assert.deepEqual(filterTodos(['実行', '~~完了~~', '要判断 X', '判断待ち X', '未決 X', 'ブロック中 X']), ['実行']);
});

test('todoExclusionReason は他セッションが着手中の項目を除外する', () => {
  assert.equal(todoExclusionReason('別セッションですでに着手した項目'), '他セッションが着手中');
  assert.equal(todoExclusionReason('この対応は着手中'), '他セッションが着手中');
  assert.equal(todoExclusionReason('担当者が作業中'), '他セッションが着手中');
  assert.equal(todoExclusionReason('別セッションで確認する'), '');
  assert.equal(todoExclusionReason('次回着手する'), '');
});

test('未来日の以降ゲートだけを固定日付基準で除外する', () => {
  const today = new Date(2026, 7, 26);
  assert.equal(todoExclusionReason('2026-08-27 以降に実行', today), '2026-08-27以降');
  assert.equal(todoExclusionReason('2026-08-26 以降に実行', today), '');
  assert.equal(todoExclusionReason('2026-08-25 以降に実行', today), '');
  assert.deepEqual(
    filterTodos(['今すぐ実行', '2026-08-27 以降に実行', '2026-08-26 以降に実行'], today),
    ['今すぐ実行', '2026-08-26 以降に実行'],
  );
});

test('pickCwd は実在しない判定先を既存の標準リポジトリへフォールバックする', () => {
  const fallback = path.resolve(import.meta.dirname, '..');
  const exists = () => false;
  assert.equal(pickCwd('ブース制作を直す', exists), fallback);
  assert.equal(pickCwd('aujustを直す', exists), fallback);
  assert.equal(pickCwd('その他', exists), fallback);
});

test('pickCwd は注入された存在判定で候補と標準リポジトリを選ぶ', () => {
  const booth = String.raw`C:\Users\uers\Downloads\ブース制作アプリ`;
  const rules = String.raw`C:\Users\uers\Downloads\orgiast-claude-rules`;
  assert.equal(pickCwd('ブース制作を直す', (candidate) => candidate === booth), booth);
  assert.equal(pickCwd('その他', (candidate) => candidate === rules), rules);
});

test('pickHistoryCwd は履歴 cwd が存在すれば小文字ドライブの固定パスを返す', () => {
  const repoCwd = String.raw`C:\Users\uers\Downloads\orgiast-claude-rules`;
  assert.equal(pickHistoryCwd((candidate) => candidate === HISTORY_CWD, repoCwd), HISTORY_CWD);
});

test('pickHistoryCwd は履歴 cwd が存在しなければ repoCwd へフォールバックする', () => {
  const repoCwd = String.raw`C:\Users\uers\Downloads\orgiast-claude-rules`;
  assert.equal(pickHistoryCwd(() => false, repoCwd), repoCwd);
});

test('buildChildArgs は cwd が異なる場合だけ --add-dir を2つ渡す', () => {
  const repoCwd = String.raw`C:\repo`;
  const different = buildChildArgs(repoCwd, HISTORY_CWD);
  const same = buildChildArgs(repoCwd, repoCwd);
  assert.deepEqual(different.slice(-4), ['--add-dir', repoCwd, '--add-dir', HISTORY_CWD]);
  assert.equal(different.filter((arg) => arg === '--add-dir').length, 2);
  assert.equal(same.filter((arg) => arg === '--add-dir').length, 1);
  assert.deepEqual(same.slice(-2), ['--add-dir', repoCwd]);
  assert.equal(different.includes('--permission-mode'), false);
  assert.equal(same.includes('--permission-mode'), false);
});

test('resolveClaudeExe はバージョンを数値セグメントで比較する', () => {
  const oldExe = String.raw`C:\Users\x\.vscode\extensions\anthropic.claude-code-2.1.9-win32-x64\resources\native-binary\claude.exe`;
  const newExe = String.raw`C:\Users\x\.vscode\extensions\anthropic.claude-code-2.1.245-win32-x64\resources\native-binary\claude.exe`;
  assert.equal(resolveClaudeExe([oldExe, newExe]), newExe);
  assert.equal(resolveClaudeExe([]), 'claude');
});

test('extractSessionId は正常な JSON から session_id を抽出する', () => {
  assert.equal(extractSessionId('{"session_id":"123e4567-e89b-42d3-a456-426614174000","result":"ok"}'), '123e4567-e89b-42d3-a456-426614174000');
});

test('extractSessionId はゴミや複数行が混ざっても最後の session_id を抽出する', () => {
  const stdout = 'warning\n{"session_id":"123e4567-e89b-42d3-a456-426614174000"}\nnoise {"session_id": "987e6543-e21b-42d3-a456-426614174999"}';
  assert.equal(extractSessionId(stdout), '987e6543-e21b-42d3-a456-426614174999');
});

test('extractSessionId は UUID が見つからなければ空文字を返す', () => {
  assert.equal(extractSessionId('{"session_id":"not-a-uuid"}\ngarbage'), '');
});

test('transcriptPath は Windows cwd をスラッグ化して隔離 HOME 配下の絶対パスを返す', () => {
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(
    transcriptPath(String.raw`C:\Users\uers\Downloads\orgiast-claude-rules`, sessionId),
    path.resolve(isolatedHome, '.claude', 'projects', 'C--Users-uers-Downloads-orgiast-claude-rules', `${sessionId}.jsonl`),
  );
  assert.equal(transcriptPath(String.raw`C:\Users\uers`, ''), '');
});

test('transcriptPath は小文字ドライブの既存 CLAUDE.md配布 バケットを指す', () => {
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  assert.ok(transcriptPath(HISTORY_CWD, sessionId).includes('c--Users-uers-Downloads-CLAUDE-md--'));
});

test('buildPrompt は実リポジトリで git -C を使うよう指示する', () => {
  const repoCwd = String.raw`C:\Users\uers\Downloads\orgiast-claude-rules`;
  const prompt = buildPrompt('実装する', {}, repoCwd, new Date('2026-08-26T00:00:00Z'));
  assert.ok(prompt.includes(`git -C ${repoCwd}`));
  assert.ok(prompt.includes(`--cwd ${repoCwd}`));
  assert.ok(prompt.indexOf('セッションの作業ディレクトリは履歴を揃えるため') < prompt.indexOf('実装本体は'));
});

test('decideRun は kill switch・有効ロック・stale lock を判定する', () => {
  assert.equal(decideRun({ disabled: true, lockExists: false }).run, false);
  assert.equal(decideRun({ disabled: false, lockExists: true, lockPid: 12, lockAgeMs: 1000, pidAlive: true }).run, false);
  assert.equal(decideRun({ disabled: false, lockExists: true, lockPid: 12, lockAgeMs: 7 * 60 * 60 * 1000, pidAlive: true }).run, true);
  assert.equal(decideRun({ disabled: false, lockExists: true, lockPid: 12, lockAgeMs: 1000, pidAlive: false }).run, true);
});

test('markTodoDone は先頭ブロックの該当行だけを変更する', () => {
  const changed = markTodoDone(sample, '実装する', '2026-08-26 完了（PR #42）');
  const expected = sample.replace('1. 実装する\n', '1. ~~実装する~~ → ✅ 2026-08-26 完了（PR #42）\n');
  assert.equal(changed, expected);
  assert.ok(changed.endsWith('1. 歴史上のTODO\n'));
});

const realShape = `<!-- NEXT-SESSION v1 -->
## 対象（今回の作業）
自動セッション
## 残TODO（次の1件を先頭に）
1. **複数行の実装を完了する**
   - 既存の挙動を維持する
   - Windows 実機でもテストする
2. ~~完了済みの作業~~
   補足は残っている
3. 〔ブロック中〕API待ち
4. 実行可能な別作業

## 完了条件（必須）
テスト green
`;

test('parseHandoff は実物形式の見出しと複数行 TODO を解析し、除外対象も保持する', () => {
  const parsed = parseHandoff(realShape);
  assert.ok(parsed.todos.length > 0);
  assert.deepEqual(parsed.todos, [
    '**複数行の実装を完了する**\n   - 既存の挙動を維持する\n   - Windows 実機でもテストする',
    '~~完了済みの作業~~\n   補足は残っている',
    '〔ブロック中〕API待ち',
    '実行可能な別作業',
  ]);
  assert.deepEqual(filterTodos(parsed.todos), [parsed.todos[0], '実行可能な別作業']);
  assert.equal(parsed.sections['対象'], '## 対象（今回の作業）\n自動セッション');
  assert.equal(parsed.sections['完了条件'], '## 完了条件（必須）\nテスト green');
});

test('markTodoDone は複数行 TODO の先頭行だけを完了表示にする', () => {
  const todo = parseHandoff(realShape).todos[0];
  const changed = markTodoDone(realShape, todo, '2026-08-26 完了（PR #42）');
  assert.ok(changed.includes('1. ~~**複数行の実装を完了する**~~ → ✅ 2026-08-26 完了（PR #42）\n   - 既存の挙動を維持する'));
  assert.ok(changed.includes('   - Windows 実機でもテストする'));
});
