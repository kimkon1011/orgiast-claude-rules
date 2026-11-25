import vm from 'node:vm';

export function extractCode(text) {
  const source = String(text ?? '');
  const blocks = [];
  const fence = /```(?:javascript|js)?[ \t]*\r?\n([\s\S]*?)```/gi;
  for (const match of source.matchAll(fence)) blocks.push(match[1]);
  return blocks.length ? blocks.reduce((longest, block) => block.length > longest.length ? block : longest) : source;
}

function createContext() {
  const recordedDelays = [];
  const handles = new Map();
  let nextHandle = 1;
  const setTimeout = (callback, ms) => {
    recordedDelays.push(ms);
    const handle = nextHandle++;
    handles.set(handle, setImmediate(() => {
      if (!handles.has(handle)) return;
      handles.delete(handle);
      callback();
    }));
    return handle;
  };
  const clearTimeout = (handle) => {
    const immediate = handles.get(handle);
    if (immediate !== undefined) clearImmediate(immediate);
    handles.delete(handle);
  };
  // 組み込み(Promise/Object/Array...)はホストのものを渡さない。渡すと
  // `Promise.constructor("return process")()` でホストの process=fs/child_process に到達でき、
  // モデル出力から実マシンへ脱出できてしまう。vm コンテキストは自前の realm の組み込みを持つので不要。
  const ctx = vm.createContext({
    setTimeout, clearTimeout,
    console: { log() {}, error() {}, warn() {} }
  });
  return { ctx, recordedDelays };
}

function evaluate(code) {
  const { ctx, recordedDelays } = createContext();
  const exposed = `${code}\n;try{globalThis.retry=retry}catch(e){}`;
  vm.runInContext(exposed, ctx, { timeout: 2000 });
  return { retry: ctx.retry, recordedDelays };
}

const drain = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

// 読み込むだけで自分の retry を呼ぶ「デモ/テスト付き」の回答があり、その待機がこちらの計測に混ざる。
// 混ざった待機を数えて実装のバグとして報告すると真因を隠すので、自走そのものを検出して返す。
// 設問が「コードだけ返してください」なので、これ自体が回答の不備でもある。
async function selfExecuting(evaluated) {
  await drain();
  return evaluated.recordedDelays.length > 0;
}

async function retry3x100200(code) {
  const failed = evaluate(code);
  if (typeof failed.retry !== 'function') return { pass: false, detail: 'retry が定義されていない' };
  if (await selfExecuting(failed)) return { pass: false, detail: '読み込むだけで自走するテスト/デモコードを含む（設問は「コードだけ返してください」）' };
  let failedCalls = 0;
  const result = failed.retry(() => {
    failedCalls++;
    return Promise.reject(new Error('boom'));
  });
  if (!result || typeof result.then !== 'function') return { pass: false, detail: 'retry の戻り値が then-able ではない' };
  let resolved = false;
  try { await result; resolved = true; } catch {}
  if (resolved) return { pass: false, detail: '全失敗ケースで resolve した' };
  if (failedCalls !== 3) return { pass: false, detail: `fn の呼び出し回数が ${failedCalls}（期待3）` };
  if (JSON.stringify(failed.recordedDelays) !== '[100,200]') return { pass: false, detail: `待機が ${JSON.stringify(failed.recordedDelays)}（期待[100,200]）` };

  const succeeded = evaluate(code);
  if (typeof succeeded.retry !== 'function') return { pass: false, detail: 'retry が定義されていない' };
  let successCalls = 0;
  const successResult = succeeded.retry(() => {
    successCalls++;
    return successCalls === 3 ? Promise.resolve('ok') : Promise.reject(new Error('boom'));
  });
  if (!successResult || typeof successResult.then !== 'function') return { pass: false, detail: 'retry の戻り値が then-able ではない' };
  let value;
  try { value = await successResult; } catch { return { pass: false, detail: '3回目成功ケースで reject した' }; }
  if (value !== 'ok') return { pass: false, detail: `resolve 値が ${JSON.stringify(value)}（期待"ok"）` };
  if (successCalls !== 3) return { pass: false, detail: `fn の呼び出し回数が ${successCalls}（期待3）` };
  return { pass: true, detail: '全失敗・3回目成功の両ケースに合格' };
}

export const CHECKS = { 'retry-3x-100-200': retry3x100200 };

export async function runCheck(name, text) {
  const check = CHECKS[name];
  if (!check) return { pass: false, detail: `未知のcheck: ${name}` };
  let timer;
  try {
    return await Promise.race([
      check(extractCode(text)),
      new Promise((resolve) => { timer = globalThis.setTimeout(() => resolve({ pass: false, detail: '実行が5000msでタイムアウトした' }), 5000); })
    ]);
  } catch (error) {
    return { pass: false, detail: `実行エラー: ${String(error?.message || error).replace(/\s+/g, ' ')}` };
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}
