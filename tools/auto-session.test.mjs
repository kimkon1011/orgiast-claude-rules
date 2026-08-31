import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-session-test-'));
process.env.ORGIAST_HOME = isolatedHome;
const { DEFAULT_REPO, localDate, loadConfig, detectHistoryCwd, parseHandoff, todoExclusionReason, todoExclusionReasons, dedupeKey, dedupeTodos, filterTodos, pickCwd, buildChildArgs, buildPrompt, buildFeedbackPrompt, feedbackIssueExclusionReason, filterFeedbackIssues, feedbackNotifyUrl, normalizeGitHubRepo, feedbackRepoCwd, resolveClaudeExe, decideRun, markTodoDone, writeTodoDone, extractSessionId, transcriptPath, recoverSessionId, appendClosedSession, formatResultLine, parseArgs, deadlineDecision, runChild } = await import('./auto-session.mjs');
const historyCwd = String.raw`c:\Users\example\Downloads\work`;
test.after(() => fs.rmSync(isolatedHome, { recursive: true, force: true }));

const sample = `前書き\n<!-- NEXT-SESSION v1 -->\n## 対象\nrepo A\n## 残TODO\n1. 実装する\n2. ~~完了済み~~\n3. 要判断: 色\n4. ブロック中: API\n## 完了条件\nテスト green\n<!-- NEXT-SESSION v1 -->\n## 残TODO\n1. 歴史上のTODO\n`;

test('parseHandoff は全ブロックから TODO を抽出し、付帯セクションは先頭だけから抽出する', () => {
  const parsed = parseHandoff(sample);
  assert.deepEqual(parsed.todos, ['実装する', '~~完了済み~~', '要判断: 色', 'ブロック中: API', '歴史上のTODO']);
  assert.deepEqual(parsed.todoBlocks, [1, 1, 1, 1, 2]);
  assert.ok(parsed.block.includes('実装する'));
  assert.ok(!parsed.block.includes('歴史上のTODO'));
  assert.equal(parsed.sections['対象'], '## 対象\nrepo A');
  assert.equal(parsed.sections['完了条件'], '## 完了条件\nテスト green');
});

test('3ブロックの残TODOを新しいブロックから順に連結する', () => {
  const md = `<!-- NEXT-SESSION v1 -->\n## 残TODO\n1. 最新A\n2. 最新B\n---\n<!-- NEXT-SESSION v1 -->\n## 残TODO\n1. 2番目\n---\n<!-- NEXT-SESSION v1 -->\n## 残TODO\n1. 3番目\n`;
  const parsed = parseHandoff(md);
  assert.deepEqual(parsed.todos, ['最新A', '最新B', '2番目', '3番目']);
  assert.deepEqual(parsed.todoBlocks, [1, 1, 2, 3]);
  assert.equal(parsed.todoBlocks.length, parsed.todos.length);
});

test('単一ブロックは従来と同じ件数・順序で解析する', () => {
  const md = `<!-- NEXT-SESSION v1 -->\n## 残TODO\n1. 最初\n2. 次\n`;
  const parsed = parseHandoff(md);
  assert.deepEqual(parsed.todos, ['最初', '次']);
  assert.deepEqual(parsed.todoBlocks, [1, 1]);
});

test('sections は2番目以降の対象を混ぜない', () => {
  const md = `<!-- NEXT-SESSION v1 -->\n## 対象\n最新のrepo\n## 残TODO\n1. A\n---\n<!-- NEXT-SESSION v1 -->\n## 対象\n古いrepo\n## 残TODO\n1. B\n`;
  const parsed = parseHandoff(md);
  assert.equal(parsed.sections['対象'], '## 対象\n最新のrepo');
  assert.ok(!parsed.sections['対象'].includes('古いrepo'));
});

test('参照だけの実文言 TODO を除外し、末尾に括弧がある通常 TODO は除外しない', () => {
  const note = '（旧引き継ぎの残TODO 3〜15 はすべて有効。下にそのまま残してある）';
  const task = '**MCP gemini-cli の復旧**（2026-08-28 発見・未着手）。セッション開始時に CONNECT_TIMEOUT で落ちており、…';
  assert.equal(todoExclusionReason(`4. ${note}`), '参照のみ（作業内容が無い）');
  assert.equal(todoExclusionReason(task), '');
});

