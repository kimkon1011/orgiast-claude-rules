import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-session-test-'));
process.env.ORGIAST_HOME = isolatedHome;
const { DEFAULT_REPO, localDate, loadConfig, detectHistoryCwd, parseHandoff, todoExclusionReason, filterTodos, pickCwd, buildChildArgs, buildPrompt, buildFeedbackPrompt, feedbackIssueExclusionReason, filterFeedbackIssues, feedbackNotifyUrl, normalizeGitHubRepo, feedbackRepoCwd, resolveClaudeExe, decideRun, markTodoDone, extractSessionId, transcriptPath, recoverSessionId, appendClosedSession, formatResultLine } = await import('./auto-session.mjs');
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

test('フォーム報告用プロンプトは TODO 用と分離し、PR をマージしない制約を含む', () => {
  const issue = { number: 42, title: '保存できない', url: 'https://github.com/acme/app/issues/42', body: '保存ボタンが反応しません' };
  const prompt = buildFeedbackPrompt(issue, 'acme/app', '/repos/app', '/tmp/feedback.summary.md', 60);
  assert.ok(prompt.includes('社員がアプリ内フォームから報告'));
  assert.ok(prompt.includes('PR をマージしない'));
  assert.ok(prompt.includes('本番へデプロイしない'));
  assert.ok(prompt.includes('main へ直接 push しない'));
  assert.ok(prompt.includes('Closes #42'));
  assert.ok(prompt.includes('推測で実装しない'));
  assert.ok(prompt.includes('PRタイトル: <タイトル>'));
});

test('in-progress ラベル付き Issue はフォーム報告の対象から除外する', () => {
  const available = { number: 1, labels: [{ name: 'feedback' }] };
  const active = { number: 2, labels: [{ name: 'feedback' }, { name: 'in-progress' }] };
  assert.equal(feedbackIssueExclusionReason(active), 'in-progress（対応中）');
  assert.deepEqual(filterFeedbackIssues([available, active]), [available]);
});

test('通知URLは feedback-intake を notify に置き換え、query を捨てる', () => {
  assert.equal(feedbackNotifyUrl('https://relay.example/api/feedback-intake?pending=1'), 'https://relay.example/api/notify');
  assert.equal(feedbackNotifyUrl('not a url'), '');
});

test('GitHub remote URL は形式・末尾・大文字小文字の差を owner/repo に正規化する', () => {
  assert.equal(normalizeGitHubRepo('https://github.com/owner/repo.git'), 'owner/repo');
  assert.equal(normalizeGitHubRepo('git@github.com:owner/repo'), 'owner/repo');
  assert.equal(normalizeGitHubRepo('https://github.com/owner/repo/'), 'owner/repo');
  assert.equal(normalizeGitHubRepo('HTTPS://GITHUB.COM/Owner/Repo.GIT/'), 'owner/repo');
});

test('feedbackRepoCwd は不一致 remote を飛ばして一致する既存作業ツリーを選ぶ', () => {
  const root = '/repos';
  const wrong = path.join(root, 'wrong-folder');
  const matched = path.join(root, '日本語フォルダ');
  const io = {
    readdir: () => [
      { name: 'wrong-folder', isDirectory: () => true },
      { name: '日本語フォルダ', isDirectory: () => true },
    ],
    exists: (candidate) => candidate === path.join(wrong, '.git') || candidate === path.join(matched, '.git'),
    remoteUrl: (candidate) => ({
      status: 0,
      stdout: candidate === wrong ? 'git@github.com:other/repo.git' : 'https://github.com/Owner/Repo.git',
    }),
  };
  assert.equal(feedbackRepoCwd('owner/repo', { roots: [root], io }), matched);
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
  assert.equal(different[different.indexOf('--model') + 1], 'sonnet');
});

