import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseArgs,
  generateReviewPrompt,
  getDryRunPlan,
  printReport,
} from './code-improve-plan.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

describe('parseArgs', () => {
  it('既定値を返す', () => {
    const args = parseArgs(['node', 'code-improve-plan.mjs']);
    assert.equal(args.maxTasks, 8);
    assert.equal(args.lane, 'codex');
    assert.equal(args.cwd, REPO_ROOT);
    assert.equal(args.planOnly, undefined);
    assert.equal(args.dryRun, undefined);
  });

  it('--plan-only をパース', () => {
    const args = parseArgs(['node', 'code-improve-plan.mjs', '--plan-only']);
    assert.equal(args.planOnly, true);
  });

  it('--dry-run をパース', () => {
    const args = parseArgs(['node', 'code-improve-plan.mjs', '--dry-run']);
    assert.equal(args.dryRun, true);
  });

  it('--max-tasks 5 をパース', () => {
    const args = parseArgs(['node', 'code-improve-plan.mjs', '--max-tasks', '5']);
    assert.equal(args.maxTasks, 5);
  });

  it('--lane gemini をパース', () => {
    const args = parseArgs(['node', 'code-improve-plan.mjs', '--lane', 'gemini']);
    assert.equal(args.lane, 'gemini');
  });

  it('--target ファイルパスをパース', () => {
    const args = parseArgs(['node', 'code-improve-plan.mjs', '--target', 'src/test.ts']);
    assert.equal(args.target, 'src/test.ts');
  });

  it('--diff テキストをパース', () => {
    const args = parseArgs(['node', 'code-improve-plan.mjs', '--diff', 'some diff text']);
    assert.equal(args.diff, 'some diff text');
  });

  it('--verify-only 計画ファイルをパース', () => {
    const args = parseArgs(['node', 'code-improve-plan.mjs', '--verify-only', 'plan.json']);
    assert.equal(args.verifyOnly, 'plan.json');
  });

  it('--cwd をパース', () => {
    const args = parseArgs(['node', 'code-improve-plan.mjs', '--cwd', '/tmp/test']);
    // Windows では path.resolve('/tmp/test') が 'c:\\tmp\\test' になる
    assert.ok(args.cwd.includes('tmp') && args.cwd.includes('test'));
  });
});

describe('generateReviewPrompt', () => {
  it('diffとstatを含むプロンプトを生成', () => {
    const prompt = generateReviewPrompt('+console.log("test")', '1 file changed', 3);
    assert.ok(prompt.includes('console.log("test")'));
    assert.ok(prompt.includes('1 file changed'));
    assert.ok(prompt.includes('最大3件'));
    assert.ok(prompt.includes('"planId"'));
    assert.ok(prompt.includes('"tasks"'));
  });

  it('最大タスク数が反映される', () => {
    const prompt5 = generateReviewPrompt('diff', 'stat', 5);
    assert.ok(prompt5.includes('最大5件'));
    const prompt10 = generateReviewPrompt('diff', 'stat', 10);
    assert.ok(prompt10.includes('最大10件'));
  });

  it('diffが8000字を超える場合は切り詰める', () => {
    const longDiff = 'a'.repeat(10000);
    const prompt = generateReviewPrompt(longDiff, 'stat', 3);
    // diffは8000字に切り詰められる
    assert.ok(prompt.length < 12000); // 8000 + プロンプト部分
  });
});

describe('getDryRunPlan', () => {
  it('有効な計画オブジェクトを返す', () => {
    const plan = getDryRunPlan();
    assert.ok(plan.planId);
    assert.ok(plan.planId.startsWith('improve-'));
    assert.ok(Array.isArray(plan.tasks));
    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].id, 'T1');
    assert.ok(plan.verification.length > 0);
    assert.ok(plan.cost.estimatedTokens >= 0);
  });
});

describe('printReport', () => {
  it('エラーなくレポートを出力する', (t) => {
    const plan = {
      planId: 'test-001',
      target: { files: ['test.ts'], diffSummary: 'test' },
      tasks: [{ id: 'T1', title: 'Test', file: 'test.ts', line: 1, description: 'desc', expectedChange: 'change', testRequired: false }],
      verification: ['check1'],
      cost: { estimatedTokens: 100, preferredLane: 'codex' },
    };
    const results = [{ id: 'T1', title: 'Test', file: 'test.ts', line: 1, description: 'desc', expectedChange: 'change', testRequired: false, status: 'done' }];
    const verification = {
      completionRate: 100,
      taskResults: results,
      verificationResults: [{ item: 'check1', passed: true, detail: 'OK' }],
      finalDiff: '',
      summary: '✅ 完了',
    };
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'code-improve-report-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const args = { cwd };

    // 標準出力をキャプチャ
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
    printReport(plan, results, verification, args);
    const report = JSON.parse(fs.readFileSync(path.join(cwd, '.steering', 'improve-report-test-001.json'), 'utf8'));
    assert.deepEqual(report.plan, plan);
    assert.deepEqual(report.results, results);
    assert.deepEqual(report.verification, verification);
    assert.ok(Number.isFinite(Date.parse(report.completedAt)));

    assert.ok(logs.some(l => l.includes('test-001')));
    assert.ok(logs.some(l => l.includes('✅')));
  });
});