test('新旧ブロックの同一 TODO は先頭の1件だけを採用する', () => {
  const md = `<!-- NEXT-SESSION v1 -->\n## 残TODO\n1. **同じ作業**（最新）\n---\n<!-- NEXT-SESSION v1 -->\n## 残TODO\n1. **同じ作業**（古い）\n`;
  const parsed = parseHandoff(md);
  assert.equal(filterTodos(parsed.todos).length, 1);
  assert.deepEqual(todoExclusionReasons(parsed.todos), ['', '重複（先の項目と同一）']);
});

test('filterTodos は完了・判断待ち・未決・ブロック中を除外する', () => {
  assert.deepEqual(filterTodos(['実行', '~~完了~~', '要判断 X', '判断待ち X', '未決 X', 'ブロック中 X']), ['実行']);
});

test('--count all は3件を超えるフィルタ後の全TODOを選択する', () => {
  const todos = ['実行1', '~~完了~~', '実行2', '実行3', '実行4'];
  const options = parseArgs(['--count', 'all']);
  assert.equal(options.count, Infinity);
  assert.deepEqual(filterTodos(todos).slice(0, options.count), ['実行1', '実行2', '実行3', '実行4']);
});

test('数値 count と feedback-count は12件を上限にする', () => {
  const options = parseArgs(['--count', '99', '--feedback-count', '99']);
  assert.equal(options.count, 12);
  assert.equal(options.feedbackCount, 12);
  assert.equal(parseArgs(['--feedback-count', 'all']).feedbackCount, Infinity);
});

test('deadline まで5分なら起動せず、25分なら timeout を25分に縮める', () => {
  const start = new Date(2026, 7, 30, 7, 0, 0);
  assert.deepEqual(deadlineDecision('07:30', 40, new Date(2026, 7, 30, 7, 25, 0), start), {
    run: false, timeoutMin: 0, reason: 'deadline', remainingMin: 5,
  });
  assert.deepEqual(deadlineDecision('07:30', 40, new Date(2026, 7, 30, 7, 5, 0), start), {
    run: true, timeoutMin: 25, reason: '', remainingMin: 25,
  });
  // 起動時刻が締切を過ぎていたら翌朝の同時刻として扱う（夕方の手動起動が静かな no-op にならないように）。
  const evening = new Date(2026, 7, 30, 20, 0, 0);
  assert.deepEqual(deadlineDecision('07:30', 40, evening, evening), { run: true, timeoutMin: 40, reason: '', remainingMin: 690 });
  // 子が締切を跨いで走り切った場合だけ already passed になる。
  assert.equal(deadlineDecision('07:30', 40, new Date(2026, 7, 30, 8, 0, 0), start).reason, 'deadline already passed');
});

test('このPCでは実行不可と明記された実物由来TODOを除外する', () => {
  const todo = '**マキモノ §6-1（信頼済み mkt_ キー発行 → keyserve ORGIAST_KEYS_JSON 投入）はこのPCでは実行不可**';
  assert.equal(todoExclusionReason(todo), 'このPCでは実行不可');
  assert.deepEqual(filterTodos([todo, '実行可能']), ['実行可能']);
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
  assert.equal(todoExclusionReason('この対応は着手中'), '');
  assert.equal(todoExclusionReason('担当者が作業中'), '');
  assert.equal(todoExclusionReason('別セッションで確認する'), '');
  assert.equal(todoExclusionReason('次回着手する'), '');
});

test('実物の gemini-cli TODO は先頭だけを採用し、後続を重複として表示できる', () => {
  const todos = [
    '**MCP `gemini-cli` の復旧**（上記「次の1目的」）',
    '**MCP `gemini-cli` の復旧**（2026-08-28 発見・未着手）。セッション開始時に …',
  ];
  assert.equal(dedupeKey(todos[0]), 'MCPgemini-cliの復旧（上記「次の1目的」）');
  assert.deepEqual(dedupeTodos(todos), [todos[0]]);
  assert.deepEqual(filterTodos(todos), [todos[0]]);
  assert.deepEqual(todoExclusionReasons(todos), ['', '重複（先の項目と同一）']);
});

