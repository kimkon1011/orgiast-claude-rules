import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-session-test-'));
process.env.ORGIAST_HOME = isolatedHome;
const { DEFAULT_REPO, loadConfig, detectHistoryCwd, parseHandoff, todoExclusionReason, filterTodos, pickCwd, buildChildArgs, buildPrompt, resolveClaudeExe, decideRun, markTodoDone, extractSessionId, transcriptPath, localDate, notificationLine } = await import('./auto-session.mjs');
const historyCwd = String.raw`c:\Users\example\Downloads\work`;
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
  const exists = () => false;
  assert.equal(pickCwd('案件Aを直す', exists, { 案件A: '/missing' }), DEFAULT_REPO);
  assert.equal(pickCwd('その他', exists, {}), DEFAULT_REPO);
});

test('pickCwd は注入された存在判定で候補と標準リポジトリを選ぶ', () => {
  const repo = '/repos/project-a';
  assert.equal(pickCwd('案件Aを直す', (candidate) => candidate === repo, { 案件A: repo }), repo);
  assert.equal(pickCwd('その他', () => true, {}), DEFAULT_REPO);
});

test('loadConfig は設定なし・破損時に空設定を返す', () => {
  assert.deepEqual(loadConfig('/home/x', () => { throw new Error('ENOENT'); }), { historyCwd: '', repoByKeyword: {} });
  assert.deepEqual(loadConfig('/home/x', () => '{broken'), { historyCwd: '', repoByKeyword: {} });
});

test('loadConfig は正常な設定を読む', () => {
  const config = loadConfig('/home/x', () => JSON.stringify({ historyCwd: '/history', repoByKeyword: { 案件A: '/repo-a' } }));
  assert.deepEqual(config, { historyCwd: '/history', repoByKeyword: { 案件A: '/repo-a' } });
});

function historyDeps(items, existing = new Set(items.map((item) => item.cwd))) {
  return {
    projectsDir: '/projects',
    listDirs: () => items.map((item) => `/projects/${item.bucket}`),
    newestTranscript: (bucket) => {
      const item = items.find((candidate) => bucket.endsWith(candidate.bucket));
      return { path: `${bucket}/latest.jsonl`, mtimeMs: item.mtimeMs };
    },
    readCwd: (file) => items.find((item) => file.includes(item.bucket)).cwd,
    exists: (candidate) => existing.has(candidate),
  };
}

test('detectHistoryCwd はバケット名と cwd スラッグが一致する最新候補を返す', () => {
  const cwd = '/Users/example/work';
  assert.equal(detectHistoryCwd(historyDeps([{ bucket: '-Users-example-work', cwd, mtimeMs: 2 }])), cwd);
});

test('detectHistoryCwd はドライブレターの大小を反転して既存バケットに合わせる', () => {
  const recorded = String.raw`C:\Users\example\Downloads\work`;
  const expected = String.raw`c:\Users\example\Downloads\work`;
  assert.equal(detectHistoryCwd(historyDeps([{ bucket: 'c--Users-example-Downloads-work', cwd: recorded, mtimeMs: 2 }], new Set([expected]))), expected);
});

test('detectHistoryCwd は実在しない候補を飛ばし、全滅時はリポジトリルートへ戻る', () => {
  const items = [
    { bucket: '-missing', cwd: '/missing', mtimeMs: 3 },
    { bucket: '-valid', cwd: '/valid', mtimeMs: 2 },
  ];
  assert.equal(detectHistoryCwd(historyDeps(items, new Set(['/valid']))), '/valid');
  assert.equal(detectHistoryCwd(historyDeps(items, new Set())), DEFAULT_REPO);
});

test('buildChildArgs は cwd が異なる場合だけ --add-dir を2つ渡す', () => {
  const repoCwd = String.raw`C:\repo`;
  const different = buildChildArgs(repoCwd, historyCwd);
  const same = buildChildArgs(repoCwd, repoCwd);
  assert.deepEqual(different.slice(-4), ['--add-dir', repoCwd, '--add-dir', historyCwd]);
  assert.equal(different.filter((arg) => arg === '--add-dir').length, 2);
  assert.equal(same.filter((arg) => arg === '--add-dir').length, 1);
  assert.deepEqual(same.slice(-2), ['--add-dir', repoCwd]);
  assert.equal(different.includes('--permission-mode'), false);
  assert.equal(same.includes('--permission-mode'), false);
});

