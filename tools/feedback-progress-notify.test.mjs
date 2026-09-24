import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runProgressNotify, selectProgress, loadProgressIssue } from './feedback-progress-notify.mjs';

const now = new Date('2026-09-24T12:00:00Z');
const issue = { number: 21, state: 'open', title: '購入の登録', body: '', html_url: 'https://github.com/example/app/issues/21', updated_at: now.toISOString(), comments: [] };
const pr = { state: 'OPEN', url: 'https://github.com/example/app/pull/22', createdAt: '2026-09-22T00:00:00Z', statusCheckRollup: [{ conclusion: 'SUCCESS' }] };
const question = { body: '調査しました。入口を教えてください。', author_association: 'COLLABORATOR', created_at: '2026-09-23T00:00:00Z' };

test('4状態と優先度を判定する', () => {
  assert.equal(selectProgress({ ...issue, comments: [question] }, [pr], now).state, 'answered');
  assert.equal(selectProgress(issue, [pr], now).state, 'pr_open');
  assert.equal(selectProgress(issue, [{ ...pr, statusCheckRollup: [{ state: 'FAILURE' }] }], now).state, 'pr_blocked');
  assert.equal(selectProgress({ ...issue, updated_at: '2026-09-17T12:00:00Z' }, [], now).state, 'stalled');
  assert.equal(selectProgress({ ...issue, state: 'closed' }, [pr], now), null);
});
test('返信後・新しい進捗後は古い質問を通知しない', () => {
  const reply = { body: '<!-- feedback-reply:123 -->\nお願いします', created_at: now.toISOString() };
  assert.equal(selectProgress({ ...issue, comments: [question, reply] }, [pr], now).state, 'pr_open');
  const update = { ...question, created_at: now.toISOString(), body: '調査後 PR #22 を作成しました。残りを教えてください。' };
  assert.equal(selectProgress({ ...issue, comments: [question, update] }, [{ ...pr, statusCheckRollup: [{ conclusion: 'FAILURE' }] }], now).state, 'pr_blocked');
  assert.equal(selectProgress({ ...issue, comments: [{ ...question, author_association: 'NONE' }] }, [], now), null);
});
test('テスト無し・実行中を成功扱いしない、失敗を優先する', () => {
  for (const checks of [[], [{ conclusion: 'SKIPPED' }], [{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }]]) {
    assert.equal(selectProgress(issue, [{ ...pr, statusCheckRollup: checks }], now), null);
  }
  assert.equal(selectProgress(issue, [{ ...pr, statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'TIMED_OUT' }] }], now).state, 'pr_blocked');
});

