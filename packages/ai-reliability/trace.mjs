/**
 * Observability Trace Layer
 *
 * Langfuse / Arize Phoenix 互換のトレースインターフェース。
 * 開発時はコンソール出力、本番はアダプター経由で外部転送。
 *
 * Usage:
 *   const tracer = new Tracer({ adapter: new ConsoleAdapter() });
 *   tracer.span('generate.code', async () => { ... });
 *
 * @module trace
 */

/**
 * @typedef {Object} TraceSpan
 * @property {string} traceId
 * @property {string} spanId
 * @property {string} [parentSpanId]
 * @property {string} name
 * @property {'ok'|'error'|'retry'} status
 * @property {number} duration
 * @property {Object} [input]
 * @property {Object} [output]
 * @property {Object} [attributes]
 * @property {string} [error]
 * @property {number} startedAt
 */

let spanCounter = 0;

/**
 * トレースアダプターのベースクラス
 */
export class TraceAdapter {
  /** @param {TraceSpan} span */
  async write(span) { throw new Error('not implemented'); }
  async flush() {} // バッファリング実装用
}

/**
 * コンソール出力アダプター（開発用）
 */
export class ConsoleAdapter extends TraceAdapter {
  async write(span) {
    const status = span.status === 'ok' ? '✅' : span.status === 'error' ? '❌' : '🔄';
    const duration = `${(span.duration).toFixed(0)}ms`;
    console.log(
      `[trace:${span.traceId}] ${status} ${span.name} ${duration}` +
      (span.parentSpanId ? ` (parent:${span.parentSpanId.slice(0, 8)})` : '') +
      (span.error ? ` ERROR: ${span.error}` : '')
    );
  }
}

/**
 * ファイル出力アダプター（チェックポイント用）
 */
export class FileTraceAdapter extends TraceAdapter {
  /** @param {string} filePath */
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.buffer = [];
  }

  async write(span) {
    this.buffer.push(span);
  }

  async flush() {
    if (this.buffer.length === 0) return;
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(this.filePath), { recursive: true });
    const existing = [];
    try {
      const { readFile } = await import('node:fs/promises');
      const data = await readFile(this.filePath, 'utf-8');
      existing.push(...JSON.parse(data));
    } catch { /* 新規作成 */ }
    const all = [...existing, ...this.buffer];
    await writeFile(this.filePath, JSON.stringify(all, null, 2), 'utf-8');
    this.buffer = [];
  }
}

/**
 * トレーサー
 */
export class Tracer {
  /**
   * @param {Object} config
   * @param {string} [config.traceId]
   * @param {TraceAdapter|TraceAdapter[]} [config.adapter]
   */
  constructor({ traceId, adapter } = {}) {
    this.traceId = traceId ?? `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.adapters = adapter ? (Array.isArray(adapter) ? adapter : [adapter]) : [new ConsoleAdapter()];
    this.spans = [];
  }

  /**
   * 子スパンIDを生成する
   * @param {string} [parentSpanId]
   * @returns {string}
   */
  #nextSpanId(parentSpanId) {
    spanCounter += 1;
    const id = `span_${Date.now().toString(36)}_${spanCounter}`;
    return id;
  }

  /**
   * スパンを開始して終了まで計測する
   * @param {string} name - スパン名
   * @param {() => Promise<T>} fn - 計測対象の非同期関数
   * @param {Object} [opts]
   * @param {string} [opts.parentSpanId]
   * @param {Object} [opts.input]
   * @param {Object} [opts.attributes]
   * @returns {Promise<{result: T, span: TraceSpan}>}
   * @template T
   */
  async span(name, fn, { parentSpanId, input, attributes } = {}) {
    const spanId = this.#nextSpanId(parentSpanId);
    const startedAt = Date.now();

    try {
      const result = await fn();
      const duration = Date.now() - startedAt;
      const span = {
        traceId: this.traceId,
        spanId,
        parentSpanId,
        name,
        status: 'ok',
        duration,
        input,
        output: result !== undefined ? result : undefined,
        attributes: { ...attributes, duration },
        startedAt,
      };
      this.spans.push(span);
      await Promise.all(this.adapters.map((a) => a.write(span)));
      return { result, span };
    } catch (err) {
      const duration = Date.now() - startedAt;
      const span = {
        traceId: this.traceId,
        spanId,
        parentSpanId,
        name,
        status: 'error',
        duration,
        input,
        attributes: { ...attributes, duration },
        error: err.message,
        startedAt,
      };
      this.spans.push(span);
      await Promise.all(this.adapters.map((a) => a.write(span)));
      throw err;
    }
  }

  /**
   * リトライスパンを記録する
   * @param {string} name
   * @param {Object} [opts]
   */
  async recordRetry(name, { parentSpanId, input, retryCount, error } = {}) {
    const spanId = this.#nextSpanId(parentSpanId);
    const span = {
      traceId: this.traceId,
      spanId,
      parentSpanId,
      name: `${name}:retry`,
      status: 'retry',
      duration: 0,
      input,
      attributes: { retryCount },
      error: error?.message ?? 'retry',
      startedAt: Date.now(),
    };
    this.spans.push(span);
    await Promise.all(this.adapters.map((a) => a.write(span)));
  }

  /**
   * バッファリングアダプターをフラッシュする
   */
  async flush() {
    await Promise.all(this.adapters.map((a) => a.flush()));
  }
}

export default { Tracer, ConsoleAdapter, FileTraceAdapter };