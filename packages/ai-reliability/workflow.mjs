/**
 * LangGraph-style Persistent Workflow Engine
 *
 * LangGraph の Checkpoint/State パターンを JavaScript で実装。
 * 各ステップは状態遷移を持ち、JSON チェックポイントで中断・再開が可能。
 * エラー時は指数バックオフ + 最大試行回数で自動回復する。
 *
 * @module workflow
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {'pending'|'running'|'passed'|'failed'|'retrying'|'escalated'} StepStatus
 * @typedef {'initial'|'generate'|'validate'|'evaluate'|'deploy_gate'|'done'|'error'} WorkflowPhase
 */

/**
 * @typedef {Object} StepResult
 * @property {StepStatus} status
 * @property {*} [output] - ステップの出力（次のステップに渡される）
 * @property {string} [error] - エラーメッセージ
 * @property {number} [retryCount]
 * @property {number} [nextRetryAt] - Date.now() の次のリトライ可能時刻
 */

/**
 * @typedef {Object} Checkpoint
 * @property {string} workflowId
 * @property {WorkflowPhase} phase
 * @property {Object<string, StepResult>} steps
 * @property {Object} context - ワークフロー間で共有されるコンテキスト
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * ワークフローの各ステップを定義する
 */
export class WorkflowStep {
  /**
   * @param {Object} config
   * @param {string} config.name - ステップ名
   * @param {WorkflowPhase} config.phase - 所属フェーズ
   * @param {(ctx: Object) => Promise<StepResult>} config.execute - 実行関数
   * @param {Object} [config.retry]
   * @param {number} [config.retry.maxAttempts=3]
   * @param {number} [config.retry.baseDelayMs=1000]
   * @param {number} [config.retry.maxDelayMs=30000]
   */
  constructor({ name, phase, execute, retry = {} }) {
    this.name = name;
    this.phase = phase;
    this.execute = execute;
    this.retry = {
      maxAttempts: retry.maxAttempts ?? 3,
      baseDelayMs: retry.baseDelayMs ?? 1000,
      maxDelayMs: retry.maxDelayMs ?? 30000,
    };
  }
}

/**
 * LangGraph パターンのワークフローエンジン
 */
export class Workflow {
  /**
   * @param {Object} config
   * @param {string} config.workflowId
   * @param {WorkflowStep[]} config.steps - 実行するステップ（順次実行）
   * @param {string} [config.checkpointDir] - チェックポイント保存先ディレクトリ
   * @param {(ctx: Object, step: WorkflowStep, result: StepResult) => void} [config.onStepComplete]
   * @param {(ctx: Object, step: WorkflowStep, error: Error) => void} [config.onEscalation]
   */
  constructor({ workflowId, steps, checkpointDir, onStepComplete, onEscalation }) {
    this.workflowId = workflowId;
    this.steps = steps;
    this.checkpointDir = checkpointDir ?? join(
      dirname(fileURLToPath(import.meta.url)), '.checkpoints'
    );
    this.onStepComplete = onStepComplete;
    this.onEscalation = onEscalation;
  }

  /**
   * チェックポイントを保存する
   * @param {Checkpoint} cp
   */
  async #saveCheckpoint(cp) {
    await mkdir(this.checkpointDir, { recursive: true });
    const filePath = join(this.checkpointDir, `${this.workflowId}.json`);
    await writeFile(filePath, JSON.stringify(cp, null, 2), 'utf-8');
  }

  /**
   * チェックポイントを復元する
   * @returns {Promise<Checkpoint|null>}
   */
  async #loadCheckpoint() {
    try {
      const filePath = join(this.checkpointDir, `${this.workflowId}.json`);
      const data = await readFile(filePath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * 指数バックオフでリトライする
   * @param {WorkflowStep} step
   * @param {Object} ctx
   * @returns {Promise<StepResult>}
   */
  async #executeWithRetry(step, ctx) {
    for (let attempt = 1; attempt <= step.retry.maxAttempts; attempt++) {
      try {
        const result = await step.execute(ctx);
        if (result.status === 'passed' || result.status === 'failed') {
          return { ...result, retryCount: attempt - 1 };
        }
        // pending / running はそのまま返す
        return { ...result, retryCount: attempt - 1 };
      } catch (err) {
        const isLastAttempt = attempt >= step.retry.maxAttempts;
        if (isLastAttempt) {
          return {
            status: 'escalated',
            error: `All ${step.retry.maxAttempts} attempts failed: ${err.message}`,
            retryCount: attempt - 1,
          };
        }
        // 指数バックオフ
        const delay = Math.min(
          step.retry.baseDelayMs * Math.pow(2, attempt - 1),
          step.retry.maxDelayMs
        );
        await sleep(delay);
      }
    }
    // 到達しない
    return { status: 'escalated', error: 'Unexpected retry exit', retryCount: step.retry.maxAttempts };
  }

  /**
   * ワークフローを実行する（中断から再開可能）
   * @param {Object} initialContext
   * @returns {Promise<{passed: boolean, checkpoint: Checkpoint}>}
   */
  async run(initialContext = {}) {
    // 既存のチェックポイントを復元
    const existing = await this.#loadCheckpoint();
    const cp = existing ?? {
      workflowId: this.workflowId,
      phase: 'initial',
      steps: Object.fromEntries(this.steps.map((s) => [s.name, { status: 'pending' }])),
      context: { ...initialContext },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 各ステップを順次実行
    for (const step of this.steps) {
      const previous = cp.steps[step.name];
      if (previous && (previous.status === 'passed' || previous.status === 'failed')) {
        continue; // 既に完了
      }

      cp.phase = step.phase;
      cp.steps[step.name] = { status: 'running' };
      await this.#saveCheckpoint(cp);

      const result = await this.#executeWithRetry(step, cp.context);

      cp.steps[step.name] = result;
      cp.updatedAt = Date.now();

      if (this.onStepComplete) {
        this.onStepComplete(cp.context, step, result);
      }

      if (result.status === 'escalated' && this.onEscalation) {
        this.onEscalation(cp.context, step, new Error(result.error));
      }

      // 不合格 or エスカレーション → 中断（チェックポイントは残す）
      if (result.status === 'failed' || result.status === 'escalated') {
        cp.phase = 'error';
        await this.#saveCheckpoint(cp);
        return { passed: false, checkpoint: cp };
      }

      // 成功時は context に結果をマージ
      if (result.output !== undefined) {
        cp.context[step.name] = result.output;
      }

      await this.#saveCheckpoint(cp);
    }

    cp.phase = 'done';
    await this.#saveCheckpoint(cp);
    return { passed: true, checkpoint: cp };
  }

  /**
   * チェックポイントをリセットする
   */
  async reset() {
    const cp = {
      workflowId: this.workflowId,
      phase: 'initial',
      steps: Object.fromEntries(this.steps.map((s) => [s.name, { status: 'pending' }])),
      context: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.#saveCheckpoint(cp);
    return cp;
  }
}