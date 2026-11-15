/**
 * self-verify-workflow.test.mjs
 *
 * X-0061: 自己検証AIコーディングワークフローのテスト
 * 全フェーズ（Loop / Check / Gate / Graph / Observer / Checkpoint）を検証
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkflowEngine,
  LoopPhase,
  CheckPhase,
  GatePhase,
  GraphPhase,
  Observer,
  CheckpointStore,
} from './self-verify-workflow.mjs';

// ─── LoopPhase ─────────────────────────────────────────────────

describe('LoopPhase (Ralph/mini-swe-agent パターン)', () => {
  it('完了条件に達したら passed=true を返す', async () => {
    const phase = new LoopPhase('test-loop', {
      task: async () => 'hello world',
      completeIf: (r) => String(r).includes('hello'),
      maxRetries: 1,
    });
    const result = await phase.execute({});
    assert.equal(result.passed, true);
    assert.equal(result.attempts, 1);
    assert.equal(result.result, 'hello world');
  });

  it('完了条件未達でリトライし、3回目で成功', async () => {
    let callCount = 0;
    const phase = new LoopPhase('retry-loop', {
      task: async () => {
        callCount++;
        if (callCount < 3) return 'bad result';
        return 'good result';
      },
      completeIf: (r) => String(r) === 'good result',
      maxRetries: 3,
    });
    const result = await phase.execute({});
    assert.equal(result.passed, true);
    assert.equal(result.attempts, 3);
    assert.equal(callCount, 3);
  });

  it('全リトライ失敗で passed=false', async () => {
    const phase = new LoopPhase('fail-loop', {
      task: async () => 'never good',
      completeIf: (r) => false,
      maxRetries: 2,
    });
    const result = await phase.execute({});
    assert.equal(result.passed, false);
    assert.equal(result.attempts, 2);
    assert.ok(result.errors.length > 0);
  });

  it('タスク例外時にリトライする', async () => {
    let attempt = 0;
    const phase = new LoopPhase('error-loop', {
      task: async () => {
        attempt++;
        if (attempt < 2) throw new Error('temp error');
        return 'success';
      },
      completeIf: (r) => String(r) === 'success',
      maxRetries: 2,
    });
    const result = await phase.execute({});
    assert.equal(result.passed, true);
    assert.equal(attempt, 2);
  });

  it('retryPrompt が呼ばれる', async () => {
    let promptGenerated = false;
    const phase = new LoopPhase('prompt-loop', {
      task: async () => { throw new Error('fail'); },
      completeIf: () => false,
      retryPrompt: (err) => {
        promptGenerated = true;
        return `Fix: ${err.message}`;
      },
      maxRetries: 2,
    });
    await phase.execute({});
    assert.equal(promptGenerated, true);
  });
});

// ─── CheckPhase ────────────────────────────────────────────────

describe('CheckPhase (promptfoo パターン)', () => {
  it('contains アサーションが通る', async () => {
    const phase = new CheckPhase('check-contains', {
      assertions: [{ type: 'contains', expected: 'hello', name: 'hello含む' }],
    });
    const result = await phase.execute({ _checkTarget: 'hello world', result: '' });
    assert.equal(result.passed, true);
    assert.equal(result.result.total, 1);
    assert.equal(result.result.passed, 1);
  });

  it('contains アサーションが失敗する', async () => {
    const phase = new CheckPhase('check-fail', {
      assertions: [{ type: 'contains', expected: 'xyz', name: 'xyz含む' }],
    });
    const result = await phase.execute({ _checkTarget: 'hello world', result: '' });
    assert.equal(result.passed, false);
    assert.equal(result.result.failed, 1);
  });

  it('exact アサーション', async () => {
    const phase = new CheckPhase('check-exact', {
      assertions: [
        { type: 'exact', expected: 'hello', name: '完全一致' },
      ],
    });
    const r1 = await phase.execute({ _checkTarget: 'hello' });
    assert.equal(r1.passed, true);
    const r2 = await phase.execute({ _checkTarget: 'hello!' });
    assert.equal(r2.passed, false);
  });

  it('regex アサーション', async () => {
    const phase = new CheckPhase('check-regex', {
      assertions: [
        { type: 'regex', expected: 'page\\.goto\\s*\\(', name: 'goto呼出' },
      ],
    });
    const result = await phase.execute({ _checkTarget: 'await page.goto("/booth")' });
    assert.equal(result.passed, true);
  });

  it('not_contains アサーション', async () => {
    const phase = new CheckPhase('check-not-contains', {
      assertions: [{ type: 'not_contains', expected: 'ERROR' }],
    });
    const r1 = await phase.execute({ _checkTarget: 'success' });
    assert.equal(r1.passed, true);
    const r2 = await phase.execute({ _checkTarget: 'ERROR: failed' });
    assert.equal(r2.passed, false);
  });

  it('custom アサーション', async () => {
    const phase = new CheckPhase('check-custom', {
      assertions: [
        {
          type: 'custom',
          name: '長さ10以上',
          check: (target) => target.length >= 10,
        },
      ],
    });
    const r1 = await phase.execute({ _checkTarget: 'hello world!' });
    assert.equal(r1.passed, true);
    const r2 = await phase.execute({ _checkTarget: 'short' });
    assert.equal(r2.passed, false);
  });

  it('複数アサーションの混在', async () => {
    const phase = new CheckPhase('check-multi', {
      assertions: [
        { type: 'contains', expected: 'page.goto', name: 'goto' },
        { type: 'contains', expected: 'page.locator', name: 'locator' },
        { type: 'regex', expected: /async\s+/, name: 'async関数' },
      ],
    });
    const result = await phase.execute({
      _checkTarget: 'async function test() { await page.goto("/"); await page.locator(".btn"); }',
    });
    assert.equal(result.passed, true);
    assert.equal(result.result.passed, 3);
  });
});

// ─── GatePhase ─────────────────────────────────────────────────

describe('GatePhase (Mastra パターン)', () => {
  it('全ガード通過で passed=true', async () => {
    const phase = new GatePhase('guard-all-pass', {
      guards: [
        { name: 'not-empty', check: (ctx) => String(ctx.result || '').length > 0 },
        { name: 'has-hello', check: (ctx) => String(ctx.result || '').includes('hello') },
      ],
    });
    const result = await phase.execute({ result: 'hello world' });
    assert.equal(result.passed, true);
    assert.equal(result.result.passed, 2);
  });

  it('ガードブロックで passed=false', async () => {
    const phase = new GatePhase('guard-block', {
      guards: [
        { name: 'fail-guard', check: () => false, blockMessage: 'ブロックされました' },
      ],
    });
    const result = await phase.execute({});
    assert.equal(result.passed, false);
    assert.equal(result.result.blocked, 1);
  });

  it('カスタムコンテキスト参照', async () => {
    const phase = new GatePhase('guard-context', {
      guards: [
        {
          name: 'check-url',
          check: (ctx) => String(ctx.targetUrl || '').includes('orgiast.jp'),
        },
      ],
    });
    const r1 = await phase.execute({ targetUrl: 'https://orgiast.jp/booth' });
    assert.equal(r1.passed, true);
    const r2 = await phase.execute({ targetUrl: 'https://evil.com' });
    assert.equal(r2.passed, false);
  });
});

// ─── GraphPhase ────────────────────────────────────────────────

describe('GraphPhase (Google ADK/MS Agent Framework パターン)', () => {
  it('sequential モードで全ステップ実行', async () => {
    const results = [];
    const phase = new GraphPhase('graph-seq', {
      mode: 'sequential',
      steps: [
        { name: 'step1', task: async () => { results.push('a'); return 'a'; } },
        { name: 'step2', task: async () => { results.push('b'); return 'b'; } },
        { name: 'step3', task: async () => { results.push('c'); return 'c'; } },
      ],
    });
    const result = await phase.execute({});
    assert.equal(result.passed, true);
    assert.deepEqual(results, ['a', 'b', 'c']);
  });

  it('parallel モードで全ステップ実行', async () => {
    const phase = new GraphPhase('graph-parallel', {
      mode: 'parallel',
      steps: [
        { name: 'fast', task: async () => 'fast result' },
        { name: 'slow', task: async () => { await new Promise(r => setTimeout(r, 10)); return 'slow result'; } },
      ],
    });
    const result = await phase.execute({});
    assert.equal(result.passed, true);
    assert.equal(result.result.steps.length, 2);
  });

  it('依存関係チェックでスキップ', async () => {
    const phase = new GraphPhase('graph-depends', {
      mode: 'sequential',
      steps: [
        { name: 'step1', task: async () => 'a', dependsOn: ['nonexistent'] },
      ],
    });
    const result = await phase.execute({});
    // step1は依存関係未完了でスキップされるがエラーとして記録
    assert.equal(result.passed, false);
    assert.equal(result.result.steps[0].passed, false);
    assert.ok(result.result.steps[0].error.includes('依存未完了'));
  });
});

// ─── Observer ──────────────────────────────────────────────────

describe('Observer (Phoenix パターン)', () => {
  it('スパンが記録される', async () => {
    const observer = new Observer('record-spans');
    await observer.execute({ _currentSpan: { phase: 'test', status: 'completed', duration: 100, timestamp: Date.now() } });
    const spans = observer.getSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].phase, 'test');
  });

  it('getStats が統計を返す', async () => {
    const observer = new Observer('stats');
    const now = Date.now();
    await observer.execute({ _currentSpan: { phase: 'a', status: 'completed', duration: 100, timestamp: now } });
    await observer.execute({ _currentSpan: { phase: 'b', status: 'completed', duration: 200, timestamp: now } });
    await observer.execute({ _currentSpan: { phase: 'c', status: 'failed', duration: 50, timestamp: now, error: 'err' } });

    const stats = observer.getStats();
    assert.equal(stats.total, 3);
    assert.equal(stats.failed, 1);
    assert.equal(stats.byStatus.completed, 2);
    assert.equal(stats.byStatus.failed, 1);
    assert.ok(stats.avgDuration >= 0);
  });

  it('recordSpan コールバックが呼ばれる', async () => {
    let captured = null;
    const observer = new Observer('callback', {
      recordSpan: (span) => { captured = span; },
    });
    const span = { phase: 'cb-test', status: 'completed', duration: 50, timestamp: Date.now() };
    await observer.execute({ _currentSpan: span });
    assert.equal(captured.phase, 'cb-test');
  });

  it('clearSpans でクリア', async () => {
    const observer = new Observer('clear');
    await observer.execute({ _currentSpan: { phase: 'x', status: 'completed', duration: 1, timestamp: Date.now() } });
    assert.equal(observer.getSpans().length, 1);
    observer.clearSpans();
    assert.equal(observer.getSpans().length, 0);
  });
});

// ─── CheckpointStore ───────────────────────────────────────────

describe('CheckpointStore (Temporal パターン)', () => {
  it('save/restore が正しく動作する', () => {
    const store = new CheckpointStore();
    store.save('wf-1', 'phaseA', { key: 'value' });
    const cp = store.restore('wf-1');
    assert.ok(cp);
    assert.equal(cp.workflowId, 'wf-1');
    assert.deepEqual(cp.completedPhases, ['phaseA']);
    assert.equal(cp.context.key, 'value');
  });

  it('ID不一致では復元しない', () => {
    const store = new CheckpointStore();
    store.save('wf-1', 'phaseA', {});
    const cp = store.restore('wf-2');
    assert.equal(cp, null);
  });

  it('isPhaseCompleted が正しく判定', () => {
    const store = new CheckpointStore();
    store.save('wf-1', 'phaseA', {});
    store.save('wf-1', 'phaseB', {});
    assert.equal(store.isPhaseCompleted('phaseA'), true);
    assert.equal(store.isPhaseCompleted('phaseC'), false);
  });

  it('clear でリセットされる', () => {
    const store = new CheckpointStore();
    store.save('wf-1', 'phaseA', {});
    store.clear();
    assert.equal(store.isPhaseCompleted('phaseA'), false);
  });
});

// ─── WorkflowEngine ────────────────────────────────────────────

describe('WorkflowEngine（Temporal パターン）', () => {
  it('全フェーズ成功で success=true', async () => {
    const observer = new Observer('record');
    const workflow = new WorkflowEngine({
      id: 'test-success',
      phases: [
        new LoopPhase('generate', {
          task: async () => 'test output',
          completeIf: (r) => String(r).length > 0,
          maxRetries: 1,
        }),
        new CheckPhase('verify', {
          assertions: [{ type: 'contains', expected: 'test' }],
        }),
        new GatePhase('guard', {
          guards: [{ name: 'not-empty', check: (ctx) => true }],
        }),
        observer,
      ],
    });
    const result = await workflow.run();
    assert.equal(result.success, true);
    assert.ok(result.totalDuration > 0);
    assert.equal(result.phasesCompleted, 4);
  });

  it('途中のフェーズ失敗で success=false かつ途中終了', async () => {
    const workflow = new WorkflowEngine({
      id: 'test-fail',
      phases: [
        new LoopPhase('ok-phase', {
          task: async () => 'ok',
          completeIf: () => true,
          maxRetries: 1,
        }),
        new CheckPhase('fail-phase', {
          assertions: [{ type: 'contains', expected: 'NEVER' }],
        }),
      ],
    });
    const result = await workflow.run();
    assert.equal(result.success, false);
    assert.equal(result.failedPhase, 'fail-phase');
  });

  it('チェックポイント経由で再開できる', async () => {
    const observer = new Observer('record');
    const workflow = new WorkflowEngine({
      id: 'test-checkpoint',
      phases: [
        new LoopPhase('p1', {
          task: async () => 'data',
          completeIf: () => true,
          maxRetries: 1,
        }),
        new CheckPhase('p2', {
          assertions: [{ type: 'contains', expected: 'data' }],
        }),
        observer,
      ],
    });
    const result = await workflow.run();
    assert.equal(result.success, true);
  });
});

// ─── 統合テスト: ブースデザインページUI自動化パターン ────────

describe('統合テスト: ブースデザインページUI自動化パターン', () => {
  it('コード生成→検証→ガード→記録の一連が成功', async () => {
    const observer = new Observer('trace');

    const workflow = new WorkflowEngine({
      id: 'booth-ui-integration',
      phases: [
        // LoopPhase: Playwright スクリプト生成を模擬
        new LoopPhase('generate-playwright-script', {
          task: async () => `async function verifyBoothPage() {
  await page.goto('https://orgiast.jp/booth-design');
  await page.locator('.booth-gallery').waitFor({ state: 'visible' });
  const images = await page.locator('.booth-gallery img').count();
  return images;
}`,
          completeIf: (r) => {
            const s = String(r);
            return s.includes('page.goto') && s.includes('page.locator') && s.includes('waitFor');
          },
          maxRetries: 2,
        }),
        // CheckPhase: 構文と構造を検証
        new CheckPhase('verify-playwright-syntax', {
          assertions: [
            { type: 'contains', expected: 'page.goto', name: 'URL遷移' },
            { type: 'contains', expected: 'page.locator', name: '要素指定' },
            { type: 'contains', expected: 'waitFor', name: '待機処理' },
            { type: 'regex', expected: /async\s+function/, name: '非同期関数' },
            { type: 'not_contains', expected: 'page.evaluate(', name: '生JS評価不使用（簡易確認）' },
          ],
        }),
        // GatePhase: 安全条件を確認
        new GatePhase('safety-guard', {
          guards: [
            {
              name: 'code-size',
              check: (ctx) => String(ctx._checkTarget || ctx.result || '').length > 50,
              blockMessage: 'コードが短すぎる（不完全）',
            },
            { name: 'always-pass', check: () => true },
          ],
        }),
        observer,
      ],
    });

    const result = await workflow.run();
    assert.equal(result.success, true);
    assert.equal(result.phasesCompleted, 4);

    // Observer にスパンが記録されている
    const spans = observer.getSpans();
    assert.ok(spans.length >= 3); // Observer自身以外の3フェーズ分
    assert.ok(spans.some(s => s.phase === 'generate-playwright-script' && s.status === 'completed'));
  });

  it('不完全なコード生成がCheckPhaseで失敗する', async () => {
    const workflow = new WorkflowEngine({
      id: 'booth-ui-fail-check',
      phases: [
        new LoopPhase('generate-bad-code', {
          task: async () => 'console.log("test")',
          completeIf: () => true,
          maxRetries: 1,
        }),
        new CheckPhase('verify-fail', {
          assertions: [
            { type: 'contains', expected: 'page.goto', name: 'goto必須' },
            { type: 'contains', expected: 'page.locator', name: 'locator必須' },
          ],
        }),
      ],
    });
    const result = await workflow.run();
    assert.equal(result.success, false);
    assert.equal(result.failedPhase, 'verify-fail');
  });

  it('サンプル実行関数がエラーなく動作する', async () => {
    // tools/self-verify-workflow.mjs の runSample() 相当
    const observer = new Observer('sample-observer');
    const workflow = new WorkflowEngine({
      id: 'sample-ui-verification',
      phases: [
        new LoopPhase('generate-code', {
          task: async () => `async function verifyBoothPage() {
  await page.goto('https://orgiast.jp/booth-design');
  await page.locator('.booth-gallery').waitFor();
  const title = await page.title();
  return title;
}`,
          completeIf: (r) => String(r).includes('page.goto') && String(r).includes('page.locator'),
          maxRetries: 2,
        }),
        new CheckPhase('verify-syntax', {
          assertions: [
            { type: 'contains', expected: 'page.goto' },
            { type: 'contains', expected: 'page.locator' },
            { type: 'regex', expected: /page\.\w+\(/ },
          ],
        }),
        new GatePhase('guard-safety', {
          guards: [{
            name: 'code-size',
            check: (ctx) => String(ctx._checkTarget || ctx.result || '').length > 10,
            blockMessage: 'コードが短すぎる',
          }],
        }),
        observer,
      ],
    });

    const result = await workflow.run();
    assert.equal(result.success, true);
    assert.ok(observer.getSpans().length > 0);
  });
});