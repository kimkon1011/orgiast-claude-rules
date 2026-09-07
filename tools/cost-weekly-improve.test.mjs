import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseProposalsText, isAllowedWeeklyProvider, classifyWeeklyCommand, proposalMetric, proposalSignature, suppressNoEffectProposals, runWeekly } from './cost-weekly-improve.mjs';

function makeHome(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  return { home, claude };
}
const JSON_ONLY = (proposals) => JSON.stringify({ proposals });

test('提案JSONを fenced でもパースできる', () => {
  const parsed = parseProposalsText('```json\n' + JSON.stringify({ proposals: [{ id: 'a', title: 't', expectedSavingJpyPerMonth: 100, confidence: 'medium', action: { type: 'human' }, risk: '' }] }) + '\n```');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 'a');
  assert.equal(parsed[0].confidence, 'medium');
});

test('anthropic/claude は提案生成 provider に使えない', () => {
  assert.equal(isAllowedWeeklyProvider('deepseek'), true);
  assert.equal(isAllowedWeeklyProvider('gemini'), true);
  assert.equal(isAllowedWeeklyProvider('anthropic'), false);
  assert.equal(isAllowedWeeklyProvider('claude-opus-5'), false);
});

test('command 分類: 許可リスト固定/不正/許可外', () => {
  assert.equal(classifyWeeklyCommand(['node', 'tools', 'routing-table.mjs', '--rebuild']).ok, false); // パスが空(想定外)でも検出は「許可外」
  const allowed = classifyWeeklyCommand(['node', 'tools/routing-table.mjs', '--rebuild']);
  assert.equal(allowed.ok, true);
  const demote = classifyWeeklyCommand(['node', 'tools/routing-table.mjs', '--demote', 'groq']);
  assert.equal(demote.ok, true);
  assert.deepEqual(demote.parts, ['node', 'tools/routing-table.mjs', '--demote', 'groq', '--days', '3']);
  const nonArray = classifyWeeklyCommand('node tools/routing-table.mjs --rebuild');
  assert.equal(nonArray.reject, true);
  assert.equal(nonArray.ok, false);
  const outside = classifyWeeklyCommand(['node', 'tools/codex-do.mjs', '--dry-run']);
  assert.equal(outside.ok, false);
  assert.equal(outside.reject, false);
});

test('提案 metric 推定: 無人→headlessClaudeOut, 予算→pacePercent, 既定→delegRatio', () => {
  assert.equal(proposalMetric({ title: 'auto-session を cheap-code へ' }), 'headlessClaudeOut');
  assert.equal(proposalMetric({ rationale: '月次予算ペースを抑える' }), 'pacePercent');
  assert.equal(proposalMetric({ title: '委譲を促進' }), 'delegRatio');
});

