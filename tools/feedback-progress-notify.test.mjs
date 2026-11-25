import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runProgressNotify, selectProgress, loadProgressIssue, submitterSources, matchFeedbackSource } from './feedback-progress-notify.mjs';

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
  assert.equal(selectProgress({ ...issue, comments: [{ ...question, author_association: 'NONE' }] }, [], now).state, 'stalled');
});
test('テスト無し・pending・queuedはpr_open、確定失敗を優先する', () => {
  for (const checks of [[], [{ status: 'QUEUED' }], [{ state: 'PENDING' }], [{ conclusion: 'SKIPPED' }], [{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }]]) {
    assert.equal(selectProgress(issue, [{ ...pr, statusCheckRollup: checks }], now).state, 'pr_open');
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
test('同一repoのPRだけを検索し、別repoの同番号参照を除外してCIを取得する', () => {
  const calls = [];
  const result = loadProgressIssue({ repo: 'example/app', number: 21 }, (args) => {
    calls.push(args);
    const last = args.at(-1);
    const candidates = [
      { number: 22, html_url: pr.url, body: 'Part of #21' },
      { number: 547, html_url: 'https://github.com/other/repo/pull/547', body: '#21' },
      { number: 23, html_url: 'https://github.com/example/app/pull/23', body: 'other/repo#21' },
      { number: 24, html_url: 'https://github.com/example/app/pull/24', body: '#210' },
    ];
    return { status: 0, stdout: JSON.stringify(args[0] === 'pr' ? { ...pr, statusCheckRollup: [{ conclusion: 'FAILURE' }] }
      : last.includes('/comments?') ? [[question], []] : last.includes('/pulls?') ? [candidates] : issue) };
  });
  assert.equal(result.prs.length, 1);
  assert.equal(selectProgress({ ...result.issue, comments: [] }, result.prs).state, 'pr_blocked');
  assert.deepEqual(calls.find((args) => args[0] === 'pr'), ['pr', 'view', '22', '--repo', 'example/app', '--json', 'state,url,createdAt,updatedAt,statusCheckRollup']);
  assert.equal(result.issue.comments.length, 1);
});
test('同repoにPRが無ければIssue URLへ戻る', () => {
  const result = loadProgressIssue({ repo: 'example/app', number: 21 }, (args) => ({ status: 0,
    stdout: JSON.stringify(args.includes('--paginate') ? [[]] : issue) }));
  assert.equal(selectProgress(result.issue, result.prs).url, issue.html_url);
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

test('submitterの優先順、壊れたマーカーと日本語ラベル', () => {
  const sources = submitterSources({ submitter: '台帳' }, '<!-- feedback-submitter: {"submitter":"marker"} -->\n報告者：山田\n送信元: taro@example.com');
  assert.deepEqual(sources.map((x) => x.submitter), ['台帳', 'marker', '山田', 'taro@example.com']);
  assert.equal(submitterSources({}, '<!-- feedback-submitter: broken -->\n提出者: 山田').at(-1).submitter, '山田');
});
test('本文マーカーで解決し台帳へbackfill、次回は名簿照会不要', async (t) => {
  const f = fixture(t, { known: false, discovered: true });
  const loadIssue = async () => ({ issue: { ...issue, body: '<!-- feedback-submitter: {"submitter":"山田", "submitter_discord_id":"42"} -->' }, prs: [pr] });
  await runProgressNotify({ ...f.options, args: ['--json', '--backfill'], loadIssue });
  const ledger = JSON.parse(fs.readFileSync(path.join(f.dir, 'feedback-issue-ledger.json')));
  assert.equal(ledger.items[0].submitter_discord_id, '42');
  await runProgressNotify({ ...f.options, getMembers: async () => { throw new Error('must not query'); } });
  assert.equal(f.output.at(-1).ok, true);
  assert.equal(f.sent.length, 1);
});
test('dry-runは依頼主台帳も変更せずbackfill予定を報告、日本語表示を保つ', async (t) => {
  const f = fixture(t, { known: false });
  const file = path.join(f.dir, 'feedback-issue-ledger.json');
  const before = fs.readFileSync(file, 'utf8');
  await runProgressNotify({ ...f.options, args: ['--dry-run', '--json'],
    loadIssue: async () => ({ issue: { ...issue, body: '報告者: 山田', title: '[不具合] 壊れた�原題' }, prs: [] }),
    getMembers: async () => [{ id: '42', nick: '山田' }],
  });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const row = f.output[0].items[0];
  assert.equal(row.state, 'stalled');
  assert.equal(row.recipientId, '42');
  assert.equal(row.backfill.submitter_discord_id, '42');
  assert.equal(row.titleFallback, true);
  assert.ok(!row.title.includes('�'));
});

test('PRのブランチ名・同repoのIssue URLも照合し、別repo URLと番号前方一致は除外', () => {
  for (const [fields, expected] of [
    [{ head: { ref: 'feat/issue-21-fix' } }, 1],
    [{ body: 'https://github.com/example/app/issues/21' }, 1],
    [{ body: 'https://github.com/example/app/issues/210' }, 0],
    [{ body: 'https://github.com/other/app/issues/21' }, 0],
    [{ head: { ref: 'feat/issue-210-fix' } }, 0],
  ]) {
    const loaded = loadProgressIssue({ repo: 'example/app', number: 21 }, (args) => ({ status: 0,
      stdout: JSON.stringify(args[0] === 'pr' ? pr : args.at(-1).includes('/pulls?')
        ? [[{ number: 22, html_url: pr.url, ...fields }]] : args.includes('--paginate') ? [[]] : issue) }));
    assert.equal(loaded.prs.length, expected);
  }
  assert.doesNotThrow(() => submitterSources({}, null));
});


test('要望見出しは受領セッションの名前ではなく依頼主を抽出する', () => {
  const sources = submitterSources({}, '## 要望（kim / 2026-09-22、nishi の Claude Code セッションで受領）');
  assert.equal(sources.at(-1).submitter, 'kim');
  assert.ok(!sources.some((s) => s.submitter === 'nishi'));
});
test('一次ソースは重複・タイトルのみ・別アプリ・破損テキストを照合しない', () => {
  const i = { ...issue, title: '[要望] 購入の登録', body: '内容\n\n提出者: 不明\n提出元URL: https://app.example/' };
  const item = { title: '購入の登録', body: '内容', source_url: 'https://app.example/', email: 'a@example.com' };
  assert.equal(matchFeedbackSource(i, [item]), item);
  assert.equal(matchFeedbackSource(i, [item, item]), null);
  assert.equal(matchFeedbackSource(i, [{ ...item, body: '別の内容' }]), null);
  assert.equal(matchFeedbackSource(i, [{ ...item, source_url: 'https://other.example/' }]), null);
  assert.equal(matchFeedbackSource(i, [{ ...item, source_url: undefined }]), null);
});
test('backfill dry-runは台帳不変、明示backfillだけ保存し送信しない', async (t) => {
  const f = fixture(t, { known: false });
  const file = path.join(f.dir, 'feedback-issue-ledger.json');
  const before = fs.readFileSync(file, 'utf8');
  const options = { ...f.options,
    loadSource: async () => ({ sheetUrl: 'https://docs.google.com/spreadsheets/d/test/edit', items: [
      { issue_url: issue.html_url, submitter: 'kim', submitter_discord_id: '715210673642012733' },
    ] }),
  };
  await runProgressNotify({ ...options, args: ['--json', '--backfill', '--dry-run'] });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(f.output.at(-1).items[0].resolution, 'owner_is_kim');
  assert.equal(f.output.at(-1).items[0].escalated, false);
  await runProgressNotify({ ...options, args: ['--json', '--backfill'] });
  assert.equal(JSON.parse(fs.readFileSync(file)).items[0].submitter_discord_id, '715210673642012733');
  assert.equal(f.sent.length, 0);
  assert.equal(fs.existsSync(path.join(f.dir, 'feedback-progress-ledger.json')), false);
});
test('不明のsource画面名を人名にせずシートリンクと理由を返す', async (t) => {
  const f = fixture(t, { known: false });
  await runProgressNotify({ ...f.options, args: ['--json', '--dry-run'], loadSource: async () => ({
    sheetUrl: 'https://docs.google.com/spreadsheets/d/test/edit', items: [{ issue_url: issue.html_url, source: 'kim' }],
  }) });
  const row = f.output.at(-1).items[0];
  assert.equal(row.resolution, 'escalated');
  assert.match(row.content, /元シートの行を確認してください/);
  assert.match(row.content, /https:\/\/docs.google.com\/spreadsheets\/d\/test\/edit/);
});

test('部分人名・メール断片だけでは宛先を復元せず通常実行でもbackfillしない', async (t) => {
  for (const submitter of ['山田', 'yamada@example.com']) {
    const f = fixture(t, { known: false });
    const file = path.join(f.dir, 'feedback-issue-ledger.json');
    const before = fs.readFileSync(file, 'utf8');
    await runProgressNotify({ ...f.options,
      loadIssue: async () => ({ issue: { ...issue, body: `報告者: ${submitter}` }, prs: [] }),
      getMembers: async () => [{ id: '42', nick: '山田太郎', username: 'yamada' }],
    });
    assert.equal(f.output.at(-1).items[0].resolution, 'escalated');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});
test('通常通知の名前解決はresolvedになり、明示フラグなしでは台帳を保存しない', async (t) => {
  const f = fixture(t, { known: false });
  const file = path.join(f.dir, 'feedback-issue-ledger.json');
  const before = fs.readFileSync(file, 'utf8');
  await runProgressNotify({ ...f.options,
    loadIssue: async () => ({ issue: { ...issue, body: '報告者: 山田太郎' }, prs: [] }),
    getMembers: async () => [{ id: '42', nick: '山田太郎' }],
  });
  assert.equal(f.output.at(-1).items[0].resolution, 'resolved');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
test('kim は設定済みowner IDの別名として解決しKimiとは混同しない', async (t) => {
  const f = fixture(t, { known: false });
  await runProgressNotify({ ...f.options, args: ['--json', '--dry-run'],
    loadIssue: async () => ({ issue: { ...issue, body: '## 要望（kim / 2026-09-22、nishi の Claude Code セッションで受領）' }, prs: [] }),
    getMembers: async () => [{ id: '43', username: 'kimi_74244', global_name: 'Kimi' },
      { id: '715210673642012733', username: 'kimkon.', nick: '金功勇' }],
  });
  assert.equal(f.output.at(-1).items[0].resolution, 'owner_is_kim');
  assert.equal(f.output.at(-1).items[0].escalated, false);
});

const kim = '715210673642012733';
function reminderFixture(t, state = 'answered', extra = {}) {
  const f = fixture(t);
  const file = path.join(f.dir, 'feedback-progress-ledger.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, items: {
    'example/app#21': { lastState: state, notifiedAt: now.toISOString(), delivery: '42', ...extra },
  } }));
  f.options.loadIssue = async () => ({ issue: { ...issue, comments: state === 'answered'
    ? [{ ...question, html_url: `${issue.html_url}#issuecomment-123` }] : [] },
  prs: state.startsWith('pr_') ? [{ ...pr, statusCheckRollup: [{ conclusion: state === 'pr_blocked' ? 'FAILURE' : 'SUCCESS' }] }] : [] });
  f.at = (days, options = {}) => runProgressNotify({ ...f.options, ...options,
    io: { ...f.options.io, now: () => new Date(+now + days * 86400000) } });
  f.read = () => JSON.parse(fs.readFileSync(file)).items['example/app#21'];
  return { ...f, file };
}

test('旧台帳の3/7/14/28日境界と同日再実行、answeredはkimへ質問リンクを送る', async (t) => {
  const f = reminderFixture(t);
  for (const [days, count] of [[2.999, 0], [3, 1], [3, 1], [6.999, 1], [7, 3], [7, 3],
    [13.999, 3], [14, 5], [14, 5], [27.999, 5], [28, 7], [28, 7]]) {
    await f.at(days);
    assert.equal(f.sent.length, count, `day ${days}`);
  }
  assert.deepEqual(f.sent.map((dm) => dm.userId), [kim, kim, '42', kim, '42', kim, '42']);
  assert.match(f.sent[0].content, /あなたの回答待ちで 3 日/);
  assert.match(f.sent[0].content, /#issuecomment-123/);
  assert.match(f.sent[1].content, /遅れています/);
  for (const dm of f.sent.filter((dm) => dm.userId === '42')) assert.match(dm.content, /お待たせしています。まだ対応中です/);
  assert.equal(f.read().firstSeenAt, now.toISOString());
  assert.equal(f.read().notifiedAt, now.toISOString());
  assert.equal(f.read().reminderCount, 4);
});

test('全状態のkim督促、依頼主がkimなら7日目も1通だけ', async (t) => {
  for (const [state, pattern] of [['pr_open', /あなたの承認待ち/], ['pr_blocked', /自動修復が止まっています/], ['stalled', /状況を確認してください/]]) {
    const f = reminderFixture(t, state);
    await f.at(3);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].userId, kim);
    assert.match(f.sent[0].content, pattern);
    if (state.startsWith('pr_')) assert.ok(f.sent[0].content.includes(pr.url));
  }
  const f = reminderFixture(t, 'answered', { delivery: kim });
  fs.writeFileSync(path.join(f.dir, 'feedback-issue-ledger.json'), JSON.stringify({ items: [{ repo: 'example/app', number: 21, submitter_discord_id: kim }] }));
  await f.at(7);
  await f.at(7);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].userId, kim);
});

test('状態変更はfirstSeenAtと督促回数をリセットする', async (t) => {
  const f = reminderFixture(t);
  await f.at(3);
  await f.at(7, { loadIssue: async () => ({ issue, prs: [pr] }) });
  assert.equal(f.read().lastState, 'pr_open');
  assert.equal(f.read().firstSeenAt, new Date(+now + 7 * 86400000).toISOString());
  assert.equal(f.read().reminderCount, 0);
  assert.equal(f.read().remindedAt, null);
  assert.equal(f.read().reminderDeliveries, undefined);
});

test('督促dry-runは既存台帳もDMも変更しない', async (t) => {
  const f = reminderFixture(t);
  const before = fs.readFileSync(f.file, 'utf8');
  await f.at(7, { args: ['--dry-run', '--json'] });
  assert.equal(f.sent.length, 0);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(f.output.at(-1).items[0].reminder.recipientIds, [kim, '42']);
});

test('既定20通と指定上限は通常通知も集約1通も含む。保留分は台帳を進めない', async (t) => {
  for (const [limit, args] of [[20, ['--json']], [3, ['--json', '--max-reminders', '3']], [1, ['--json', '--max-reminders', '1']]]) {
    const f = fixture(t);
    const items = Array.from({ length: 25 }, (_, i) => ({ repo: 'example/app', number: i + 1, submitter_discord_id: '42' }));
    fs.writeFileSync(path.join(f.dir, 'feedback-issue-ledger.json'), JSON.stringify({ items }));
    await runProgressNotify({ ...f.options, args });
    assert.equal(f.sent.length, limit);
    assert.equal(f.sent.at(-1).userId, kim);
    assert.match(f.sent.at(-1).content, /通知上限/);
    const file = path.join(f.dir, 'feedback-progress-ledger.json');
    assert.equal(fs.existsSync(file) ? Object.keys(JSON.parse(fs.readFileSync(file)).items).length : 0, limit - 1);
  }
});

test('督促の片方が失敗しても同日に成功済み宛先へ重複送信しない', async (t) => {
  const f = reminderFixture(t);
  await f.at(7, { sendDm: async (dm) => {
    if (dm.userId === '42') throw new Error('failure');
    f.sent.push(dm);
  } });
  assert.equal(f.read().reminderCount, 0);
  await f.at(7);
  assert.deepEqual(f.sent.map((dm) => dm.userId), [kim, '42']);
  assert.equal(f.read().reminderCount, 1);
});

test('firstSeenAtを優先し、実行が遅れても過去の段階を連続送信しない', async (t) => {
  const f = reminderFixture(t, 'answered', { firstSeenAt: new Date(+now - 28 * 86400000).toISOString() });
  await f.at(0);
  await f.at(1);
  assert.equal(f.sent.length, 2);
  assert.equal(f.output[0].items[0].reminder.stage, 28);
});

test('督促上限による片方の保留は翌実行で残りだけ再試行する', async (t) => {
  const f = reminderFixture(t);
  fs.writeFileSync(path.join(f.dir, 'feedback-issue-ledger.json'), JSON.stringify({ items: [
    { repo: 'example/app', number: 21, submitter_discord_id: '42' },
    { repo: 'example/app', number: 22, submitter_discord_id: '42' },
  ] }));
  await f.at(7, { args: ['--json', '--max-reminders', '2'] });
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].userId, kim);
  assert.match(f.sent[1].content, /通知上限/);
  assert.equal(f.read().reminderCount, 0);
  await f.at(7);
  assert.equal(f.sent.length, 4);
  assert.equal(f.sent[2].userId, '42');
  assert.equal(f.read().reminderCount, 1);
  await f.at(7);
  assert.equal(f.sent.length, 4);
});

test('不正な上限値は送信も台帳更新もしない', async (t) => {
  for (const value of ['0', '-1', '1.5', 'bad', undefined]) {
    const f = reminderFixture(t);
    const before = fs.readFileSync(f.file, 'utf8');
    await f.at(7, { args: ['--json', '--max-reminders', ...(value === undefined ? [] : [value])] });
    assert.equal(f.output[0].ok, false);
    assert.equal(f.sent.length, 0);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  }
});
