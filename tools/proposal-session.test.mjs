import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { submitProposal, completeProposal, main } from './proposal-session.mjs';
import { runScout, proposeSavedEvaluations } from './model-scout.mjs';
import { proposeHumanActions } from './cost-improve-loop.mjs';

function fixture(t, label = 'kim-PC') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-session-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'proposals');
  const notifications = [], launches = [], logs = [];
  const options = { home, label: () => label, log: s => logs.push(s),
    launch: async (...args) => launches.push(args), notify: async text => { notifications.push(text); return { delivered: 'dm' }; } };
  return { home, dir, options, notifications, launches, logs };
}
function proposal(home, id = 'one') {
  return { id, title: `提案 ${id}`, source: 'test', evidence: ['評価合格'],
    proposal: { summary: '安価なモデルへ変更', changes: [{ file: 'tools/routing-table.json', before: '旧モデル', after: '新モデル' }], costImpact: { perMonthUsd: null, basis: '月間利用量未計測' }, risks: ['未評価タスクの品質'] },
    onApprove: { kind: 'codex-task', promptFile: path.join(home, '.claude', 'proposals', `${id}.codex.md`) }, onReject: '現行維持' };
}
const read = file => fs.readFileSync(file, 'utf8');
const data = file => JSON.parse(read(file));
const submit = (f, id) => submitProposal(proposal(f.home, id), { ...f.options, promptText: '実装してテストし PR を作成する' });

test('保存・全文を先頭登録・既存目的をbyte単位で保持・1行DM・既存VS Code起動', async t => {
  const f = fixture(t), handoff = path.join(f.home, '.claude', 'next-session.md');
  const original = '<!-- NEXT-SESSION v1 -->\r\n## 次の1目的\r\n別の仕事\r\n[FB:123] 残す\r\n';
  fs.mkdirSync(path.dirname(handoff)); fs.writeFileSync(handoff, original);
  assert.equal((await submit(f, 'one')).ok, true);
  assert.equal(data(path.join(f.dir, 'one.json')).status, 'pending');
  assert.ok(read(handoff).includes(read(path.join(f.dir, 'one.md'))));
  assert.ok(read(handoff).endsWith(original));
  assert.equal(f.notifications.length, 1); assert.equal(f.notifications[0].split('\n').length, 1);
  assert.match(f.notifications[0], /実装提案セッションを用意しました/);
  assert.deepEqual(f.launches[0][0], ['--target', 'vscode', '--prompt', '/session-start']);
  await submit(f, 'one');
  assert.equal(f.launches.length, 1); assert.equal(f.notifications.length, 1);
});

test('FIFO・後続は別タブを増やさない・却下理由保存・最後に元本文が復元', async t => {
  const f = fixture(t), handoff = path.join(f.home, '.claude', 'next-session.md');
  fs.mkdirSync(path.dirname(handoff)); fs.writeFileSync(handoff, '元の目的\n');
  await submit(f, 'z-first'); await submit(f, 'a-second');
  assert.match(read(handoff), /提案 z-first/); assert.doesNotMatch(read(handoff), /提案 a-second/);
  assert.equal(f.launches.length, 1);
  assert.equal(completeProposal('a-second', { ...f.options, decision: 'rejected', revision: 1 }).ok, false);
  assert.equal(completeProposal('z-first', { ...f.options, decision: 'rejected', reason: '見送り', revision: 1 }).ok, true);
  assert.equal(data(path.join(f.dir, 'done', 'z-first.json')).reason, '見送り');
  assert.match(read(handoff), /提案 a-second/);
  assert.equal(completeProposal('a-second', { ...f.options, decision: 'approved', revision: 1, pr: 'https://github.com/example/repo/pull/1' }).ok, true);
  assert.equal(read(handoff), '元の目的\n');
  assert.ok(fs.existsSync(path.join(f.dir, 'done', 'a-second.codex.md')));
  assert.ok((await submit(f, 'z-first')).skipped);
});

test('dry-run は保存・登録・起動・DMなし。stdoutの秘密をマスク', async t => {
  const f = fixture(t), p = proposal(f.home);
  p.evidence.push('api_key=topsecretvalue');
  const input = path.join(f.home, 'sample.json'); fs.writeFileSync(input, JSON.stringify(p));
  assert.equal(await main(['--dry-run', '--file', input], f.options), 0);
  assert.equal(fs.existsSync(path.join(f.home, '.claude')), false);
  assert.equal(f.launches.length + f.notifications.length, 0);
  assert.match(f.logs.join('\n'), /月額効果: 未算定/); assert.doesNotMatch(f.logs.join('\n'), /topsecretvalue/);
});

test('kim-PC以外では起動せず保存・登録のみ。無効IDを拒否', async t => {
  const f = fixture(t, 'worker-PC');
  await submit(f, 'one'); assert.equal(f.launches.length, 0);
  assert.equal((await submitProposal(proposal(f.home, '../escape'), f.options)).ok, false);
  assert.equal(fs.existsSync(path.join(f.home, '.claude', 'escape.json')), false);
});

test('通知失敗は成功扱いにせず保存した提案を再送、ロック競合も副作用なし', async t => {
  const f = fixture(t);
  const result = await submitProposal(proposal(f.home), { ...f.options, promptText: 'task', notify: async () => ({ delivered: false }) });
  assert.equal(result.ok, false);
  assert.ok(fs.existsSync(path.join(f.dir, 'one.md')));
  assert.equal((await submit(f, 'one')).ok, true);
  fs.writeFileSync(path.join(f.dir, '.queue.lock'), '{}');
  assert.equal((await submit(f, 'two')).ok, false);
  assert.equal(fs.existsSync(path.join(f.dir, 'two.json')), false);
});

