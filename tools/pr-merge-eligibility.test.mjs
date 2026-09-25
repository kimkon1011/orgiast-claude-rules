import test from 'node:test';
import assert from 'node:assert/strict';
import { firstGuardedPath, hasLabel, evaluatePr, evaluateAll, renderText, fetchState, main } from './pr-merge-eligibility.mjs';

const REPO = 'kimkon1011/orgiast-claude-rules';
// fetchState が要求するフィールド名は判定に必要な分だけであることを固定する。
const PR_FIELDS_CHECK = 'number,title,isDraft,labels,mergeStateStatus,autoMergeRequest,headRepositoryOwner,files,author';
const AUTOMERGE = { name: 'automerge', description: 'CI が緑になったら GitHub が自動で squash マージする（Claude が付ける）' };

// 2026-09-26 実測の PR #567 をそのまま縮めた形（安全弁 + ラベル済み + auto_merge null）。
const pr567 = {
  number: 567,
  title: 'feat(compute-cost): P-0152 計算リソースコスト最適化パイロットの算定器',
  isDraft: false,
  labels: [AUTOMERGE],
  mergeStateStatus: 'CLEAN',
  autoMergeRequest: null,
  headRepositoryOwner: { login: 'kimkon1011' },
  author: { login: 'kimkon1011' },
  files: [{ path: '.github/workflows/test.yml' }, { path: 'tools/compute-cost-pilot.mjs' }],
};

test('安全弁: auto-merge.yml と同じ4パターンを検出する', () => {
  assert.equal(firstGuardedPath(['tools/a.mjs', '.github/workflows/test.yml']), '.github/workflows/test.yml');
  assert.equal(firstGuardedPath(['tools/keyserve-secret.mjs']), 'tools/keyserve-secret.mjs');
  assert.equal(firstGuardedPath(['foo/secrets/x.json']), 'foo/secrets/x.json');
  assert.equal(firstGuardedPath(['.env.local']), '.env.local');
  // `*.env*` は「.env」という並びを要求する。tools/env.local は該当しない（ワークフローと同じ挙動）。
  assert.equal(firstGuardedPath(['tools/env.local']), null);
  assert.equal(firstGuardedPath(['docs/a.md', 'tools/b.mjs']), null);
  assert.equal(firstGuardedPath([]), null);
  assert.equal(firstGuardedPath([{ path: 'tools/x.mjs' }, { path: 'tools/.env' }]), 'tools/.env');
});

test('安全弁: パスが空文字や非文字列でも落ちない', () => {
  assert.equal(firstGuardedPath([{ path: '' }, { path: null }, 'tools/ok.mjs']), null);
});

test('ラベル: 文字列でもオブジェクトでも automerge を検出する', () => {
  assert.equal(hasLabel({ labels: [AUTOMERGE] }, 'automerge'), true);
  assert.equal(hasLabel({ labels: ['automerge'] }, 'automerge'), true);
  assert.equal(hasLabel({ labels: [{ name: 'bug' }] }, 'automerge'), false);
  assert.equal(hasLabel({}, 'automerge'), false);
});

test('判定: 安全弁つきラベル済み PR は manual_merge_required（可否を聞かない）', () => {
  const item = evaluatePr(pr567, { repo: REPO });
  assert.equal(item.verdict, 'manual_merge_required');
  assert.equal(item.guarded, '.github/workflows/test.yml');
  assert.match(item.action, /kim/);
  assert.doesNotMatch(item.action, /--add-label/);
});

test('判定: 安全弁なし・ラベルなしは missing_label（Claude が付ける）', () => {
  const item = evaluatePr({ ...pr567, number: 568, labels: [], files: [{ path: 'tools/x.mjs' }] }, { repo: REPO });
  assert.equal(item.verdict, 'missing_label');
  assert.equal(item.action, `gh pr edit 568 --repo ${REPO} --add-label automerge`);
});

test('判定: auto_merge が入っていれば待つのみ', () => {
  const item = evaluatePr({ ...pr567, number: 569, autoMergeRequest: { mergeMethod: 'SQUASH' }, files: [{ path: 'tools/x.mjs' }] }, { repo: REPO });
  assert.equal(item.verdict, 'auto_merge_enabled');
  assert.equal(item.autoMergeQueued, true);
  assert.match(item.action, /待つのみ/);
  assert.doesNotMatch(item.action, /--add-label|手動マージ/);
});

