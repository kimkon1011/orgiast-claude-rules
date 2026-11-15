/**
 * self-verify-workflow.mjs
 *
 * X-0061: 自己検証AIコーディングワークフロー
 * パイプライン: Loop→Check→Graph→Gate→Recover→Observe
 *
 * 8つの無料OSSリポジトリ（Ralph/mini-swe-agent/promptfoo/Google ADK/
 * MS Agent Framework/Mastra/Temporal/Phoenix）を参考にした
 * 自己検証ワークフローエンジン。
 *
 * 使い方:
 *   import { WorkflowEngine, LoopPhase, CheckPhase, GatePhase, Observer } from './self-verify-workflow.mjs';
 *
 *   const wf = new WorkflowEngine({ id: 'test', phases: [...] });
 *   const result = await wf.run();
 *
 * コマンドライン:
 *   node tools/self-verify-workflow.mjs --config <json>  # 設定ファイルから実行
 *   node tools/self-verify-workflow.mjs --sample         # サンプル実行
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── 型定義（JSDoc） ───────────────────────────────────────────

/**
 * @typedef {Object} Assertion
 * @property {'contains'|'exact'|'regex'|'not_contains'|'custom'} type
 * @property {string} [expected] - 期待値（contains/exact/regex/not_contains）
 * @property {Function} [check] - カスタム検証関数 (result) => boolean
 * @property {string} [name] - アサーション名
 */

/**
 * @typedef {Object} GuardCondition
 * @property {string} name - ガード名
 * @property {Function} check - チェック関数 (context) => boolean
 * @property {string} [blockMessage] - ブロック時のメッセージ
 */

/**
 * @typedef {Object} WorkflowConfig
 * @property {string} id - ワークフローID
 * @property {number} [maxRetries=3] - 最大リトライ回数
 * @property {string} [checkpointPath] - チェックポイントファイルパス
 * @property {Phase[]} phases - フェーズ配列
 * @property {Object} [initialContext] - 初期コンテキスト
 */

/**
 * @typedef {Object} SpanRecord
 * @property {string} phase - フェーズ名
 * @property {string} status - started/completed/failed/skipped
 * @property {number} duration - 実行時間(ms)
 * @property {Object} [result] - 結果
 * @property {string} [error] - エラーメッセージ
 * @property {number} timestamp - タイムスタンプ
 */

// ─── チェックポイント管理 ──────────────────────────────────────

class CheckpointStore {
  /**
   * @param {string} [filePath] - チェックポイントファイルのパス
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { workflowId: null, completedPhases: [], context: {} };
  }

  /** チェックポイントを保存 */
  save(workflowId, phaseName, context) {
    this.data.workflowId = workflowId;
    if (!this.data.completedPhases.includes(phaseName)) {
      this.data.completedPhases.push(phaseName);
    }
    this.data.context = { ...this.data.context, ...context };
    this.data.updatedAt = Date.now();

    if (this.filePath) {
      try {
        const dir = dirname(this.filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
      } catch (err) {
        console.error(`[Checkpoint] 保存失敗: ${err.message}`);
      }
    }
    return this.data;
  }

  /** チェックポイントを復元 */
  restore(workflowId) {
    // ファイルパスなし → in-memory データで復元
    if (!this.filePath) {
      if (this.data.workflowId === workflowId) return this.data;
      return null;
    }
    if (!existsSync(this.filePath)) return null;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw);
      if (data.workflowId !== workflowId) return null;
      this.data = data;
      return data;
    } catch {
      return null;
    }
  }

  /** フェーズが完了済みか */
  isPhaseCompleted(phaseName) {
    return this.data.completedPhases.includes(phaseName);
  }

  /** チェックポイントを削除 */
  clear() {
    this.data = { workflowId: null, completedPhases: [], context: {} };
    if (this.filePath && existsSync(this.filePath)) {
      try { writeFileSync(this.filePath, '{}', 'utf-8'); } catch { /* ignore */ }
    }
  }
}

// ─── 各種フェーズ ──────────────────────────────────────────────

/**
 * フェーズ基底クラス
 */
