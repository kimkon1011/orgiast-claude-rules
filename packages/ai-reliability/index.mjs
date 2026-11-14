/**
 * @orgiast/ai-reliability
 *
 * AI コード生成の信頼性保証システム。
 * LangGraph パターンの永続ワークフロー + 多段評価チェーン + 観測可能性。
 *
 * Usage:
 *   import { createReliabilityPipeline } from '@orgiast/ai-reliability';
 *   const pipeline = createReliabilityPipeline({ workflowId: 'site-gen-001' });
 *   const result = await pipeline.run({
 *     generate: async (ctx) => { /* AI呼び出し *\/ },
 *     files: { 'index.html': '<html>...</html>' },
 *   });
 *
 * @module index
 */

import { Workflow, WorkflowStep } from './workflow.mjs';
import { EvalChain, EvalStep, htmlValidator, cssValidator } from './eval-chain.mjs';
import { staticAnalyze, validateSyntax, accessibilityScore } from './code-validator.mjs';
import { Tracer, ConsoleAdapter, FileTraceAdapter, TraceAdapter } from './trace.mjs';

export { Workflow, WorkflowStep, EvalChain, EvalStep, htmlValidator, cssValidator, staticAnalyze, validateSyntax, accessibilityScore, Tracer, ConsoleAdapter, FileTraceAdapter, TraceAdapter };

/**
 * 完全な信頼性パイプラインを構築する
 *
 * @param {Object} config
 * @param {string} config.workflowId
 * @param {Object} [config.tracer]
 * @param {EvalChain} [config.evalChain]
 * @param {string} [config.checkpointDir]
 * @returns {Object} { run, workflow, evalChain }
 */
export function createReliabilityPipeline(config = {}) {
  const {
    workflowId = `pipeline_${Date.now()}`,
    tracer = new Tracer({ traceId: workflowId }),
    evalChain = new EvalChain({
      evaluators: [htmlValidator, cssValidator],
    }),
    checkpointDir,
  } = config;

  const workflow = new Workflow({
    workflowId,
    steps: [
      new WorkflowStep({
        name: 'generate',
        phase: 'generate',
        execute: async (ctx) => {
          if (!ctx.generateFn) return { status: 'failed', error: 'generateFn not provided' };
          const { result } = await tracer.span('generate', () => ctx.generateFn(ctx), {
            input: { prompt: ctx.prompt },
          });
          ctx.generatedFiles = result;
          return { status: 'passed', output: result };
        },
        retry: { maxAttempts: 3, baseDelayMs: 2000 },
      }),
      new WorkflowStep({
        name: 'validate',
        phase: 'validate',
        execute: async (ctx) => {
          const files = ctx.generatedFiles ?? {};
          const { result } = await tracer.span('validate', () => {
            const analysis = staticAnalyze(files);
            return analysis;
          }, { input: { fileCount: Object.keys(files).length } });
          ctx.validationResult = result;
          if (!result.passed) {
            return {
              status: 'failed',
              output: result,
              error: `静的解析: ${result.errors.length} エラー`,
            };
          }
          return { status: 'passed', output: result };
        },
        retry: { maxAttempts: 1 },
      }),
      new WorkflowStep({
        name: 'evaluate',
        phase: 'evaluate',
        execute: async (ctx) => {
          const files = ctx.generatedFiles ?? {};
          const { result } = await tracer.span('evaluate', () =>
            evalChain.evaluate({ files, context: ctx }),
            { input: { fileCount: Object.keys(files).length } }
          );
          ctx.evalResult = result;
          if (!result.passed) {
            return {
              status: 'failed',
              output: result,
              error: `評価不合格: ${result.failedItems.join(', ')}`,
            };
          }
          return { status: 'passed', output: result };
        },
        retry: { maxAttempts: 2, baseDelayMs: 1000 },
      }),
      new WorkflowStep({
        name: 'deploy_gate',
        phase: 'deploy_gate',
        execute: async (ctx) => {
          const { result } = await tracer.span('deploy_gate', async () => {
            const validationOk = ctx.validationResult?.passed ?? false;
            const evalOk = ctx.evalResult?.passed ?? false;
            if (!validationOk || !evalOk) {
              return {
                status: 'escalated',
                error: `品質閾値未達: validate=${validationOk}, evaluate=${evalOk}`,
              };
            }
            return { status: 'passed', output: { validated: true } };
          });
          if (result.status === 'escalated') return result;
          return { status: 'passed', output: result.output };
        },
        retry: { maxAttempts: 1 },
      }),
    ],
    checkpointDir,
    onEscalation: (ctx, step, error) => {
      console.error(`[ESCALATION] ${step.name}: ${error.message}`);
    },
  });

  return {
    workflow,
    evalChain,
    tracer,
    /**
     * パイプラインを実行する
     * @param {Object} input
     * @param {(ctx: Object) => Promise<Object<string,string>>} input.generateFn - コード生成関数
     * @param {string} [input.prompt] - 生成プロンプト（トレース用）
     * @returns {Promise<{passed: boolean, checkpoint: Object, reports: Object}>}
     */
    async run({ generateFn, prompt } = {}) {
      const result = await workflow.run({
        generateFn,
        prompt: prompt ?? '',
        generatedFiles: {},
        validationResult: null,
        evalResult: null,
      });
      await tracer.flush();
      return {
        passed: result.passed,
        checkpoint: result.checkpoint,
        reports: {
          validation: result.checkpoint.context.validationResult,
          evaluation: result.checkpoint.context.evalResult,
        },
      };
    },
  };
}