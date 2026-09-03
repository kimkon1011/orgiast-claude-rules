import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const tool = fileURLToPath(new URL('./codex-do.mjs', import.meta.url));
const { needsWorktreeRepair, detectQuotaLimit } = await import('./codex-do.mjs');

function run(args, options = {}) {
  return spawnSync(process.execPath, [tool, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ORGIAST_HOME: options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'codexdo-home-')),
      ...options.env
    },
  });
}

function writePrompt(body) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codexdo-')), 'prompt.md');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

test('--prompt-file の中身をそのまま指示として使う', () => {
  const file = writePrompt('# 見出し\n新規ファイルを作る\n');
  const result = run(['--dry-run', '--prompt-file', file]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /新規ファイルを作る/);
});

test('バッククォート・$()・改行を含む指示が欠落せず原文のまま届く', () => {
  // argv で渡すとシェルがコマンド置換として実行し、仕様の一部が消えたプロンプトが
  // Codex に届く(2026-08-26 実害)。ファイル経路ではそれが起きないことを固定する。
  const body = 'ファイル `scripts/import-x.mjs` を作る\nテーブルは `booth_customer_aliases`\n$(rm -rf /) は文字列のまま\n';
  const result = run(['--dry-run', '--prompt-file', writePrompt(body)]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /`scripts\/import-x\.mjs`/);
  assert.match(result.stdout, /`booth_customer_aliases`/);
  assert.match(result.stdout, /\$\(rm -rf \/\)/);
});

test('--prompt-file が読めなければ実行せず終了する', () => {
  const result = run(['--dry-run', '--prompt-file', path.join(os.tmpdir(), 'codexdo-missing-prompt.md')]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--prompt-file を読めません/);
});

test('--prompt-file にパスが無ければ使い方を出す', () => {
  const result = run(['--dry-run', '--prompt-file']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--prompt-file/);
});

test('--timeout が数値でなければ実行しない', () => {
  const result = run(['--dry-run', '--timeout', 'abc', 'なにか実装する']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--timeout は正の秒数/);
});

test('--timeout と --cwd を付けても指示文が引数として食われない', () => {
  const result = run(['--dry-run', '--timeout', '60', '--cwd', os.tmpdir(), 'これは指示文です']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /これは指示文です/);
  assert.doesNotMatch(result.stdout, /--timeout|--cwd|60/);
});

test('指示が空なら使い方を出して終了する', () => {
  const result = run(['--dry-run']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /使い方/);
});

test('Windows 絶対パスの gitdir だけ worktree repair 対象にする', () => {
  assert.equal(needsWorktreeRepair('gitdir: C:/Users/example/repo/.git/worktrees/linked\n'), true);
  assert.equal(needsWorktreeRepair('gitdir: ../../../.git/worktrees/linked\n'), false);
});