test('判定: ラベル済み・安全弁なし・auto_merge 未設定は pending_auto_merge', () => {
  const item = evaluatePr({ ...pr567, number: 570, files: [{ path: 'tools/x.mjs' }] }, { repo: REPO });
  assert.equal(item.verdict, 'pending_auto_merge');
  assert.match(item.action, /gh api/);
});

test('判定: draft と fork は自動マージ対象外', () => {
  const draft = evaluatePr({ ...pr567, isDraft: true }, { repo: REPO });
  assert.equal(draft.verdict, 'ineligible_draft');
  const fork = evaluatePr({ ...pr567, headRepositoryOwner: { login: 'someone' } }, { repo: REPO });
  assert.equal(fork.verdict, 'ineligible_fork');
});

test('判定: 作者が collaborator でなければラベルがあっても対象外', () => {
  const outside = evaluatePr({ ...pr567, files: [{ path: 'tools/x.mjs' }] }, { repo: REPO, collaborators: [] });
  assert.equal(outside.verdict, 'ineligible_author');
  assert.ok(outside.notes.some((note) => note.includes('author')));
  const inside = evaluatePr({ ...pr567, files: [{ path: 'tools/x.mjs' }] }, { repo: REPO, collaborators: ['kimkon1011'] });
  assert.equal(inside.verdict, 'pending_auto_merge');
  assert.equal(inside.notes.some((note) => note.includes('author')), false);
});

test('判定: 衝突(DIRTY)と BLOCKED は note に残す', () => {
  const dirty = evaluatePr({ ...pr567, mergeStateStatus: 'DIRTY' }, { repo: REPO });
  assert.ok(dirty.notes.some((note) => note.startsWith('conflicts:')));
  const blocked = evaluatePr({ ...pr567, mergeStateStatus: 'BLOCKED', files: [{ path: 'tools/x.mjs' }] }, { repo: REPO });
  assert.ok(blocked.notes.some((note) => note.startsWith('blocked:')));
});

test('集計: verdict ごとに件数を数える', () => {
  const report = evaluateAll({
    repo: REPO,
    prs: [pr567, { ...pr567, number: 568, labels: [], files: [{ path: 'tools/x.mjs' }] }, { ...pr567, number: 566 }],
  });
  assert.equal(report.items.length, 3);
  assert.equal(report.counts.manual_merge_required, 2);
  assert.equal(report.counts.missing_label, 1);
  assert.match(renderText(report), /manual_merge_required=2/);
});

test('fetchState: gh の引数と collaborator の404を正しく扱う', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'pr') return JSON.stringify([pr567]);
    if (args[1].endsWith('/kimkon1011/permission')) return 'kimkon1011\n';
    const error = new Error('gh api が失敗');
    throw error;
  };
  const state = fetchState(REPO, { run, asOf: '2026-09-26T10:00:00Z' });
  assert.deepEqual(state.collaborators, ['kimkon1011']);
  assert.equal(state.asOf, '2026-09-26T10:00:00Z');
  assert.ok(calls[0].includes('--state'));
  assert.ok(calls[0].includes(PR_FIELDS_CHECK));
  assert.equal(calls[0][calls[0].indexOf('--limit') + 1], '200');
});

test('fetchState: 作者権限が引けない PR があっても落ちない', () => {
  const run = (args) => {
    if (args[0] === 'pr') return JSON.stringify([pr567]);
    throw new Error('gh api が失敗');
  };
  const state = fetchState(REPO, { run });
  assert.deepEqual(state.collaborators, []);
});

test('main: repo 未指定は使い方を出して終了コード2', () => {
  const out = [];
  assert.equal(main(['node', 'x.mjs', '--json'], { log: (line) => out.push(line) }), 2);
  assert.match(out.join('\n'), /使い方/);
});

test('main: --json で判定結果を返す（gh は差し替え）', () => {
  const run = (args) => {
    if (args[0] === 'pr') return JSON.stringify([pr567]);
    return 'kimkon1011\n';
  };
  const out = [];
  const code = main(['node', 'x.mjs', '--repo', REPO, '--json'], { run, log: (line) => out.push(line) });
  assert.equal(code, 0);
  const report = JSON.parse(out.join('\n'));
  assert.equal(report.items[0].verdict, 'manual_merge_required');
});
