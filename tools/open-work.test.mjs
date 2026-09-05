import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOpenWork } from './open-work.mjs';

const NOW = new Date('2026-09-05T12:00:00.000Z');

function setup({ prs = [{ number: 7, title: '修正', updatedAt: '2026-09-05T01:00:00Z', isDraft: false }], ghError = false, sheetsError = false, branchCount = 2, branchBehind = 0, many = 0 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'open-work-'));
  fs.mkdirSync(path.join(home, '.claude', 'logs'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'next-session.md'), many
    ? Array.from({ length: many }, (_, i) => `- [ ] TODO ${i + 1}`).join('\n')
    : '- [ ] TODO A\n本文\n- [ ] TODO B\n', 'utf8');
  fs.writeFileSync(path.join(home, '.claude', 'logs', 'nightly-batch-2026-09-05.log'), [
    'NG: 実際の異常', 'error=0 正常', '失敗0 正常', '/ サマリ / NG: 4', 'NG: 0 正常'
  ].join('\n'), 'utf8');
  const calls = [];
  const execImpl = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'gh') {
      if (ghError) throw new Error('gh unavailable');
      return { stdout: JSON.stringify(prs) };
    }
    const joined = args.join(' ');
    if (joined.startsWith('ls-remote')) return { stdout: 'a\trefs/heads/auto/a\nb\trefs/heads/auto/done\n' };
    if (joined.startsWith('fetch')) return { stdout: '' };
    if (joined.includes('origin/main..origin/auto/a')) return { stdout: `${branchCount}\n` };
    if (joined.includes('origin/auto/a..origin/main')) return { stdout: `${branchBehind}\n` };
    if (joined.includes('origin/main..origin/auto/done')) return { stdout: '0\n' };
    if (joined.includes('origin/auto/done..origin/main')) return { stdout: '0\n' };
    if (joined.includes('log -1') && joined.includes('auto/a')) return { stdout: '2026-09-01T10:20:30+09:00\n' };
    throw new Error(`unexpected command: ${command} ${joined}`);
  };
  const fetchImpl = async () => sheetsError
    ? { ok: false, status: 403, text: async () => 'denied' }
    : { ok: true, json: async () => ({ values: [
      ['T-1', '', 'P1', '', '', '重要', '', '', '', '', '', '', '未着手'],
      ['T-2', '', 'P2', '', '', '完了済み', '', '', '', '', '', '', '完了'],
      ['T-3', '', 'P3', '', '', '通常', '', '', '', '', '', '', '進行中']
    ] }) };
  const stdout = [];
  return { home, calls, stdout, options: { home, now: NOW, repoDir: '/repo', execImpl, fetchImpl, getToken: async () => 'token', log: (value) => stdout.push(String(value)) } };
}

test('5種を収集し、branchはmainより先だけを先行・遅れ数と日付付きで表示する', async () => {
  const ctx = setup();
  const result = await runOpenWork({ ...ctx.options, args: ['--dry-run'] });
  const text = ctx.stdout[0];
  assert.deepEqual(result.counts, { PR: 1, ブランチ: 1, タスク: 2, TODO: 2, 夜間異常: 1 });
  assert.match(text, /auto\/a — 先行 2 \/ 遅れ 0（最終コミット 2026-09-01T10:20:30\+09:00）/);
  assert.doesNotMatch(text, /auto\/done —/);
  assert.match(text, /件数: 2件（P1 1 \/ P2 0 \/ P3 1）/);
  assert.match(ctx.stdout.at(-1), /^ok:PR1 ブランチ1 タスク2\(P1 1\) TODO2 夜間異常1$/);
});

test('gh失敗は取得失敗であり0件とは表示しない', async () => {
  const ctx = setup({ ghError: true });
  await runOpenWork({ ...ctx.options, args: ['--dry-run'] });
  const prSection = ctx.stdout[0].match(/### 未処理PR\n([\s\S]*?)\n\n### 取り残しブランチ/)[1];
  assert.match(prSection, /^取得失敗: gh unavailable$/);
  assert.doesNotMatch(prSection, /0件/);
  assert.match(ctx.stdout.at(-1), /取得失敗:PR$/);
});

test('Sheets失敗でも他種別は完走する', async () => {
  const ctx = setup({ sheetsError: true });
  const result = await runOpenWork({ ...ctx.options, args: ['--dry-run'] });
  assert.equal(result.failures.includes('タスク'), true);
  assert.equal(result.counts.PR, 1);
  assert.equal(result.counts['ブランチ'], 1);
  assert.match(ctx.stdout[0], /Sheets API エラー: HTTP 403 denied/);
});

test('成功を表すNG・error・失敗とサマリ行は夜間異常に数えない', async () => {
  const ctx = setup();
  const result = await runOpenWork({ ...ctx.options, args: ['--dry-run'] });
  assert.equal(result.counts['夜間異常'], 1);
  assert.match(ctx.stdout[0], /NG: 実際の異常/);
});

test('11件は既定で10件と残数を表示する', async () => {
  const ctx = setup({ many: 11 });
  await runOpenWork({ ...ctx.options, args: ['--dry-run'] });
  const todo = ctx.stdout[0].match(/### 残TODO\n([\s\S]*?)\n\n### 夜間ジョブ/)[1];
  assert.equal((todo.match(/^- TODO/gm) || []).length, 10);
  assert.match(todo, /…ほか 1件/);
});

test('チェックボックスがあれば未チェックだけをTODOにする', async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.home, '.claude', 'next-session.md'), '- [ ] 未完了\n- [x] 完了\n- 散文の箇条書き');
  const result = await runOpenWork({ ...ctx.options, args: ['--dry-run'] });
  assert.equal(result.counts.TODO, 1);
  assert.match(ctx.stdout[0], /方式: 未チェックのチェックボックス/);
  assert.match(ctx.stdout[0], /- 未完了/);
  assert.doesNotMatch(ctx.stdout[0], /- 完了/);
});

