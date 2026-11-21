import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyWorktree } from './worktree-inventory.mjs';
import '../tests/worktree-inventory.test.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-11-21T12:00:00Z');
const base = {
  path: '/tmp/worktree',
  branch: 'feat/example',
  exists: true,
  now,
  updatedAt: now - DAY_MS - 1,
  ancestor: true,
};

const fixtures = [
  ['メインが保護と prune に優先する', { main: true, path: '/nightly-repo', prunable: true }, 'keep-main'],
  ['夜間用パスが prune に優先する', { path: '/nightly-repo-fleet', prunable: true }, 'keep-protected'],
  ['自動セッション用リポジトリを保護する', { path: '/tmp/auto-session-repo' }, 'keep-protected'],
  ['自動セッション用ツリーを保護する', { path: '/tmp/auto-session-tree-2' }, 'keep-protected'],
  ['Windows の配布リポジトリを保護する', { path: 'C:\\Users\\kim\\Downloads\\orgiast-claude-rules' }, 'keep-protected'],
  ['orgiast-main ディレクトリそのものを保護する', { path: 'C:/Users/orgiast-main' }, 'keep-protected'],
  ['orgiast-main 配下を保護する', { path: 'C:/Users/orgiast-main/worktree' }, 'keep-protected'],
  ['orgiast-main の接尾辞付きディレクトリは別に扱う', { path: 'C:/Users/orgiast-main-old' }, 'safe'],
  ['別の親を持つ orgiast-main は別に扱う', { path: 'C:/Users/kim/orgiast-main' }, 'safe'],
  ['Git が prunable とした行を分類する', { prunable: true, dirty: true }, 'prune'],
  ['実体のない行を分類する', { exists: false }, 'prune'],
  ['変更ありを更新時刻より優先する', { dirty: true, updatedAt: now }, 'keep-dirty'],
  ['24時間ちょうどを直近に含める', { updatedAt: now - DAY_MS, ancestor: false }, 'keep-recent'],
  ['祖先判定が偽でPRを調べない場合は保持する', { ancestor: false }, 'keep-unpushed'],
  ['マージ済みPRがない場合は保持する', { ancestor: false, mergedPr: false }, 'keep-unpushed'],
  ['祖先にあれば削除候補にする', {}, 'safe'],
  ['マージ済みPRがあれば削除候補にする', { ancestor: false, mergedPr: true }, 'safe'],
  ['履歴外の detached HEAD を保持する', { ancestor: false, branch: undefined }, 'keep-unpushed'],
  ['履歴内の detached HEAD を削除候補にする', { branch: undefined }, 'safe'],
  ['点検失敗の行を保持する', { error: 'git status に失敗' }, 'keep-error'],
];

for (const [name, overrides, expected] of fixtures) {
  test(name, () => {
    const { category, reason } = classifyWorktree({ ...base, ...overrides });
    assert.equal(category, expected);
    assert.match(reason, /[ぁ-んァ-ン一-龯].*。$/u);
  });
}