test('buildChildArgs は環境変数で無人実行モデルを上書きできる', () => {
  process.env.ORGIAST_AUTO_SESSION_MODEL = 'haiku';
  try {
    const args = buildChildArgs('C:\\repo', 'C:\\repo');
    assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  } finally { delete process.env.ORGIAST_AUTO_SESSION_MODEL; }
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

test('buildPrompt は実リポジトリで git -C を使うよう指示する', () => {
  const repoCwd = String.raw`C:\Users\example\Downloads\repo`;
  const prompt = buildPrompt('実装する', {}, repoCwd, '/tmp/run.summary.md', 60, new Date('2026-08-26T00:00:00Z'));
  assert.ok(prompt.includes(`git -C ${repoCwd}`));
  assert.ok(prompt.includes(`--cwd ${repoCwd}`));
  assert.ok(prompt.indexOf('セッションの作業ディレクトリは履歴を揃えるため') < prompt.indexOf('実装本体は'));
});

test('localDate は Date のローカル日付を YYYY-MM-DD で返す', () => {
  const date = new Date('2026-08-26T18:20:00Z');
  const expected = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  assert.equal(localDate(date), expected);
});

test('timeout と failure の行だけ stderr 末尾の理由を付ける', () => {
  const base = { todo: '実装する', transcript: '', resumeCommand: '' };
  const timeout = formatResultLine({ ...base, status: 'timeout', stderr: '一行目\nタイムアウトしました' }, 60);
  const failure = formatResultLine({ ...base, status: 'failure', stderr: 'x'.repeat(210) }, 1);
  const success = formatResultLine({ ...base, status: 'success', stderr: '表示しない' }, 1);
  assert.ok(timeout.includes(' | 理由: 一行目 タイムアウトしました'));
  assert.ok(failure.endsWith(` | 理由: ${'x'.repeat(200)}`));
  assert.ok(!success.includes(' | 理由:'));
});

test('buildPrompt は逐次サマリと長時間ポーリング禁止を指示する', () => {
  const summaryFile = String.raw`C:\Users\example\.claude\auto-session\runs\2026-08-27-1.summary.md`;
  const prompt = buildPrompt('実装する', {}, String.raw`C:\repo`, summaryFile, 60);
  assert.ok(prompt.includes(summaryFile));
  assert.ok(prompt.includes('5分を超えるポーリングをしてはいけない'));
  assert.ok(prompt.includes('開始から 50 分でまとめに入'));
});

test('recoverSessionId は実行時間窓の外に作られた jsonl を選ばない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-session-'));
  const id = '123e4567-e89b-42d3-a456-426614174000';
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), '{}');
  const birthtime = fs.statSync(path.join(dir, `${id}.jsonl`)).birthtimeMs;
  assert.equal(recoverSessionId({
    dir,
    startedAt: new Date(birthtime + 120_000).toISOString(),
    endedAt: new Date(birthtime + 180_000).toISOString(),
  }), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recoverSessionId は UUID でないファイル名を除外する', () => {
  const now = Date.now();
  assert.equal(recoverSessionId({
    dir: '/projects', startedAt: new Date(now - 1_000), endedAt: new Date(now + 1_000),
    readdir: () => ['agent-latest.jsonl'], stat: () => ({ birthtimeMs: now }),
  }), '');
});

test('recoverSessionId は候補ゼロや読み取り失敗で空文字を返す', () => {
  assert.equal(recoverSessionId({ dir: '/empty', startedAt: new Date(), endedAt: new Date(), readdir: () => [] }), '');
  assert.equal(recoverSessionId({ dir: '/missing', startedAt: new Date(), endedAt: new Date(), readdir: () => { throw new Error('ENOENT'); } }), '');
});

test('appendClosedSession は既存 ID を保持したまま追記し、同じ ID は二重追加しない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-session-'));
  const file = path.join(dir, 'closed-sessions.json');
  const existing = '123e4567-e89b-42d3-a456-426614174000';
  const added = '987e6543-e21b-42d3-a456-426614174999';
  fs.writeFileSync(file, JSON.stringify({ ids: [existing] }));
  assert.equal(appendClosedSession(file, added), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).ids, [existing, added]);
  assert.equal(appendClosedSession(file, added), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).ids, [existing, added]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('appendClosedSession は壊れた JSON から安全に新しい一覧を作る', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-session-broken-'));
  const file = path.join(dir, 'closed-sessions.json');
  const id = '123e4567-e89b-42d3-a456-426614174000';
  fs.writeFileSync(file, '{broken');
  assert.doesNotThrow(() => appendClosedSession(file, id));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ids: [id] });
  fs.rmSync(dir, { recursive: true, force: true });
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
