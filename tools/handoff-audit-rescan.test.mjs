// 手渡し文言の再走査器を、実台帳に依存しない合成行で固定する。
// handoff-audit:2ddd67033c25e70a — 「再走査を実行する仕組みが動くか」を検証可能にする。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { matchHandoff, scanRows, summarize, scanFiles } from './handoff-audit-rescan.mjs';

const T0 = '2026-10-23T02:24:55.000Z';

test('手渡し文言を拾い、「次に kim がすること: なし」は拾わない', () => {
  assert.deepEqual(matchHandoff('次に kim がすること: なし'), []);
  assert.deepEqual(matchHandoff('このセッション: /session-close は不要なので、このセッションを閉じてよい'), []);
  const hits = matchHandoff('▶ 実行してください\nGAS の script.new に貼り付けてください');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].pattern, 'play-marker');
  assert.equal(hits[1].pattern, 'paste-request');
});

test('案件名・目的文に含まれる「1回実行」は命令ではないので拾わない', () => {
  // 2026-10-23T02:26Z の実台帳で実際に誤検出した行。
  assert.deepEqual(matchHandoff('**[本セッションの目的]** GAS 1回実行の手渡し再発検証（handoff-audit:2ddd67033c25e70a）を1イテレーション進める'), []);
  assert.deepEqual(matchHandoff('handoff-audit 2ddd67033c25e70a（GAS 1回実行の手渡し）の再発検証'), []);
  assert.equal(matchHandoff('script.new に貼り付けてください\n1回実行してください').length, 2);
});

test('台帳を走査した報告文（語彙の引用）は selfReport として手渡しと区別する', () => {
  const hits = matchHandoff('台帳を再走査した結果、手渡し文言「実行してください」の行は 0 件でした。');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].selfReport, true);
});

test('provider=null / regex-blocked は provider 付き verdict と数えない', () => {
  const rows = [
    { ts: T0, sessionId: 'a', fired: true, provider: null, latencyMs: 0, skipped: 'regex-blocked', verdict: 'pass', excerpt: '▶ 実行してください' },
    { ts: T0, sessionId: 'b', fired: true, provider: 'deepseek', latencyMs: 6200, verdict: 'block', excerpt: '1回実行してください' },
  ];
  const s = summarize([{ name: 'x', hits: scanRows(rows).hits }]);
  assert.equal(s.totals.handoffWording, 2);
  assert.equal(s.totals.handoffWordingWithProviderVerdict, 1);
  assert.equal(s.verdict, 'handoff-wording-judged-with-provider');
});

test('窓内に手渡し文言があるのに provider 判定が無ければ without-provider を返す', () => {
  const rows = [
    { ts: T0, sessionId: 'a', fired: true, provider: null, latencyMs: 0, skipped: 'regex-blocked', verdict: 'pass', excerpt: '▶ 実行してください' },
  ];
  const s = summarize([{ name: 'x', hits: scanRows(rows).hits }]);
  assert.equal(s.totals.handoffWordingWithProviderVerdict, 0);
  assert.equal(s.verdict, 'handoff-wording-without-provider');
});

test('provider 名はあるが verdict=audit-unavailable の行は判定済みに数えない', () => {
  // 2026-10-23T05:22:22Z / 05:43:41Z の実台帳行。deepseek に届かず判定は無い。
  const rows = [
    { ts: T0, sessionId: 'a', fired: true, provider: 'deepseek', latencyMs: 6000, verdict: 'audit-unavailable', error: 'timeout-or-provider-unavailable', excerpt: '▶ 実行してください' },
  ];
  const s = summarize([{ name: 'x', hits: scanRows(rows).hits }]);
  assert.equal(s.totals.handoffWordingWithProviderVerdict, 0);
  assert.equal(s.totals.handoffWordingProviderUnavailable, 1);
  assert.equal(s.verdict, 'handoff-wording-without-provider');
});

test('反実仮想ハーネスの cf-* 行は本番トラフィックとして数えず、除外数を出す', () => {
  // 2026-10-23T06:05Z に .loop/counterfactual-latest.mjs が本番台帳へ書いた 3 行。
  const rows = [
    { ts: T0, sessionId: 'cf-PRODUCTION', fired: true, provider: null, skipped: 'regex-blocked', verdict: 'pass', excerpt: '次に kim がすること: 支払う' },
    { ts: T0, sessionId: 'cf-FIXED', fired: true, provider: null, skipped: 'regex-blocked', verdict: 'pass', excerpt: '次に kim がすること: 支払う' },
    { ts: T0, sessionId: '2bb98fd7', fired: true, provider: null, skipped: 'regex-blocked', verdict: 'pass', excerpt: '次に kim がすること: 支払う' },
  ];
  const r = scanRows(rows);
  assert.equal(r.synthetic, 2);
  assert.equal(r.hits.length, 1);
  const s = summarize([{ name: 'x', ...r }]);
  assert.equal(s.totals.handoffWording, 1);
  assert.equal(s.totals.syntheticReplaysExcluded, 2);
  assert.equal(s.verdict, 'handoff-wording-without-provider');
});

test('runner 台帳で handoff-audit-gate が止めた行も判定済みとして数える', () => {
  const rows = [
    { ts: T0, sessionId: 'a', blockedBy: ['handoff-audit-gate'], demoted: [], verdict: 'block', excerpt: '▶ 実行してください' },
  ];
  const s = summarize([{ name: 'runner', hits: scanRows(rows).hits }]);
  assert.equal(s.totals.handoffWordingBlockedByHandoffAuditGate, 1);
  assert.equal(s.verdict, 'handoff-wording-judged-with-provider');
});

test('since/until の窓で行を絞る', () => {
  const rows = [
    { ts: '2026-10-23T02:00:00.000Z', excerpt: '▶ 実行してください' },
    { ts: '2026-10-23T02:26:00.000Z', excerpt: '▶ 実行してください' },
  ];
  const r = scanRows(rows, { since: T0, until: '2026-10-23T02:30:00.000Z' });
  assert.equal(r.inWindow, 1);
  assert.equal(r.hits.length, 1);
});

test('窓内ヒット 0 件なら no-handoff-wording-in-window', () => {
  const s = summarize([{ name: 'x', hits: [] }], { since: T0 });
  assert.equal(s.verdict, 'no-handoff-wording-in-window');
  assert.equal(s.totals.rowsMatched, 0);
});

test('存在しない台帳は missing として扱い落ちない', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rescan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'handoff-audit-ledger.jsonl'), JSON.stringify({ ts: T0, provider: 'deepseek', verdict: 'pass', excerpt: '次に kim がすること: なし' }) + '\n');
  const res = scanFiles(dir);
  assert.equal(res.find(r => r.name === 'handoff-audit-ledger.jsonl').inWindow, 1);
  assert.equal(res.find(r => r.name === 'handoff-audit-ledger.jsonl').hits.length, 0);
  assert.ok(res.some(r => r.missing));
});