test('cost-improve接続をモック。未処理へ追記・1日1件・承認版の変更を検出', async t => {
  const f = fixture(t), calls = [];
  const options = { home: f.home, now: new Date('2026-10-09T10:00:00Z'), submit: async (p, opts) => { calls.push(p); return submitProposal(p, { ...opts, ...f.options }); } };
  const action = { pc: 'kim-PC', kind: 'cost_spike', todoMessage: '既定モデルを再評価' };
  await proposeHumanActions([action], options);
  await proposeHumanActions([{ ...action, kind: 'budget_pace', todoMessage: '予算ペースの原因を修正' }], options);
  assert.equal(calls.length, 2);
  const id = calls[0].id, p = data(path.join(f.dir, `${id}.json`));
  assert.equal(p.proposal.changes.length, 2); assert.equal(p.revision, 2);
  assert.match(read(p.onApprove.promptFile), /予算ペースの原因を修正/);
  assert.equal(f.launches.length, 1); assert.equal(f.notifications.length, 1);
  assert.equal(completeProposal(id, { ...f.options, decision: 'rejected', revision: 1 }).ok, false);
  assert.equal(completeProposal(id, { ...f.options, decision: 'rejected', revision: 2 }).ok, true);
  assert.ok((await proposeHumanActions([action], options)).skipped);
  const next = await proposeHumanActions([action], { ...options, now: new Date('2026-10-10T10:00:00Z') });
  assert.equal(next.ok, true); assert.equal(f.launches.length, 2);
});

test('model-scout接続: eval未了は評価中、既知候補も完了後に提案、-3ptと単価条件', async t => {
  const f = fixture(t), calls = [];
  const baseline = { id: 'vendor/old', name: 'Old', created: 1, pricing: { prompt: '0.00001', completion: '0.00002' }, context_length: 1000, architecture: { modality: 'text->text' } };
  const candidate = { ...baseline, id: 'vendor/new', name: 'New', created: Date.parse('2026-10-09T00:00:00Z') / 1000, pricing: { prompt: '0.000001', completion: '0.000002' } };
  const routingFile = path.join(f.home, 'routing.json'), configFile = path.join(f.home, 'providers.json');
  fs.writeFileSync(routingFile, JSON.stringify({ categories: { summarize: { provider: 'openrouter', model: baseline.id, rate: 1 } } }));
  fs.writeFileSync(configFile, '[]');
  const options = { ...f.options, routingFile, configFile, now: new Date('2026-10-09T01:00:00Z'),
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [baseline, candidate] }) }),
    submit: async (p, opts) => { calls.push({ p, opts }); return { ok: true }; } };
  const first = await runScout(options);
  assert.equal(first.ok, true); assert.equal(calls.length, 0); assert.match(first.dm, /評価中。結果が出たら提案セッションを開きます/);
  const record = (pass, model = candidate.id) => ({ t: '2026-10-09T02:00:00Z', provider: 'openrouter', model,
    byCategory: { summarize: { n: 100, graded: 100, pass, rate: pass / 100, errors: 0, truncated: 0 } } });
  const results = path.join(f.home, '.claude', 'eval-results.jsonl');
  fs.writeFileSync(results, JSON.stringify(record(96)) + '\n');
  await runScout(options); assert.equal(calls.length, 0);
  fs.writeFileSync(results, JSON.stringify(record(97)) + '\n');
  const second = await runScout(options);
  assert.equal(second.candidates.length, 0); assert.equal(calls.length, 1);
  assert.match(calls[0].p.title, /summarize.*New/); assert.match(calls[0].opts.promptText, /llm-ask.mjs/);
  const before = read(results);
  await proposeSavedEvaluations({ ...options, home: f.home });
  assert.equal(calls.length, 2); assert.equal(read(results), before);
  fs.writeFileSync(results, JSON.stringify(record(100, 'vendor/unrelated')) + '\n');
  await runScout({ ...options, dryRun: true }); assert.equal(calls.length, 2);
});

test('cost-improve本体は登録失敗を保存し、次回は新規human項目がなくても再試行する', async t => {
  const f = fixture(t), claude = path.join(f.home, '.claude');
  fs.mkdirSync(claude);
  const action = { id: 'retry-human', pc: 'kim-PC', kind: 'cost_spike', todoMessage: '前回の提案を再試行' };
  fs.writeFileSync(path.join(claude, 'cost-improve-state.json'), JSON.stringify({ version: 1, actions: [], lastKpis: {}, proposalRetry: [action] }));
  const { main: costMain } = await import('./cost-improve-loop.mjs');
  const calls = [];
  const io = { now: new Date('2026-10-09T10:00:00Z'), noNotify: true, signals: {}, localState: {},
    readLedger: () => ({ codex: 1, groq: 1 }), fetchFleetSheetRows: async () => [{ pcName: 'PC-ok', reportedAt: '2026-10-09 18:00:00', delegRatio: '60%', claudeUsd: '1' }],
    sendHeartbeat: async () => ({ ok: true }), submitProposal: async p => { calls.push(p); return { ok: calls.length > 1 }; } };
  await costMain(['--home', f.home, '--no-notify', '--max-codex', '0'], io);
  assert.equal(data(path.join(claude, 'cost-improve-state.json')).proposalRetry.length, 1);
  await costMain(['--home', f.home, '--no-notify', '--max-codex', '0'], io);
  assert.equal(calls.length, 2); assert.match(calls[1].evidence[0], /前回の提案を再試行/);
  assert.deepEqual(data(path.join(claude, 'cost-improve-state.json')).proposalRetry, []);
});