class Phase {
  /**
   * @param {string} name - フェーズ名
   */
  constructor(name) {
    this.name = name;
  }

  /**
   * @param {Object} context - ワークフローコンテキスト
   * @returns {Promise<{passed: boolean, result: any}>}
   */
  async execute(context) {
    throw new Error('サブクラスで execute() を実装してください');
  }
}

/**
 * LoopPhase: 完了条件までタスクを反復実行（Ralph/mini-swe-agent パターン）
 *
 * Ralph: 強化学習ループで完了条件まで自動反復
 * mini-swe-agent: 最小コードのエージェントループ
 */
class LoopPhase extends Phase {
  /**
   * @param {string} name - フェーズ名
   * @param {Object} opts
   * @param {Function} opts.task - 非同期タスク関数 (context) => result
   * @param {Function} opts.completeIf - 完了条件 (result, context) => boolean
   * @param {Function} [opts.retryPrompt] - リトライ時のプロンプト生成 (error, result, context) => string
   * @param {Function} [opts.onRetry] - リトライ前のフック (attempt, error, context) => void
   * @param {number} [opts.maxRetries=3] - 最大試行回数
   */
  constructor(name, opts) {
    super(name);
    this.task = opts.task;
    this.completeIf = opts.completeIf;
    this.retryPrompt = opts.retryPrompt || ((err) => `リトライ: ${err.message}`);
    this.onRetry = opts.onRetry || (() => {});
    this.maxRetries = opts.maxRetries ?? 3;
  }

  async execute(context) {
    const errors = [];
    let lastResult = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        lastResult = await this.task(context);
      } catch (err) {
        errors.push(err.message);
        if (attempt < this.maxRetries) {
          this.onRetry(attempt, err, context);
          const prompt = this.retryPrompt(err, lastResult, context);
          context._lastRetryPrompt = prompt;
        }
        continue;
      }

      const complete = await Promise.resolve(this.completeIf(lastResult, context));
      if (complete) {
        return { passed: true, result: lastResult, attempts: attempt };
      }
      errors.push(`完了条件未達 (attempt ${attempt})`);
      if (attempt < this.maxRetries) {
        this.onRetry(attempt, null, context);
      }
    }

    return {
      passed: false,
      result: lastResult,
      errors,
      attempts: this.maxRetries,
    };
  }
}

/**
 * CheckPhase: アサーションで出力を検証（promptfoo パターン）
 *
 * promptfoo: アサーションベース検証（exact/contains/regex/LLM-judge）
 */
class CheckPhase extends Phase {
  /**
   * @param {string} name - フェーズ名
   * @param {Object} opts
   * @param {Assertion[]} opts.assertions - アサーション配列
   */
  constructor(name, opts) {
    super(name);
    this.assertions = opts.assertions || [];
  }

  async execute(context) {
    const target = context._checkTarget || context.result || '';
    const results = [];

    for (const assertion of this.assertions) {
      const aName = assertion.name || `${assertion.type}:${String(assertion.expected).slice(0, 30)}`;
      let passed = false;
      let detail = '';

      try {
        switch (assertion.type) {
          case 'contains':
            passed = String(target).includes(assertion.expected);
            detail = passed ? '含む' : `'${assertion.expected}' を含まない`;
            break;
          case 'exact':
            passed = String(target) === assertion.expected;
            detail = passed ? '一致' : `'${assertion.expected}' と不一致`;
            break;
          case 'regex': {
            const re = new RegExp(assertion.expected);
            passed = re.test(String(target));
            detail = passed ? 'マッチ' : `/${assertion.expected}/ にマッチしない`;
            break;
          }
          case 'not_contains':
            passed = !String(target).includes(assertion.expected);
            detail = passed ? '含まない' : `'${assertion.expected}' を含む（含まないはず）`;
            break;
          case 'custom':
            if (typeof assertion.check === 'function') {
              passed = await Promise.resolve(assertion.check(target, context));
              detail = passed ? 'カスタムOK' : 'カスタムチェック失敗';
            } else {
              detail = 'カスタムチェック関数なし';
            }
            break;
          default:
            detail = `不明なアサーション型: ${assertion.type}`;
        }
      } catch (err) {
        passed = false;
        detail = `エラー: ${err.message}`;
      }

      results.push({ name: aName, passed, detail, type: assertion.type });
    }

    const allPassed = results.every(r => r.passed);
    const failedAssertions = results.filter(r => !r.passed);

    return {
      passed: allPassed,
      result: {
        total: results.length,
        passed: results.filter(r => r.passed).length,
        failed: failedAssertions.length,
        assertions: results,
        failedAssertions,
      },
    };
  }
}