test('他セッションの進行中差分は除外し、発見・積み残しだけは採用する', () => {
  const active = '**ブース制作アプリのローカル未コミット差分は別セッションの進行中作業**（今回は触っていない）: … **他セッションの作業なので勝手に commit しない**';
  const leftover = '**別セッション 739b053e の積み残し・日付ゲート付き**（2026-08-28 以降に実行）';
  const discovered = '**別セッション 26624db2 で発見**: 復旧する';
  const today = new Date(2026, 7, 30);
  assert.equal(todoExclusionReason(active, today), '他セッションが着手中');
  assert.equal(todoExclusionReason(leftover, today), '');
  assert.equal(todoExclusionReason(discovered, today), '');
  assert.deepEqual(filterTodos([active, leftover, discovered], today), [leftover, discovered]);
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

test('markTodoDone は該当行だけを変更し、他行は変えない', () => {
  const changed = markTodoDone(sample, '実装する', '2026-08-26 完了（PR #42）');
  const expected = sample.replace('1. 実装する\n', '1. ~~実装する~~ → ✅ 2026-08-26 完了（PR #42）\n');
  assert.equal(changed, expected);
  assert.ok(changed.endsWith('1. 歴史上のTODO\n'));
});

test('markTodoDone は先頭でないブロックの TODO をマークし、他の全バイトを維持する', () => {
  const changed = markTodoDone(sample, '歴史上のTODO', '2026-08-30 完了（auto-session）');
  const expected = sample.replace('1. 歴史上のTODO\n', '1. ~~歴史上のTODO~~ → ✅ 2026-08-30 完了（auto-session）\n');
  assert.equal(changed, expected);
});

test('markTodoDone は複数ブロックに重複した同一 TODO をすべてマークする', () => {
  const duplicated = `<!-- NEXT-SESSION v1 -->\n## 残TODO\n1. 重複するTODO\n2. 別のTODO\n<!-- NEXT-SESSION v1 -->\n## 残TODO\n1. 重複するTODO\n`;
  const changed = markTodoDone(duplicated, '重複するTODO', '2026-08-30 完了（auto-session）');
  assert.equal(changed.match(/~~重複するTODO~~/g)?.length, 2);
  assert.ok(changed.includes('2. 別のTODO\n'));
});

test('markTodoDone は取り消し線付きまたは該当行なしなら入力を完全一致で返す', () => {
  assert.equal(markTodoDone(sample, '~~完了済み~~', '2026-08-30 完了（auto-session）'), sample);
  assert.equal(markTodoDone(sample, '存在しないTODO', '2026-08-30 完了（auto-session）'), sample);
});

test('writeTodoDone は書く直前の再読込内容へ完了印を付け、並行追加行を維持する', () => {
  const batchSnapshot = sample;
  const latest = batchSnapshot.replace('1. 歴史上のTODO\n', '1. 歴史上のTODO\n2) 他セッションが追加\r\n');
  let written = '';
  const changed = writeTodoDone('/next-session.md', '歴史上のTODO', '2026-08-30 完了（auto-session）', {
    read: () => latest,
    write: (_file, content) => { written = content; },
  });
  assert.equal(changed, true);
  assert.equal(written, latest.replace('1. 歴史上のTODO\n', '1. ~~歴史上のTODO~~ → ✅ 2026-08-30 完了（auto-session）\n'));
  assert.ok(written.includes('2) 他セッションが追加\r\n'));
});

test('writeTodoDone は該当行が無ければ throw せず書き込まない', () => {
  let writes = 0;
  assert.doesNotThrow(() => assert.equal(writeTodoDone('/next-session.md', '存在しないTODO', 'note', {
    read: () => sample,
    write: () => { writes += 1; },
  }), false));
  assert.equal(writes, 0);
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

test('spawn が同期 throw しても reject せず failure として resolve する', async () => {
  // Windows の spawn は EFTYPE/ENOENT を同期 throw する。child.on('error') では拾えないため、
  // 以前は Promise executor の外へ抜けて main が exit 1 で死に、残りのTODOも最終通知も消えていた。
  // NUL を含むパスはどのプラットフォームでも spawn が同期 throw するので、その経路を移植性高く踏める。
  const result = await runChild(`bogus${String.fromCharCode(0)}path`, 'prompt', process.cwd(), process.cwd(), 1000);
  assert.equal(result.status, 'failure');
  assert.equal(result.launchFailed, true);
  assert.ok(result.stderr.length > 0);
});

test('「以下は下の別ブロックの残TODO…」型の案内文は参照のみとして除外する', () => {
  // 実物にあった文言。太字を含むため「太字が無い」条件では拾えず、子セッションに案内文だけが渡っていた。
  const guide = '36. 以下は**下の別ブロックの残TODO（1〜14）**をそのまま引き継いだもの。内容は下を見ること';
  assert.equal(todoExclusionReason(guide, new Date(2026, 7, 30)), '参照のみ（作業内容が無い）');
  // 通常のTODOは巻き込まない
  const normal = '10. **`is-entry.mjs` 未統一の掃除**（`line-digest.mjs` は素の比較のまま）。以下の手順で直す';
  assert.equal(todoExclusionReason(normal, new Date(2026, 7, 30)), '');
});