function fixture(t, { known = true, discovered = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-progress-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir);
  const item = { repo: 'example/app', number: 21, ...(known ? { submitter_discord_id: '42' } : {}) };
  fs.writeFileSync(path.join(dir, 'feedback-issue-ledger.json'), JSON.stringify({ items: discovered ? [] : [item] }));
  fs.writeFileSync(path.join(dir, 'feedback-relay.env'), 'FEEDBACK_REPO_MAP=Example=example/app');
  fs.writeFileSync(path.join(dir, 'orgiast-discord-bot-token.txt'), randomUUID());
  const sent = [], output = [];
  const options = {
    home, args: ['--json'],
    io: { stdout: (value) => output.push(JSON.parse(value)), stderr: () => {}, now: () => now },
    sendDm: async (payload) => { sent.push(payload); },
    fetchImpl: async () => { throw new Error('unexpected network request'); },
    getMembers: async () => [],
    gh: (args) => ({ status: 0, stdout: JSON.stringify([args.at(-1).startsWith('repos/example/app/') && discovered ? [issue] : []]) }),
    loadIssue: async () => ({ issue, prs: [pr] }),
  };
  return { dir, options, sent, output };
}
test('同じ状態の再実行は送らず、状態変更時のみ再送する', async (t) => {
  const f = fixture(t);
  await runProgressNotify(f.options);
  await runProgressNotify(f.options);
  assert.equal(f.sent.length, 1);
  assert.equal(f.output.at(-1).items[0].skipped, 'unchanged');
  await runProgressNotify({ ...f.options, loadIssue: async () => ({ issue, prs: [{ ...pr, statusCheckRollup: [{ state: 'FAILURE' }] }] }) });
  assert.equal(f.sent.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'feedback-progress-ledger.json'))).items['example/app#21'].lastState, 'pr_blocked');
});
test('台帳外のIssueを拾い、宛先不明はkimへ一度エスカレーションする', async (t) => {
  const f = fixture(t, { discovered: true, known: false });
  await runProgressNotify(f.options);
  await runProgressNotify(f.options);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].userId, '715210673642012733');
  assert.match(f.sent[0].content, /依頼主が特定できません/);
  assert.match(f.sent[0].content, /https:\/\/github.com\/example\/app\/pull\/22/);
});
test('本文の提出者を名前解決し、エスカレーション後も依頼主に届ける', async (t) => {
  const f = fixture(t, { known: false });
  const loadIssue = async () => ({ issue: { ...issue, body: '提出者: 山田太郎' }, prs: [pr] });
  await runProgressNotify({ ...f.options, loadIssue });
  await runProgressNotify({ ...f.options, loadIssue, getMembers: async () => [{ id: '42', username: '山田太郎' }] });
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].userId, '42');
});
test('dry-run はDMも通知台帳も書かない', async (t) => {
  for (const known of [true, false]) {
    const f = fixture(t, { known });
    assert.equal(await runProgressNotify({ ...f.options, args: ['--dry-run', '--json'] }), 0);
    assert.equal(f.sent.length, 0);
    assert.equal(fs.existsSync(path.join(f.dir, 'feedback-progress-ledger.json')), false);
    assert.equal(f.output[0].items[0].state, 'pr_open');
  }
});
test('送信失敗は記録せず再試行し、バッチの終了コードを汚さない', async (t) => {
  const f = fixture(t);
  assert.equal(await runProgressNotify({ ...f.options, sendDm: async () => { throw new Error('delivery failed'); } }), 0);
  assert.equal(f.output[0].ok, false);
  assert.equal(fs.existsSync(path.join(f.dir, 'feedback-progress-ledger.json')), false);
  await runProgressNotify(f.options);
  assert.equal(f.sent.length, 1);
});
test('破損した台帳は上書きしない', async (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, 'feedback-progress-ledger.json');
  fs.writeFileSync(file, 'broken');
  assert.equal(await runProgressNotify(f.options), 0);
  assert.equal(f.output[0].ok, false);
  assert.equal(f.sent.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
});
test('GitHubのページ走査で関連PRを取得し重複参照を除く', () => {
  const calls = [];
  const reference = { event: 'cross-referenced', source: { issue: { pull_request: { html_url: pr.url } } } };
  const result = loadProgressIssue({ repo: 'example/app', number: 21 }, (args) => {
    calls.push(args);
    const last = args.at(-1);
    return { status: 0, stdout: JSON.stringify(args[0] === 'pr' ? pr : last.includes('/comments?') ? [[question], []] : last.includes('/timeline?') ? [[reference], [reference]] : issue) };
  });
  assert.equal(result.prs.length, 1);
  assert.equal(result.issue.comments.length, 1);
  assert.equal(calls.filter((args) => args.includes('--paginate')).length, 2);
});
test('nightlyの通知順序とエラー継続を保つ', () => {
  const source = fs.readFileSync(new URL('./nightly-batch.ps1', import.meta.url), 'utf8');
  const steps = ['feedback-to-issues', 'feedback-replies', 'feedback-done-notify', 'feedback-progress-notify', 'feedback-100oku'];
  const positions = steps.map((step) => source.indexOf(`tools\\${step}.mjs`));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
  for (const step of steps.slice(2, 4)) assert.ok(source.includes(`Write-NightlyStepResult '${step}'`));
});

test('指定の最小台帳形式でも同じlastStateなら再送しない', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'feedback-progress-ledger.json'), JSON.stringify({ version: 1, items: { 'example/app#21': { lastState: 'pr_open', notifiedAt: now.toISOString() } } }));
  await runProgressNotify(f.options);
  assert.equal(f.sent.length, 0);
});

test('dry-run の名前解決はキャッシュ保存も無効にする', async (t) => {
  const f = fixture(t, { known: false });
  let persistCache;
  await runProgressNotify({ ...f.options, args: ['--dry-run', '--json'],
    loadIssue: async () => ({ issue: { ...issue, body: '提出者: 山田' }, prs: [pr] }),
    getMembers: async (options) => { persistCache = options.persistCache; return []; },
  });
  assert.equal(persistCache, false);
  assert.equal(f.sent.length, 0);
});