/**
 * GatePhase: ガード条件で進行をチェック（Mastra パターン）
 *
 * Mastra: LLM呼び出し前後のガードレール、実行前条件チェック
 */
class GatePhase extends Phase {
  /**
   * @param {string} name - フェーズ名
   * @param {Object} opts
   * @param {GuardCondition[]} opts.guards - ガード条件配列
   */
  constructor(name, opts) {
    super(name);
    this.guards = opts.guards || [];
  }

  async execute(context) {
    const results = [];

    for (const guard of this.guards) {
      let passed = false;
      let detail = '';

      try {
        passed = await Promise.resolve(guard.check(context));
        detail = passed ? '通過' : (guard.blockMessage || 'ブロック');
      } catch (err) {
        passed = false;
        detail = `エラー: ${err.message}`;
      }

      results.push({ name: guard.name, passed, detail });
    }

    const allPassed = results.every(r => r.passed);
    const blocked = results.filter(r => !r.passed);

    return {
      passed: allPassed,
      result: {
        total: results.length,
        passed: results.filter(r => r.passed).length,
        blocked: blocked.length,
        guards: results,
        blockedGuards: blocked,
      },
    };
  }
}

/**
 * Observer: フェーズ実行の記録（Phoenix パターン）
 *
 * Phoenix/Arize: OpenTelemetryトレーシング、LLM-as-Judge評価
 */
class Observer extends Phase {
  /**
   * @param {string} name - フェーズ名
   * @param {Object} opts
   * @param {Function} [opts.recordSpan] - スパン記録関数 (span) => void
   * @param {boolean} [opts.storeInMemory=true] - メモリ上に保存
   */
  constructor(name, opts = {}) {
    super(name);
    this.recordSpan = opts.recordSpan || (() => {});
    this.storeInMemory = opts.storeInMemory !== false;
    /** @type {SpanRecord[]} */
    this.spans = [];
  }

  async execute(context) {
    const currentSpan = context._currentSpan;
    if (!currentSpan) {
      return { passed: true, result: { message: '記録するスパンなし' } };
    }

    currentSpan.duration = Date.now() - currentSpan.timestamp;
    currentSpan.completedAt = Date.now();

    const span = { ...currentSpan };
    if (this.storeInMemory) {
      this.spans.push(span);
    }
    this.recordSpan(span);
    context._spans = context._spans || [];
    context._spans.push(span);

    return { passed: true, result: { span, totalSpans: this.spans.length } };
  }

  /** 全スパンを取得 */
  getSpans() {
    return [...this.spans];
  }

  /** スパンをクリア */
  clearSpans() {
    this.spans = [];
  }

  /** 統計情報を取得 */
  getStats() {
    if (this.spans.length === 0) return { total: 0, avgDuration: 0, failed: 0 };
    const durations = this.spans.map(s => s.duration || 0);
    return {
      total: this.spans.length,
      avgDuration: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      maxDuration: Math.max(...durations),
      minDuration: Math.min(...durations),
      failed: this.spans.filter(s => s.status === 'failed').length,
      byStatus: this.spans.reduce((acc, s) => {
        acc[s.status] = (acc[s.status] || 0) + 1;
        return acc;
      }, {}),
    };
  }
}

/**
 * GraphPhase: 依存関係に基づくステップ実行（Google ADK / MS Agent Framework パターン）
 *
 * Google ADK: グラフベースエージェントオーケストレーション
 * MS Agent Framework: マルチエージェント調整
 */