test('チェックボックスがなければ残TODO節直下の箇条書きだけをTODOにする', async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.home, '.claude', 'next-session.md'), '- 節外\n## 残TODO\n- 対象\n  - 入れ子\n## 記録\n- 対象外');
  const result = await runOpenWork({ ...ctx.options, args: ['--dry-run'] });
  assert.equal(result.counts.TODO, 1);
  assert.match(ctx.stdout[0], /方式: TODO・残見出し節の箇条書き/);
  assert.match(ctx.stdout[0], /- 対象/);
});

test('散文だけならTODOは0件で取得失敗にしない', async () => {
  const ctx = setup();
  fs.writeFileSync(path.join(ctx.home, '.claude', 'next-session.md'), '本文です。\n- 散文の箇条書き');
  const result = await runOpenWork({ ...ctx.options, args: ['--dry-run'] });
  assert.equal(result.counts.TODO, 0);
  assert.equal(result.failures.includes('TODO'), false);
  assert.match(ctx.stdout[0], /方式: 該当なし（next-session\.md は散文のみ）/);
});

test('全種別の表示行を100文字以内に切り詰める', async () => {
  const ctx = setup({ prs: [{ number: 8, title: '長'.repeat(150), updatedAt: '2026-09-05', isDraft: false }] });
  await runOpenWork({ ...ctx.options, args: ['--dry-run'] });
  assert.match(ctx.stdout[0], /長+…/);
  assert.equal(ctx.stdout[0].split('\n').every((line) => Array.from(line).length <= 100), true);
});

test('取得失敗の表示行も100文字以内に切り詰める', async () => {
  const ctx = setup({ ghError: true });
  ctx.options.execImpl = async (command, args) => {
    if (command === 'gh') throw new Error('失敗'.repeat(100));
    return setup().options.execImpl(command, args);
  };
  await runOpenWork({ ...ctx.options, args: ['--dry-run'] });
  const errorLine = ctx.stdout[0].split('\n').find((line) => line.startsWith('取得失敗:'));
  assert.equal(Array.from(errorLine).length, 100);
  assert.match(errorLine, /…$/);
});

test('遅れ0だけをマージ可と数え、遅れありには警告する', async () => {
  const mergeable = setup({ branchBehind: 0 });
  await runOpenWork({ ...mergeable.options, args: ['--dry-run'] });
  assert.match(mergeable.stdout[0], /件数: 1件（うちそのままマージ可 1件）/);
  assert.doesNotMatch(mergeable.stdout[0], /そのままマージ不可/);

  const stale = setup({ branchBehind: 1 });
  await runOpenWork({ ...stale.options, args: ['--dry-run'] });
  assert.match(stale.stdout[0], /件数: 1件（うちそのままマージ可 0件）/);
  assert.match(stale.stdout[0], /遅れ 1.*そのままマージ不可/);
});

test('マーカー区間だけを置換して区間外を保つ', async () => {
  const ctx = setup();
  const file = path.join(ctx.home, '.claude', 'open-work.md');
  fs.writeFileSync(file, '前文\n<!-- OPEN-WORK:BEGIN -->\n古い\n<!-- OPEN-WORK:END -->\n後文\n');
  await runOpenWork(ctx.options);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^前文\n<!-- OPEN-WORK:BEGIN -->/);
  assert.match(text, /<!-- OPEN-WORK:END -->\n後文\n$/);
  assert.doesNotMatch(text, /古い/);
});

test('--dry-runではファイルを書かない', async () => {
  const ctx = setup();
  await runOpenWork({ ...ctx.options, args: ['--dry-run'] });
  assert.equal(fs.existsSync(path.join(ctx.home, '.claude', 'open-work.md')), false);
});

test('全種別0件なら在庫なしと表示する', async () => {
  const ctx = setup({ prs: [], branchCount: 0 });
  fs.writeFileSync(path.join(ctx.home, '.claude', 'next-session.md'), '本文だけ');
  fs.writeFileSync(path.join(ctx.home, '.claude', 'logs', 'nightly-batch-2026-09-05.log'), 'error=0');
  ctx.options.fetchImpl = async () => ({ ok: true, json: async () => ({ values: [] }) });
  await runOpenWork({ ...ctx.options, args: ['--dry-run'] });
  assert.match(ctx.stdout[0], /未処理の在庫はありません/);
});