test('buildChildArgs は呼び出し側で生成した session ID を渡す', () => {
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  const args = buildChildArgs('/repo', '/history', sessionId);
  assert.deepEqual(args.slice(-2), ['--session-id', sessionId]);
  assert.equal(args.includes('--permission-mode'), false);
});

test('resolveClaudeExe はバージョンを数値セグメントで比較する', () => {
  const oldExe = String.raw`C:\Users\x\.vscode\extensions\anthropic.claude-code-2.1.9-win32-x64\resources\native-binary\claude.exe`;
  const newExe = String.raw`C:\Users\x\.vscode\extensions\anthropic.claude-code-2.1.245-win32-x64\resources\native-binary\claude.exe`;
  assert.equal(resolveClaudeExe([oldExe, newExe]), newExe);
  assert.equal(resolveClaudeExe([]), 'claude');
});

test('resolveClaudeExe は任意のプラットフォーム接尾辞を扱い CLAUDE_CLI を優先する', () => {
  const darwin = '/Users/x/.vscode/extensions/anthropic.claude-code-2.2.1-darwin-arm64/resources/native-binary/claude';
  assert.equal(resolveClaudeExe([darwin]), darwin);
  assert.equal(resolveClaudeExe([darwin], '/opt/claude-custom'), '/opt/claude-custom');
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
    transcriptPath(String.raw`C:\Users\example\Downloads\repo`, sessionId),
    path.resolve(isolatedHome, '.claude', 'projects', 'C--Users-example-Downloads-repo', `${sessionId}.jsonl`),
  );
  assert.equal(transcriptPath(String.raw`C:\Users\example`, ''), '');
});

test('transcriptPath は小文字ドライブのバケットを維持する', () => {
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  assert.ok(transcriptPath(historyCwd, sessionId).includes('c--Users-example-Downloads-work'));
});

test('生成 UUID から stdout なしでも transcript パスを引ける', () => {
  const generatedUuid = '123e4567-e89b-42d3-a456-426614174000';
  const transcript = transcriptPath(historyCwd, generatedUuid);
  assert.ok(transcript.endsWith(`${generatedUuid}.jsonl`));
  assert.ok(transcript.includes('c--Users-example-Downloads-work'));
});

test('localDate は UTC 日付ではなく注入した Date のローカル日付を返す', () => {
  const fixed = new Date(2026, 7, 27, 3, 20, 0);
  assert.equal(localDate(fixed), '2026-08-27');
});

test('notificationLine は timeout 時に秘匿値を伏せた stderr 末尾を理由として一行で付ける', () => {
  const line = notificationLine({
    todo: '定期実行を検証', status: 'timeout', stdout: '',
    stderr: '前段\nAPI_TOKEN=super-secret\n次回発火を待機中',
    startedAt: '2026-08-27T00:00:00.000Z', endedAt: '2026-08-27T00:45:00.000Z',
    transcript: '/tmp/session.jsonl', resumeCommand: 'claude --resume uuid',
  });
  assert.ok(line.includes('| timeout |'));
  assert.ok(line.includes('| 理由:'));
  assert.ok(line.includes('次回発火を待機中'));
  assert.ok(!line.includes('super-secret'));
  assert.equal(line.includes('\n'), false);
});

test('buildPrompt は実リポジトリで git -C を使うよう指示する', () => {
  const repoCwd = String.raw`C:\Users\example\Downloads\repo`;
  const prompt = buildPrompt('実装する', {}, repoCwd, new Date('2026-08-26T00:00:00Z'));
  assert.ok(prompt.includes(`git -C ${repoCwd}`));
  assert.ok(prompt.includes(`--cwd ${repoCwd}`));
  assert.ok(prompt.indexOf('セッションの作業ディレクトリは履歴を揃えるため') < prompt.indexOf('実装本体は'));
  assert.ok(prompt.includes('外部の定期実行(cron/GitHub Actions のスケジュール)の次回発火を待つな'));
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