class GraphPhase extends Phase {
  /**
   * @param {string} name - フェーズ名
   * @param {Object} opts
   * @param {Array<{name: string, task: Function, dependsOn?: string[]}>} opts.steps - ステップ定義
   * @param {string} [opts.mode='sequential'] - sequential または parallel
   */
  constructor(name, opts) {
    super(name);
    this.steps = opts.steps || [];
    this.mode = opts.mode || 'sequential';
  }

  async execute(context) {
    const results = [];

    if (this.mode === 'parallel') {
      // 並列実行（依存関係なし）
      const promises = this.steps.map(async (step) => {
        try {
          const result = await step.task(context);
          return { name: step.name, passed: true, result };
        } catch (err) {
          return { name: step.name, passed: false, error: err.message };
        }
      });
      const stepResults = await Promise.all(promises);
      results.push(...stepResults);
    } else {
      // 順次実行（依存関係チェック付き）
      const completed = {};
      for (const step of this.steps) {
        // 依存関係チェック
        if (step.dependsOn) {
          for (const dep of step.dependsOn) {
            if (!completed[dep]) {
              results.push({
                name: step.name,
                passed: false,
                error: `依存未完了: ${dep}`,
              });
              continue;
            }
          }
        }
        try {
          const result = await step.task(context);
          results.push({ name: step.name, passed: true, result });
          completed[step.name] = result;
        } catch (err) {
          results.push({ name: step.name, passed: false, error: err.message });
        }
      }
    }

    const allPassed = results.every(r => r.passed);
    return { passed: allPassed, result: { steps: results } };
  }
}

// ─── ワークフローエンジン ──────────────────────────────────────

/**
 * WorkflowEngine: 自己検証ワークフロー全体の実行管理（Temporal パターン）
 *
 * Temporal: Durable Execution、チェックポイント保存/復元、クラッシュ耐性
 */
class WorkflowEngine {
  /**
   * @param {WorkflowConfig} config
   */
  constructor(config) {
    this.id = config.id;
    this.maxRetries = config.maxRetries ?? 3;
    this.phases = config.phases || [];
    this.context = config.initialContext || {};
    this.checkpointStore = config.checkpointPath
      ? new CheckpointStore(config.checkpointPath)
      : new CheckpointStore();
    this.observers = this.phases.filter(p => p instanceof Observer);
  }

  /** チェックポイントから復元して未完了フェーズを取得 */
  restoreCheckpoint() {
    const cp = this.checkpointStore.restore(this.id);
    if (!cp) return null;
    this.context = { ...this.context, ...cp.context };
    return this.phases.filter(p => !this.checkpointStore.isPhaseCompleted(p.name));
  }

  /** 全フェーズを実行 */
  async run() {
    const startTime = Date.now();
    const checkpoint = this.restoreCheckpoint();
    const phasesToRun = checkpoint || this.phases;

    if (checkpoint) {
      console.log(`[Workflow] チェックポイント復元: ${this.id}（残り ${phasesToRun.length} フェーズ）`);
    }

    for (const phase of phasesToRun) {
      // スパン記録の開始
      /** @type {SpanRecord} */
      const span = {
        phase: phase.name,
        status: 'started',
        duration: 0,
        timestamp: Date.now(),
      };
      this.context._currentSpan = span;

      console.log(`[Workflow] フェーズ実行: ${phase.name}`);

      try {
        const phaseResult = await phase.execute(this.context);

        span.status = phaseResult.passed ? 'completed' : 'failed';
        span.result = phaseResult.result;
        span.duration = Date.now() - span.timestamp;

        // 結果をコンテキストに伝播（次フェーズが参照可能に）
        if (phaseResult.result !== undefined) {
          this.context._checkTarget = typeof phaseResult.result === 'string'
            ? phaseResult.result
            : JSON.stringify(phaseResult.result);
        }

        // Observer フェーズでスパンを記録（Observer自体のスパンはスキップ）
        for (const obs of this.observers) {
          if (obs !== phase || !(phase instanceof Observer)) {
            await obs.execute(this.context);
          }
        }

        if (!phaseResult.passed) {
          console.error(`[Workflow] フェーズ失敗: ${phase.name}`);
          return {
            success: false,
            failedPhase: phase.name,
            phaseResult,
            totalDuration: Date.now() - startTime,
            spans: this.observers.flatMap(o => o.getSpans()),
          };
        }

        // チェックポイント保存
        this.checkpointStore.save(this.id, phase.name, this.context);

      } catch (err) {
        span.status = 'failed';
        span.error = err.message;
        span.duration = Date.now() - span.timestamp;

        console.error(`[Workflow] フェーズ例外: ${phase.name}: ${err.message}`);
        return {
          success: false,
          failedPhase: phase.name,
          error: err.message,
          totalDuration: Date.now() - startTime,
          spans: this.observers.flatMap(o => o.getSpans()),
        };
      }
    }

    // 成功時はチェックポイントをクリア
    this.checkpointStore.clear();

    const stats = this.observers.length > 0
      ? this.observers[0].getStats()
      : { total: this.phases.length };

    return {
      success: true,
      totalDuration: Date.now() - startTime,
      phasesCompleted: this.phases.length,
      stats,
      spans: this.observers.flatMap(o => o.getSpans()),
    };
  }
}