test('detectQuotaLimit: 枠切れメッセージ (You\'ve hit your usage limit) を検出する', () => {
  const stdout = 'ERROR: You\'ve hit your usage limit. Upgrade to Pro...';
  const check = detectQuotaLimit(stdout, '');
  assert.equal(check.matched, true);
  assert.equal(check.pattern, "You've hit your usage limit");
  assert.match(check.snippet, /You've hit your usage limit/);
});

test('detectQuotaLimit: 枠切れメッセージ (Upgrade to Pro) を検出する', () => {
  const stderr = 'Please visit chatgpt.com/explore/pro to Upgrade to Pro';
  const check = detectQuotaLimit('', stderr);
  assert.equal(check.matched, true);
  assert.equal(check.pattern, "Upgrade to Pro");
});

test('detectQuotaLimit: 枠切れメッセージ (rate limit / 429) を検出する', () => {
  const checkStderr = detectQuotaLimit('', 'Error: rate limit exceeded (429)');
  assert.equal(checkStderr.matched, true);
  assert.equal(checkStderr.pattern, "rate limit");

  const check429 = detectQuotaLimit('', 'HTTP 429 Too Many Requests');
  assert.equal(check429.matched, true);
  assert.equal(check429.pattern, "429");
});

test('detectQuotaLimit: 通常のエラー出力やテスト失敗では検出しない', () => {
  const stderr = 'Error: AssertionError [ERR_ASSERTION]: Expected true but got false\nReferenceError: x is not defined';
  const check = detectQuotaLimit('', stderr);
  assert.equal(check.matched, false);
});

test('--no-fallback が指定されても指示文が引数として食われず、正しく除外される', () => {
  const result = run(['--dry-run', '--no-fallback', 'これは指示文です']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /これは指示文です/);
  assert.doesNotMatch(result.stdout, /--no-fallback/);
});

test('枠切れ発生時に --no-fallback を指定した場合はフォールバックせず非ゼロ終了する', () => {
  const mockResults = [
    { status: 0, output: "You've hit your usage limit. Please try again later.", stderr: "" }
  ];
  const result = run(['--no-fallback', '指示内容'], {
    env: { CODEX_DO_MOCK_RESULTS: JSON.stringify(mockResults) }
  });
  // フォールバックしないため非ゼロ終了
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Codex usage limit detected/);
  assert.match(result.stderr, /--no-fallback is specified/);
  assert.match(result.stdout, /executor=codex/);
});

test('枠切れ発生時にフォールバックし、Gemini が成功した場合は 0 で終了しヘッダ・フッタを出力する', () => {
  const mockResults = [
    { status: 0, output: "You've hit your usage limit. Please try again later.", stderr: "" },
    { status: 0, output: "Gemini CLI has successfully edited files.", stderr: "" }
  ];
  const result = run(['指示内容'], {
    env: { CODEX_DO_MOCK_RESULTS: JSON.stringify(mockResults) }
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /executor=gemini-cli/);
  assert.match(result.stderr, /Falling back to Gemini CLI/);
});

function emptyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexdo-repo-'));
  spawnSync('git', ['-C', dir, 'init', '-q'], { encoding: 'utf8' });
  return dir;
}

test('Gemini が使い方(ヘルプ)を出して exit 0 で終わったら失敗として扱う', () => {
  // 引数を1つ取り違えるだけでヘルプが出て exit 0 になり、1行も書いていないのに
  // 成功に見える(2026-09-03 実測: shell:true で -p の値が空白で割れていた)。
  const mockResults = [
    { status: 0, output: "You've hit your usage limit. Please try again later.", stderr: '' },
    { status: 0, output: 'Usage: gemini [options]\n      --approval-mode             Set the approval mode: default\n', stderr: '' }
  ];
  const result = run(['実装して', '--cwd', emptyRepo()], {
    env: { CODEX_DO_MOCK_RESULTS: JSON.stringify(mockResults) }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /使い方\(ヘルプ\)を表示して終了/);
});

test('Gemini が何も変更せず終わったら失敗として扱う', () => {
  const mockResults = [
    { status: 0, output: "You've hit your usage limit. Please try again later.", stderr: '' },
    { status: 0, output: '対応しました。', stderr: '' }
  ];
  const result = run(['実装して', '--cwd', emptyRepo()], {
    env: { CODEX_DO_MOCK_RESULTS: JSON.stringify(mockResults) }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /1行も変更していません/);
});

test('Codex もフォールバック(Gemini) も失敗した場合は非ゼロで終了する', () => {
  const mockResults = [
    { status: 0, output: "You've hit your usage limit. Please try again later.", stderr: "" },
    { status: 12, output: "", stderr: "Gemini execution error" }
  ];
  const result = run(['指示内容'], {
    env: { CODEX_DO_MOCK_RESULTS: JSON.stringify(mockResults) }
  });
  assert.equal(result.status, 12);
  assert.match(result.stdout, /executor=gemini-cli/);
});