test('許可リスト外 command は実行されず human に落ちる / 配列でない command は拒否', async () => {
  const { home, claude } = makeHome('orgiast-weekly-outside-');
  const applied = [];
  const result = await runWeekly({
    home, provider: 'deepseek', dryRun: false, noNotify: true,
    io: {
      budget: null,
      sendHeartbeat: async () => {},
      askImpl: async () => JSON_ONLY([
        { id: 'outside', title: '別ツールで改善', rationale: 'ルーティング改善', expectedSavingJpyPerMonth: 100, confidence: 'medium', action: { type: 'command', command: ['node', 'tools/codex-do.mjs', '--dry-run'], note: '' }, risk: '低' },
        { id: 'badcmd', title: '不正なcommand', rationale: 'x', expectedSavingJpyPerMonth: 0, confidence: 'low', action: { type: 'command', command: 'node tools/llm-ask.mjs --print-key-status', note: '' }, risk: '' },
        { id: 'human1', title: '人間判断', rationale: '契約見直し', expectedSavingJpyPerMonth: 3000, confidence: 'high', action: { type: 'human', note: '先方と交渉が必要' }, risk: '中' },
      ]),
      spawnImpl: (...args) => { applied.push(args); return { status: 0, stdout: 'ok' }; },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome.human, 2); // 許可外 + human
  assert.equal(result.outcome.rejected, 1); // 配列でない command
  assert.equal(result.outcome.applied, 0);
  const state = JSON.parse(fs.readFileSync(path.join(claude, 'cost-improve-state.json'), 'utf8'));
  const humans = state.actions.filter((a) => a.mode === 'human');
  assert.equal(humans.length, 2);
  assert.equal(humans[0].command[0], 'node'); // 許可外でも command を保持し --approve 可能
  assert.equal(applied.length, 0); // 一切 spawn していない
  assert.ok(state.actions.every((a) => a.id !== 'badcmd'), '不正command は記録されない');
});

test('許可済み command は自動適用され actions に auto-weekly で入る', async () => {
  const { home, claude } = makeHome('orgiast-weekly-auto-');
  const applied = [];
  const result = await runWeekly({
    home, provider: 'deepseek', dryRun: false, noNotify: true,
    io: {
      budget: null,
      sendHeartbeat: async () => {},
      askImpl: async () => JSON_ONLY([
        { id: 'route1', title: 'ルーティング表再生成', rationale: 'evalを最新化', expectedSavingJpyPerMonth: 500, confidence: 'high', action: { type: 'command', command: ['node', 'tools/routing-table.mjs', '--rebuild'], note: '' }, risk: '低' },
        { id: 'human1', title: 'プラン見直し', rationale: '定額プラン変更', expectedSavingJpyPerMonth: 2000, confidence: 'low', action: { type: 'human', note: '' }, risk: '高' },
      ]),
      spawnImpl: (program, args) => { applied.push([program, ...args]); return { status: 0, stdout: 'ok' }; },
    },
  });
  assert.equal(result.outcome.applied, 1);
  assert.equal(result.outcome.human, 1);
  assert.equal(applied.length, 1);
  assert.ok(applied[0].join(' ').includes('tools/routing-table.mjs') && applied[0].join(' ').includes('--rebuild'));
  const state = JSON.parse(fs.readFileSync(path.join(claude, 'cost-improve-state.json'), 'utf8'));
  const auto = state.actions.find((a) => a.id === 'route1');
  assert.equal(auto.mode, 'auto-weekly');
  assert.equal(auto.result, 'pending');
  assert.ok(auto.command.includes('tools/routing-table.mjs'));
  assert.equal(auto.baseline.metric, 'delegRatio');
});

test('4週間以内の no_effect 同種提案は抑止する', async () => {
  const { home } = makeHome('orgiast-weekly-suppress-');
  const claude = path.join(home, '.claude');
  const proposal = { id: 'again', title: 'auto-session を cheap-code に移管', rationale: '無人ジョブのClaude使用を減らす', expectedSavingJpyPerMonth: 1000, confidence: 'high', action: { type: 'command', command: ['node', 'tools/auto-session-executor.mjs', '--set', 'cheap-code', '--provider', 'deepseek'], note: '' }, risk: '' };
  const metric = proposalMetric(proposal);
  const signature = proposalSignature(proposal, metric);
  const prior = { id: 'prev', mode: 'auto-weekly', source: 'cost-weekly', result: 'no_effect', signature, verifiedAt: new Date(Date.now() - 86400000).toISOString() };
  fs.writeFileSync(path.join(claude, 'cost-improve-state.json'), JSON.stringify({ actions: [prior] }));
  const result = await runWeekly({
    home, provider: 'deepseek', dryRun: true, noNotify: true,
    io: { budget: null, askImpl: async () => JSON_ONLY([proposal]) },
  });
  assert.equal(result.outcome.proposals, 0, '4週間抑止が効いていない');
  assert.equal(suppressNoEffectProposals([proposal], [prior], new Date()).length, 0);
});

test('提案 metric delegRatio の baseline は委譲率の現在値を使う', async () => {
  const { home, claude } = makeHome('orgiast-weekly-baseline-');
  fs.writeFileSync(path.join(claude, 'cost-loop-state.json'), JSON.stringify({ nonClaudeDelegRatio: 0.42, history: [{ date: '2026-08-01', nonClaudeDelegRatio: 0.4 }] }));
  const result = await runWeekly({
    home, provider: 'deepseek', dryRun: true, noNotify: true,
    io: {
      budget: null,
      askImpl: async () => JSON_ONLY([
        { id: 'del', title: '委譲率を上げる', rationale: '実装をCodexへ', expectedSavingJpyPerMonth: 800, confidence: 'medium', action: { type: 'command', command: ['node', 'tools/routing-table.mjs', '--promote', 'groq'], note: '' }, risk: '低' },
      ]),
    },
  });
  // dry-run なので state は書かれない。outcome だけ確認。
  assert.equal(result.ok, true);
});