// ─── コマンドライン実行 ────────────────────────────────────────

async function runSample() {
  console.log('=== X-0061 自己検証ワークフロー サンプル実行 ===\n');

  const observer = new Observer('record', {
    recordSpan: (span) => {
      const statusIcon = span.status === 'completed' ? '✅' : span.status === 'failed' ? '❌' : '🔄';
      console.log(`  ${statusIcon} ${span.phase}: ${span.status} (${span.duration}ms)`);
    },
  });

  const workflow = new WorkflowEngine({
    id: 'sample-ui-verification',
    phases: [
      new LoopPhase('generate-code', {
        task: async (ctx) => {
          return `async function verifyBoothPage() {
  await page.goto('https://orgiast.jp/booth-design');
  await page.locator('.booth-gallery').waitFor();
  const title = await page.title();
  return title;
}`;
        },
        completeIf: (result) => {
          return String(result).includes('page.goto') && String(result).includes('page.locator');
        },
        maxRetries: 2,
      }),
      new CheckPhase('verify-syntax', {
        assertions: [
          { type: 'contains', expected: 'page.goto', name: 'goto を含む' },
          { type: 'contains', expected: 'page.locator', name: 'locator を含む' },
          { type: 'regex', expected: /page\.\w+\(/, name: 'page. メソッド呼出' },
        ],
      }),
      new GatePhase('guard-safety', {
        guards: [
          {
            name: 'code-size',
            check: (ctx) => String(ctx._checkTarget || ctx.result || '').length > 10,
            blockMessage: 'コードが短すぎる',
          },
        ],
      }),
      observer,
    ],
  });

  const result = await workflow.run();

  console.log(`\n=== 結果 ===`);
  console.log(`成功: ${result.success}`);
  console.log(`所要時間: ${result.totalDuration}ms`);
  if (result.success) {
    console.log(`完了フェーズ: ${result.phasesCompleted}`);
    console.log(`スパン統計:`, result.stats);
  } else {
    console.log(`失敗フェーズ: ${result.failedPhase}`);
  }

  return result;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--sample') || args.length === 0) {
    await runSample();
    return;
  }

  if (args.includes('--config') && args.includes('--')) {
    const configPath = args[args.indexOf('--config') + 1];
    if (!configPath || !existsSync(configPath)) {
      console.error(`設定ファイルが見つかりません: ${configPath}`);
      process.exit(1);
    }
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    // config から動的にフェーズを構築して実行（拡張用）
    console.log(`設定ファイルからワークフロー実行: ${configPath}`);
  }
}

// ─── エクスポート ──────────────────────────────────────────────

export {
  WorkflowEngine,
  LoopPhase,
  CheckPhase,
  GatePhase,
  GraphPhase,
  Observer,
  CheckpointStore,
};

// ─── 直接実行 ──────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(console.error);
}